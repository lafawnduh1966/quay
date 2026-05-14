// Linear ticket-state writeback wired into the existing tick / claims /
// cancel emitters. These tests pin the four mapped transitions, the no-op
// on PR-driven events, the idempotent-skip semantics, and the best-effort
// behaviour on adapter failures.
//
// The Linear adapter is exercised via the FakeLinearAdapter built into the
// test harness; assertions read `setIssueStateCalls` to observe the
// writebacks (or their deliberate absence).

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import {
  claim_task,
  escalate_human,
  record_human_reply,
} from "../../src/core/claims.ts";
import { resetLinearSyncWarnings } from "../../src/core/linear_state_sync.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertRunningTask,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
  // The warn-dedup memo is module-level (per-process). Clear it between
  // tests so a failure-triggering case doesn't silently swallow a future
  // case in this file (or another) that happens to use the same
  // identifier + state.
  resetLinearSyncWarnings();
});

// Helpers ---------------------------------------------------------------

function setExternalRef(harness: Harness, taskId: string, ref: string | null) {
  harness.db
    .query(`UPDATE tasks SET external_ref = ? WHERE task_id = ?`)
    .run(ref, taskId);
}

function setSlackThread(harness: Harness, taskId: string, threadRef: string) {
  harness.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run(threadRef, taskId);
}

// Tests -----------------------------------------------------------------

test("test_linear_sync_spawn_writes_in_progress", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-spawn");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-spawn",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-100");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);

  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "ENG-100", stateName: "In Progress" },
  ]);
});

test("test_linear_sync_escalate_human_writes_waiting", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-escalate");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-escalate",
    repoId,
    state: "awaiting-next-brief",
  });
  setExternalRef(h, taskId, "ITRY-42");
  setSlackThread(h, taskId, "C123:0.42");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T08:00:00.000Z",
  });

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("12345678");
  const esc = await escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
      linear: built.linear,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "need a human's answer?",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "ITRY-42", stateName: "Waiting" },
  ]);
});

test("test_linear_sync_record_human_reply_writes_in_progress", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-reply");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-reply",
    repoId,
    state: "awaiting-next-brief",
  });
  const threadRef = "Cabc:1.0";
  setExternalRef(h, taskId, "ENG-200");
  setSlackThread(h, taskId, threadRef);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T08:00:00.000Z",
  });

  // Drive into waiting_human via escalate_human, then reset the call log so
  // the reply-recording path is the only thing this assertion sees.
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("abcdef12");
  const esc = await escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
      linear: built.linear,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "ping me",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  built.linear.resetSetIssueStateCalls();
  const reply = await record_human_reply(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      linear: built.linear,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      replyBody: "all good, proceed",
      threadRef,
      messageTs: "1.00000002",
      author: "U123",
    },
  );
  if (!reply.ok) throw new Error("expected reply record");

  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "ENG-200", stateName: "In Progress" },
  ]);
});

test("test_linear_sync_cancel_writes_canceled", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-cancel");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-cancel",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-300");
  insertAttempt(h.db, { taskId, attemptNumber: 1 });

  const result = await cancel_task(built.deps, { taskId });
  if (!result.ok) throw new Error("expected cancel ok");

  expect(
    built.linear.setIssueStateCalls.some(
      (c) => c.identifier === "ENG-300" && c.stateName === "Canceled",
    ),
  ).toBe(true);
});

// Parameterised across the three PR-driven terminal states. Each must
// process through tick without a Linear writeback — the GH integration
// owns the transition and a double-write would race it.
const PR_TERMINAL_CASES = [
  { suffix: "merged", state: "merged" as const, action: "pr_merged" },
  {
    suffix: "closed-unmerged",
    state: "closed_unmerged" as const,
    action: "pr_closed_unmerged",
  },
];

for (const { suffix, state, action } of PR_TERMINAL_CASES) {
  test(`test_linear_sync_pr_${suffix}_does_not_write_to_linear`, async () => {
    h = createHarness();
    h.clock.set("2026-05-11T10:00:00.000Z");
    const built = buildTickDeps(h);
    const repoId = insertRepo(h.db, `repo-sync-pr-${suffix}`);
    const taskId = insertTask(h.db, {
      taskId: `task-sync-pr-${suffix}`,
      repoId,
      state: "pr-open",
    });
    setExternalRef(h, taskId, "ENG-400");
    insertAttempt(h.db, {
      taskId,
      attemptNumber: 1,
      spawnedAt: "2026-05-11T08:00:00.000Z",
    });

    built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
      prNumber: 42,
      prUrl: "https://example/pr/42",
      headSha: "headsha",
      baseSha: "basesha",
      state,
      mergeable: "mergeable",
      checks: { items: [], checkSha: "headsha" },
      latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    });

    const results = await tick_once(built.deps);
    expect(results.some((r) => r.action === action)).toBe(true);
    expect(built.linear.setIssueStateCalls).toEqual([]);
  });
}

test("test_linear_sync_pr_opened_classifier_does_not_write_to_linear", async () => {
  // The classifier emits `pr_opened` when a running worker exits with a
  // freshly-opened PR (githubPort.prExistsForBranch flips true on this
  // attempt). The transition must NOT trigger a Linear writeback — the
  // GH integration handles "In PR Review" and a double-write would race.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-pr-opened");
  const t = insertRunningTask(h.db, {
    taskId: "task-sync-pr-opened",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    attemptNumber: 1,
    remoteShaAtSpawn: "pushed-by-prev",
    prExistedAtSpawn: 0,
  });
  setExternalRef(h, t.taskId, "ENG-500");
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "pushed-by-prev");
  built.github.setPrExists(repoId, t.branchName, true);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "pr_opened")).toBe(true);
  expect(built.linear.setIssueStateCalls).toEqual([]);
});

test("test_linear_sync_idempotent_skip_when_already_at_target", async () => {
  // The fake mirrors the real adapter's read-before-write: when the issue's
  // current Linear state already matches the requested name, the call is
  // a no-op and nothing lands in `setIssueStateCalls`.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  built.linear.setCurrentState("ENG-500", "In Progress");

  const repoId = insertRepo(h.db, "repo-sync-idem");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-idem",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-500");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);
  expect(built.linear.setIssueStateCalls).toEqual([]);
});

test("test_linear_sync_skips_when_external_ref_is_not_linear_format", async () => {
  // The sync helper format-gates on `^[A-Z][A-Z0-9]*-\d+$`; a non-Linear
  // external_ref (legacy `--brief-file --external-ref` callers, or some
  // future non-Linear source) must never reach the Linear adapter.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);

  const repoId = insertRepo(h.db, "repo-sync-non-linear");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-non-linear",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "JIRA/some-other-source-123");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);
  expect(built.linear.setIssueStateCalls).toEqual([]);
});

test("test_linear_sync_failure_is_best_effort_and_does_not_fail_tick", async () => {
  // Adapter error must downgrade to a warning and NOT propagate into the
  // tick result. The task's own state remains the source of truth — the
  // spawn still committed.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  built.linear.failNextSetIssueState(new Error("simulated Linear 500"));

  const repoId = insertRepo(h.db, "repo-sync-failure");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-failure",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-600");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);

  // Task moved to running despite the Linear failure.
  const state = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.state;
  expect(state).toBe("running");
});

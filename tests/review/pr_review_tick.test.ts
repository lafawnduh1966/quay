import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildTickDeps } from "../support/tick_deps.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("CI-green pr-open task enters pr-review when reviewer gate is enabled", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-gated");
  const taskId = insertTask(h.db, { repoId, taskId: "task-gated", state: "pr-open" });
  const attemptId = insertAttempt(h.db, {
    taskId,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "original task brief",
    extension: "md",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 99,
    state: "open",
    headSha: "head-99",
    baseSha: "base-1",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-99",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 99, {
    number: 99,
    title: "Quay-owned PR",
    body: "",
    url: "https://example.test/pr/99",
    headRefName: `quay/${taskId}`,
    headSha: "head-99",
  });

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    gateQuayOwnedDone: true,
  });

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const task = h.db
    .query<{ state: string; pr_number: number | null }, [string]>(
      `SELECT state, pr_number FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "pr-review", pr_number: 99 });
  const reviewAttempt = h.db
    .query<{ reason: string; head_sha: string | null }, [string]>(
      `SELECT reason, head_sha FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(reviewAttempt).toEqual({ reason: "review_only", head_sha: "head-99" });
});

test("tick spawns pending review attempts without moving task to running", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-spawn-review");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-spawn",
    state: "pr-review",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = 10, head_sha = 'review-sha' WHERE task_id = ?`)
    .run(taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
  });
  h.db
    .query(`UPDATE attempts SET head_sha = 'review-sha' WHERE attempt_id = ?`)
    .run(attemptId);
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId, "review prompt");

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(built.tmux.spawnCalls[0]!.sessionName).toContain("quay-review-");
  const row = h.db
    .query<{ state: string; spawned_at: string | null; tmux_session: string | null }, [number]>(
      `SELECT t.state, a.spawned_at, a.tmux_session
         FROM attempts a JOIN tasks t ON t.task_id = a.task_id
        WHERE a.attempt_id = ?`,
    )
    .get(attemptId);
  expect(row?.state).toBe("pr-review");
  expect(row?.spawned_at).not.toBeNull();
  expect(row?.tmux_session).toContain("quay-review-");
});

test("dead synthetic reviewer approval stores review artifact and marks task done", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-done");
  const taskId = "pr-review-repo-review-done-7";
  const worktreePath = `${h.dataDir}/worktrees/review-7`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/7', 'quay-review-repo-review-done-7',
                 ?, 7, 'sha-7', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-7', tmux_session = 'quay-review-session'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 7, "sha-7", {
    reviewId: "R_approved",
    decision: "APPROVED",
    body: "Looks good.",
    comments: "Looks good.",
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({ task_id: taskId, action: "review_approved" });
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("done");
  const attempt = h.db
    .query<{ review_verdict: string | null; review_id: string | null }, [number]>(
      `SELECT review_verdict, review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt).toEqual({
    review_verdict: "approved",
    review_id: "R_approved",
  });
  const artifact = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'review_comments'`,
    )
    .get(taskId);
  expect(artifact?.n).toBe(1);
});

test("dead synthetic reviewer changes_requested waits for external changes", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-wait");
  const taskId = "pr-review-repo-review-wait-8";
  const worktreePath = `${h.dataDir}/worktrees/review-8`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/8', 'quay-review-repo-review-wait-8',
                 ?, 8, 'sha-8', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-8', tmux_session = 'quay-review-session-8'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 8, "sha-8", {
    reviewId: "R_changes",
    decision: "CHANGES_REQUESTED",
    body: "Please fix this.",
    comments: "Inline review comments (1):\n- src/a.ts:1 - fix this",
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_changes_requested",
  });
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("waiting_external_changes");
});

test("Quay-owned reviewer changes_requested schedules non-budget code respawn", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-respawn");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-respawn",
    state: "pr-review",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = 11, head_sha = 'sha-11' WHERE task_id = ?`)
    .run(taskId);
  const codeAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: codeAttemptId,
    kind: "brief",
    content: "original code brief",
    extension: "md",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-11', tmux_session = 'quay-review-session-11'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  built.github.setPostedReview(repoId, 11, "sha-11", {
    reviewId: "R_quay_changes",
    decision: "CHANGES_REQUESTED",
    body: "Blocking issue.",
    comments: "Blocking issue.",
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_respawn_scheduled",
  });
  const task = h.db
    .query<{ state: string; non_budget_respawns_consumed: number }, [string]>(
      `SELECT state, non_budget_respawns_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", non_budget_respawns_consumed: 1 });
  const latest = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(latest).toEqual({ reason: "review", consumed_budget: 0 });
});

test("reviewer infrastructure failures retry twice then park at same SHA", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-fail");
  const taskId = "pr-review-repo-review-fail-9";
  const worktreePath = `${h.dataDir}/worktrees/review-9`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, review_infra_failures_consecutive,
         review_infra_failure_head_sha, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/9', 'quay-review-repo-review-fail-9',
                 ?, 9, 'sha-9', 1, 2, 'sha-9', ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-9', tmux_session = 'quay-review-session-9'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "review brief",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content: "review prompt",
    extension: "md",
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({
    task_id: taskId,
    action: "non_budget_loop_parked",
  });
  const task = h.db
    .query<
      { state: string; review_infra_failures_consecutive: number; tick_error: string | null },
      [string]
    >(
      `SELECT state, review_infra_failures_consecutive, tick_error
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("non_budget_loop");
  expect(task?.review_infra_failures_consecutive).toBe(3);
  expect(task?.tick_error).toContain("no Quay-authored review");
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ? AND reason = 'review_only' AND ended_at IS NULL`,
    )
    .get(taskId);
  expect(pending?.n).toBe(0);
});

test("dead reviewer leaving .quay-blocked.md retries once and records a single review_blocker artifact", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-blocker");
  const taskId = "pr-review-repo-review-blocker-12";
  const worktreePath = `${h.dataDir}/worktrees/review-12`;
  mkdirSync(worktreePath, { recursive: true });
  const blockerContent =
    "Reviewer cannot post a verdict: spec is ambiguous on retry semantics.";
  writeFileSync(join(worktreePath, ".quay-blocked.md"), blockerContent);
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/12', 'quay-review-repo-review-blocker-12',
                 ?, 12, 'sha-12', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-12', tmux_session = 'quay-review-session-12'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  // Reviewer tmux is dead: deliberately not added to FakeTmux.liveSessions.

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_retry_scheduled",
  });
  expect(existsSync(join(worktreePath, ".quay-blocked.md"))).toBe(false);

  const blockerArtifacts = h.db
    .query<{ kind: string; file_path: string }, [string, number]>(
      `SELECT kind, file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'review_blocker'`,
    )
    .all(taskId, attemptId);
  expect(blockerArtifacts).toHaveLength(1);

  const tickErrors = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'tick_error'`,
    )
    .get(taskId);
  expect(tickErrors?.n).toBe(0);

  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "pr-review", tick_error: null });
});

test("tick reaps a superseded reviewer whose tmux outlived enterReview's commit", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-reap");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "pr-review-repo-reap-7",
    state: "pr-review",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = 7, head_sha = 'new-sha' WHERE task_id = ?`)
    .run(taskId);

  // Fake the state enterReview leaves behind after COMMIT but before its
  // own tmux.kill: attempt is ended + kill_intent='superseded', yet the
  // tmux session is still alive in the substrate.
  const supersededId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
         SET head_sha = 'old-sha',
             tmux_session = 'quay-review-orphan',
             ended_at = '2026-01-01T00:00:01.000Z',
             review_verdict = 'superseded',
             kill_intent = 'superseded'
       WHERE attempt_id = ?`,
    )
    .run(supersededId);
  built.tmux.liveSessions.add("quay-review-orphan");

  await tick_once(built.deps, { reviewerEnabled: true });

  expect(built.tmux.killCalls).toContain("quay-review-orphan");
  expect(built.tmux.liveSessions.has("quay-review-orphan")).toBe(false);
});

test("tick reaper skips a dead session and does not call kill twice", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-reap-idem");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "pr-review-repo-reap-idem-8",
    state: "pr-review",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = 8, head_sha = 'new-sha' WHERE task_id = ?`)
    .run(taskId);
  const supersededId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
         SET head_sha = 'old-sha',
             tmux_session = 'quay-review-already-dead',
             ended_at = '2026-01-01T00:00:01.000Z',
             review_verdict = 'superseded',
             kill_intent = 'superseded'
       WHERE attempt_id = ?`,
    )
    .run(supersededId);
  // Session intentionally NOT added to liveSessions.

  await tick_once(built.deps, { reviewerEnabled: true });
  expect(built.tmux.killCalls).not.toContain("quay-review-already-dead");
});

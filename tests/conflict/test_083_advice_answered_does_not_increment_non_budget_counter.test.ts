// §7 "Non-budget retry dedup" + §14 "advice_answered not counted toward
// non-budget cap": human-reply-driven `advice_answered` respawns do NOT
// increment `non_budget_respawns_consumed`. Only review/conflict do.
//
// Drives the contrast against `tests/conflict/test_052...`: the same
// counter that a `conflict` respawn moves stays untouched after an
// `advice_answered` `submit-brief`.
import { afterEach, expect, test } from "bun:test";
import { claim_task, submit_brief } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_083_advice_answered_does_not_increment_non_budget_counter", () => {
  h = createHarness();
  h.clock.set("2026-04-29T18:00:00.000Z");

  // --- Part A: a `conflict` respawn moves the counter to 1.
  const repoA = insertRepo(h.db, "repo-conflict-baseline");
  const taskA = insertTask(h.db, {
    taskId: "task-conflict-baseline",
    repoId: repoA,
    state: "pr-open",
  });
  const attemptA = insertAttempt(h.db, {
    taskId: taskA,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T17:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId: taskA,
    attemptId: attemptA,
    kind: "brief",
    content: "task-A initial brief",
    extension: "md",
  });
  built.github.setPrSnapshot(repoA, `quay/${taskA}`, {
    state: "open",
    headSha: "ha",
    baseSha: "ba",
    mergeable: "conflicting",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "ha",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });
  tick_once(built.deps);
  const aCounter = h.db
    .query<{ n: number }, [string]>(
      `SELECT non_budget_respawns_consumed AS n FROM tasks WHERE task_id = ?`,
    )
    .get(taskA);
  expect(aCounter?.n).toBe(1); // conflict path increments

  // --- Part B: an `advice_answered` brief on a separate task does NOT.
  const repoB = insertRepo(h.db, "repo-advice");
  const taskB = insertTask(h.db, {
    taskId: "task-advice",
    repoId: repoB,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId: taskB,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T17:30:00.000Z",
  });

  // Claim then submit-brief --reason advice_answered. This is the human-
  // reply-driven path that creates a non-budget-consuming attempt.
  const claim = claim_task(built.deps, { taskId: taskB });
  expect(claim.ok).toBe(true);
  const claimId = claim.ok ? claim.value.claim_id : "";

  const submitted = submit_brief(built.deps, {
    taskId: taskB,
    claimId,
    brief: "incorporating the human's advice",
    reason: "advice_answered",
  });
  expect(submitted.ok).toBe(true);

  const taskBState = h.db
    .query<
      { state: string; non_budget_respawns_consumed: number },
      [string]
    >(
      `SELECT state, non_budget_respawns_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskB);
  expect(taskBState).toEqual({
    state: "queued",
    non_budget_respawns_consumed: 0, // unchanged: advice_answered does NOT count
  });

  const pendingB = h.db
    .query<
      { reason: string; consumed_budget: number },
      [string]
    >(
      `SELECT reason, consumed_budget
         FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskB);
  expect(pendingB).toEqual({ reason: "advice_answered", consumed_budget: 0 });
});

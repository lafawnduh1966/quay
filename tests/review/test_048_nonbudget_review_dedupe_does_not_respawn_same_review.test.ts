// §5 done-state polling + §7 "Non-budget respawn dedup": tick only triggers
// a `review` respawn if `gh pr view` reports a *newer* review id. Sticky
// CHANGES_REQUESTED on a review Quay already addressed must NOT re-trigger.
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_048_nonbudget_review_dedupe_does_not_respawn_same_review", () => {
  h = createHarness();
  h.clock.set("2026-04-29T15:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-review-dedup");
  const taskId = insertTask(h.db, {
    taskId: "task-review-dedup",
    repoId,
    state: "done",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T14:00:00.000Z",
  });
  // Quay has already acted on review-7 in a prior tick.
  h.db
    .query(
      `UPDATE tasks
          SET last_review_id_acted_on = ?,
              non_budget_respawns_consumed = 1,
              attempts_consumed = 1,
              tick_error = 'previous transient GitHub read failed'
        WHERE task_id = ?`,
    )
    .run("review-7", taskId);

  const built = buildTickDeps(h);
  // Same review id still on the PR (sticky CHANGES_REQUESTED).
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "h1",
    baseSha: "b1",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "review-7",
      comments: "(unchanged)",
    },
    checks: {
      checkSha: "h1",
      items: [
        { name: "build", workflow: null, bucket: "pass", required: true },
      ],
    },
  });

  const results = tick_once(built.deps);
  // No respawn scheduled; tick is silent on this task.
  expect(results).toEqual([]);

  const task = h.db
    .query<
      {
        state: string;
        last_review_id_acted_on: string | null;
        non_budget_respawns_consumed: number;
        attempts_consumed: number;
        tick_error: string | null;
      },
      [string]
    >(
      `SELECT state, last_review_id_acted_on, non_budget_respawns_consumed,
              attempts_consumed, tick_error
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "done",
    last_review_id_acted_on: "review-7",
    non_budget_respawns_consumed: 1, // not incremented again
    attempts_consumed: 1,
    tick_error: null,
  });

  // No new pending attempt scheduled.
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending?.n).toBe(0);

  // No second review_comments artifact.
  const comments = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ? AND kind = 'review_comments'`,
    )
    .get(taskId);
  expect(comments?.n).toBe(0);
});

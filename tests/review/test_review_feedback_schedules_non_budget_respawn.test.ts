// §5 done-state polling: when `gh pr view` reports `reviewDecision =
// CHANGES_REQUESTED` and the latest review id differs from
// `last_review_id_acted_on`, tick snapshots the review comments, schedules a
// pending `review` attempt with `consumed_budget = 0`, and records
// `last_review_id_acted_on`. Budget is preserved.
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

test("test_review_feedback_schedules_non_budget_respawn", () => {
  h = createHarness();
  h.clock.set("2026-04-29T14:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-review");
  const taskId = insertTask(h.db, {
    taskId: "task-review",
    repoId,
    state: "done",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T13:00:00.000Z",
  });
  // Pre-existing brief artifact so the retry brief composition has a
  // most-recent-brief to wrap.
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "initial implementation brief",
    extension: "md",
  });

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-rev",
    baseSha: "base-rev",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "review-42",
      comments: "Please rename `foo` to `bar` and add a unit test.",
    },
    checks: {
      checkSha: "head-rev",
      items: [
        { name: "build", workflow: null, bucket: "pass", required: true },
      ],
    },
  });

  const results = tick_once(built.deps);
  expect(results).toEqual([
    { task_id: taskId, action: "review_respawn_scheduled" },
  ]);

  const task = h.db
    .query<
      {
        state: string;
        attempts_consumed: number;
        last_review_id_acted_on: string | null;
        non_budget_respawns_consumed: number;
      },
      [string]
    >(
      `SELECT state, attempts_consumed, last_review_id_acted_on,
              non_budget_respawns_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "queued",
    attempts_consumed: 1, // unchanged — non-budget
    last_review_id_acted_on: "review-42",
    non_budget_respawns_consumed: 1,
  });

  // Pending attempt has consumed_budget = 0 and reason = 'review'.
  const pending = h.db
    .query<
      {
        attempt_number: number;
        reason: string;
        consumed_budget: number;
        spawned_at: string | null;
      },
      [string]
    >(
      `SELECT attempt_number, reason, consumed_budget, spawned_at
         FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending).toEqual({
    attempt_number: 2,
    reason: "review",
    consumed_budget: 0,
    spawned_at: null,
  });

  // review_comments artifact exists, attached to the prior attempt.
  const comments = h.db
    .query<
      { n: number; attempt_id: number | null },
      [string]
    >(
      `SELECT COUNT(*) AS n, MIN(attempt_id) AS attempt_id
         FROM artifacts WHERE task_id = ? AND kind = 'review_comments'`,
    )
    .get(taskId);
  expect(comments?.n).toBe(1);
  expect(comments?.attempt_id).toBe(attemptId);

  // changes_requested event references the artifact.
  const event = h.db
    .query<
      { from_state: string; to_state: string; payload_artifact_id: number },
      [string]
    >(
      `SELECT from_state, to_state, payload_artifact_id
         FROM events
        WHERE task_id = ? AND event_type = 'changes_requested'`,
    )
    .get(taskId);
  expect(event?.from_state).toBe("done");
  expect(event?.to_state).toBe("queued");
  expect(event?.payload_artifact_id).toBeGreaterThan(0);
});

// §5 "CI status rules": "if the SHA changes between fetch and decision,
// Quay logs `tick_error` and retries on the next tick." The SHA-mismatch
// path leaves task state unchanged, schedules no respawn, and consumes no
// retry budget.
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

test("test_076_stale_check_sha_logs_tick_error_without_transition", () => {
  h = createHarness();
  h.clock.set("2026-04-29T11:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-stale-sha");
  const taskId = insertTask(h.db, {
    taskId: "task-stale-sha",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-29T10:30:00.000Z" });
  h.db.query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`).run(taskId);

  const built = buildTickDeps(h);
  // Force a SHA mismatch: PR's headRefOid (current head) is `new-head`, but
  // the checks were last run against `old-head`. Per spec, this is stale
  // — log tick_error, no transition.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "new-head",
    baseSha: "base-sha",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "old-head",
      items: [
        { name: "build", workflow: null, bucket: "pass", required: true },
      ],
    },
  });

  const results = tick_once(built.deps);
  expect(results).toHaveLength(1);
  expect(results[0]?.task_id).toBe(taskId);
  expect(results[0]?.action).toBe("tick_error");

  const task = h.db
    .query<
      { state: string; tick_error: string | null; attempts_consumed: number },
      [string]
    >(
      `SELECT state, tick_error, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("pr-open"); // unchanged
  expect(task?.attempts_consumed).toBe(1); // no budget consumed
  expect(task?.tick_error).toBeTruthy();

  // No deterministic-retry attempt was scheduled.
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending?.n).toBe(0);

  const tickErrorEvents = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'tick_error'`,
    )
    .get(taskId);
  expect(tickErrorEvents?.n).toBe(1);

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "new-head",
    baseSha: "base-sha",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "new-head",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  const retryResults = tick_once(built.deps);
  expect(retryResults).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  const recovered = h.db
    .query<{ tick_error: string | null }, [string]>(
      `SELECT tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(recovered?.tick_error).toBeNull();
});

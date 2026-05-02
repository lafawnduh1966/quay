import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_tick_error_isolated_to_task_and_tick_continues", () => {
  h = createHarness();
  h.clock.set("2026-04-26T12:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-isolation");
  const failingTask = insertTask(h.db, { taskId: "task-fetch-fails", repoId });
  const healthyTask = insertTask(h.db, { taskId: "task-still-spawns", repoId });

  const failingAttemptId = insertAttempt(h.db, {
    taskId: failingTask,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  const healthyAttemptId = insertAttempt(h.db, {
    taskId: healthyTask,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    failingTask,
    failingAttemptId,
  );
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    healthyTask,
    healthyAttemptId,
  );

  const built = buildTickDeps(h);
  built.git.fail.fetchBranchIfExists = (_repoId, branch) =>
    branch === `quay/${failingTask}`;

  const results = tick_once(built.deps);

  expect(results.map((r) => r.action)).toEqual(["tick_error", "spawned"]);
  expect(results[0]!.task_id).toBe(failingTask);
  expect(results[0]!.error).toContain("fetchBranchIfExists failed");
  expect(results[1]).toEqual({ task_id: healthyTask, action: "spawned" });

  const rows = h.db
    .query<
      { task_id: string; state: string; tick_error: string | null },
      [string, string]
    >(
      `SELECT task_id, state, tick_error
         FROM tasks
        WHERE task_id IN (?, ?)
        ORDER BY task_id`,
    )
    .all(failingTask, healthyTask);

  expect(rows).toEqual([
    {
      task_id: failingTask,
      state: "queued",
      tick_error: expect.stringContaining("fetchBranchIfExists failed"),
    },
    { task_id: healthyTask, state: "running", tick_error: null },
  ]);

  const events = h.db
    .query<{ task_id: string; event_type: string }, []>(
      `SELECT task_id, event_type FROM events ORDER BY event_id`,
    )
    .all();
  expect(events).toEqual([
    { task_id: failingTask, event_type: "tick_error" },
    { task_id: healthyTask, event_type: "spawned" },
  ]);

  delete built.git.fail.fetchBranchIfExists;

  const retry = tick_once(built.deps);

  expect(retry).toEqual([{ task_id: failingTask, action: "spawned" }]);

  const recovered = h.db
    .query<
      { state: string; attempts_consumed: number; tick_error: string | null },
      [string]
    >(
      `SELECT state, attempts_consumed, tick_error
         FROM tasks WHERE task_id = ?`,
    )
    .get(failingTask);

  expect(recovered).toEqual({
    state: "running",
    attempts_consumed: 1,
    tick_error: null,
  });
});

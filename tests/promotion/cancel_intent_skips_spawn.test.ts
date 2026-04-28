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

test("test_promotion_rowcount_zero_on_cancel_intent_skips_spawn", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-cancel");
  const taskId = insertTask(h.db, { taskId: "task-cancel-mid", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });

  // Cancel intent set on the row before tick runs. The promotion's predicate
  // (`cancel_requested_at IS NULL`) yields rowcount=0 so the transaction is
  // rolled back and tmux spawn is never attempted.
  h.db.query(`UPDATE tasks SET cancel_requested_at = ? WHERE task_id = ?`).run(
    "2026-04-26T10:00:00.000Z",
    taskId,
  );

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, null);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  // With Slice 7's top-of-loop cancel finalizer, a pre-existing
  // cancel_requested_at is honored before per-state handling: the task
  // converges to `cancelled` without ever reaching the queued promotion path.
  // The Slice 3 invariant survives — promotion's `cancel_requested_at IS NULL`
  // predicate is still in place as a belt-and-suspenders backstop, and the
  // observable result is identical: no tmux spawn, no budget consumed, no
  // `spawned` event, no per-attempt promotion commits.
  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "cancel_finalized" }]);

  // No tmux spawn at all (not even attempted).
  expect(built.tmux.spawnAttempts).toHaveLength(0);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  // No promotion-time git/github reads ever happened.
  expect(built.github.calls).toHaveLength(0);

  // Task is now terminal as `cancelled`; budget never consumed.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number; cancel_requested_at: string | null },
      [string]
    >(
      `SELECT state, attempts_consumed, cancel_requested_at
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("cancelled");
  expect(task!.attempts_consumed).toBe(0);
  expect(task!.cancel_requested_at).not.toBeNull();

  // The pending attempt was never promoted: spawned_at remains NULL and
  // tmux_session was never set.
  const att = h.db
    .query<
      { spawned_at: string | null; tmux_session: string | null },
      [number]
    >(
      `SELECT spawned_at, tmux_session FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.spawned_at).toBeNull();
  expect(att!.tmux_session).toBeNull();

  // No `spawned` event written.
  const ev = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'spawned'`,
    )
    .get(taskId);
  expect(ev!.n).toBe(0);
});

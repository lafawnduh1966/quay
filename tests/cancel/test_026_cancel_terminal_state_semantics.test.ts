// Cancel against terminal states (spec §10 idempotency, §15 case 26).
//
// - Cancel on an already-cancelled task is an idempotent no-op success: no
//   second `cancelled` event, no SQL writes, no substrate calls.
// - Cancel on `merged` or `closed_unmerged` errors with `wrong_state`. Same:
//   no SQL writes, no substrate calls.

import { afterEach, expect, test } from "bun:test";
import { cancel_task } from "../../src/core/cancel.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function snapshotState(h: Harness, taskId: string) {
  const task = h.db
    .query<
      {
        state: string;
        cancel_requested_at: string | null;
        updated_at: string;
      },
      [string]
    >(
      `SELECT state, cancel_requested_at, updated_at FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  const events = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ?`,
    )
    .get(taskId);
  return { task: task!, eventCount: events!.n };
}

test("test_026_cancel_terminal_state_semantics", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-026");

  // Sub-case A: already-cancelled task → idempotent no-op success.
  const cancelledId = insertTask(h.db, {
    taskId: "task-cancelled",
    repoId,
    state: "cancelled",
  });
  insertAttempt(h.db, {
    taskId: cancelledId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });
  // Pretend prior cancel left these populated (forensic field).
  h.db
    .query(
      `UPDATE tasks SET cancel_requested_at = ?, updated_at = ?
        WHERE task_id = ?`,
    )
    .run("2026-04-28T09:00:00.000Z", "2026-04-28T09:00:00.000Z", cancelledId);

  const built = buildTickDeps(h);
  const before = snapshotState(h, cancelledId);

  const r1 = cancel_task(built.deps, { taskId: cancelledId });
  expect(r1.ok).toBe(true);
  if (!r1.ok) throw new Error("expected ok");
  expect(r1.value.outcome).toBe("already_cancelled");
  expect(r1.value.state).toBe("cancelled");

  const after = snapshotState(h, cancelledId);
  expect(after.task.state).toBe("cancelled");
  expect(after.task.updated_at).toBe(before.task.updated_at);
  expect(after.task.cancel_requested_at).toBe(before.task.cancel_requested_at);
  expect(after.eventCount).toBe(before.eventCount);
  expect(built.git.calls).toHaveLength(0);
  expect(built.github.calls).toHaveLength(0);
  expect(built.github.closePrCalls).toHaveLength(0);
  expect(built.tmux.killCalls).toHaveLength(0);

  // Sub-case B: merged → wrong_state.
  const mergedId = insertTask(h.db, {
    taskId: "task-merged",
    repoId,
    state: "merged",
  });
  insertAttempt(h.db, {
    taskId: mergedId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });
  const mergedBefore = snapshotState(h, mergedId);
  const r2 = cancel_task(built.deps, { taskId: mergedId });
  expect(r2.ok).toBe(false);
  if (r2.ok) throw new Error("expected error");
  expect(r2.error.code).toBe("wrong_state");
  expect(r2.error.details?.state).toBe("merged");
  const mergedAfter = snapshotState(h, mergedId);
  expect(mergedAfter.task.state).toBe("merged");
  expect(mergedAfter.task.cancel_requested_at).toBeNull();
  expect(mergedAfter.task.updated_at).toBe(mergedBefore.task.updated_at);
  expect(mergedAfter.eventCount).toBe(mergedBefore.eventCount);

  // Sub-case C: closed_unmerged → wrong_state.
  const closedId = insertTask(h.db, {
    taskId: "task-closed",
    repoId,
    state: "closed_unmerged",
  });
  insertAttempt(h.db, {
    taskId: closedId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });
  const closedBefore = snapshotState(h, closedId);
  const r3 = cancel_task(built.deps, { taskId: closedId });
  expect(r3.ok).toBe(false);
  if (r3.ok) throw new Error("expected error");
  expect(r3.error.code).toBe("wrong_state");
  expect(r3.error.details?.state).toBe("closed_unmerged");
  const closedAfter = snapshotState(h, closedId);
  expect(closedAfter.task.state).toBe("closed_unmerged");
  expect(closedAfter.task.cancel_requested_at).toBeNull();
  expect(closedAfter.task.updated_at).toBe(closedBefore.task.updated_at);
  expect(closedAfter.eventCount).toBe(closedBefore.eventCount);

  // No substrate calls happened across all three sub-cases.
  expect(built.git.calls).toHaveLength(0);
  expect(built.github.closePrCalls).toHaveLength(0);
  expect(built.tmux.killCalls).toHaveLength(0);
});

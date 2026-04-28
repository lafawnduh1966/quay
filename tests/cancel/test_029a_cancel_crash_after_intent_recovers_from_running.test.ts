// Cancel from `running` survives a crash between intent commit and the
// terminal SQL transition (spec §15 case 29a, §14 "Single cancel finalizer,
// durable task-level intent").
//
// Sequence under test:
//   1. cancel_task is called on a running task; intent + kill_intent are
//      committed and tmux is killed.
//   2. Process death is simulated via the after_cancel_intent_commit
//      failpoint, throwing before the synchronous finalizer can run.
//   3. The next tick observes `cancel_requested_at IS NOT NULL`, runs the
//      canonical finalizer, and converges the task to `cancelled`.

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import {
  clearAllFailpoints,
  setFailpoint,
} from "../../src/core/failpoints.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  clearAllFailpoints();
  h?.cleanup();
  h = null;
});

test("test_029a_cancel_crash_after_intent_recovers_from_running", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-029a");
  const t = insertRunningTask(h.db, {
    taskId: "task-029a",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(t.sessionName!);
  // No PR open at cancel time → default cleanup deletes everything.
  built.git.setRemoteBranches(repoId, []);
  built.github.setPrIsOpen(repoId, t.branchName, false);

  // Simulate a crash immediately after intent commit + tmux kill, before the
  // synchronous cancel finalizer can run its terminal SQL transition.
  setFailpoint("after_cancel_intent_commit", () => {
    throw new Error("simulated crash after cancel intent commit");
  });

  expect(() => cancel_task(built.deps, { taskId: t.taskId })).toThrow(
    /simulated crash/,
  );

  // Mid-cancel forensic state: intent durable, kill_intent set, tmux dead,
  // task still in `running` because the finalizer never reached step 4.
  const mid = h.db
    .query<
      {
        state: string;
        cancel_requested_at: string | null;
        cancel_close_pr: number;
        cancel_keep_worktree: number;
      },
      [string]
    >(
      `SELECT state, cancel_requested_at, cancel_close_pr, cancel_keep_worktree
         FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(mid!.state).toBe("running");
  expect(mid!.cancel_requested_at).not.toBeNull();
  expect(mid!.cancel_close_pr).toBe(0);
  expect(mid!.cancel_keep_worktree).toBe(0);

  const midAttempt = h.db
    .query<
      { kill_intent: string | null; ended_at: string | null; exit_kind: string | null },
      [number]
    >(
      `SELECT kill_intent, ended_at, exit_kind FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(midAttempt!.kill_intent).toBe("cancel");
  expect(midAttempt!.ended_at).toBeNull();
  expect(midAttempt!.exit_kind).toBeNull();
  expect(built.tmux.killCalls).toContain(t.sessionName!);
  expect(built.tmux.liveSessions.has(t.sessionName!)).toBe(false);

  // Clear the failpoint — recovery proceeds normally.
  clearAllFailpoints();

  const tickResults = tick_once(built.deps);
  expect(tickResults).toEqual([
    { task_id: t.taskId, action: "cancel_finalized" },
  ]);

  const final = h.db
    .query<
      { state: string; cancel_requested_at: string | null },
      [string]
    >(`SELECT state, cancel_requested_at FROM tasks WHERE task_id = ?`)
    .get(t.taskId);
  expect(final!.state).toBe("cancelled");
  // Forensic record retained.
  expect(final!.cancel_requested_at).not.toBeNull();

  const finalAttempt = h.db
    .query<
      { exit_kind: string | null; kill_intent: string | null; ended_at: string | null },
      [number]
    >(
      `SELECT exit_kind, kill_intent, ended_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(finalAttempt!.exit_kind).toBe("killed_cancel");
  expect(finalAttempt!.kill_intent).toBeNull();
  expect(finalAttempt!.ended_at).not.toBeNull();

  const cancelledEvent = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'cancelled'`,
    )
    .get(t.taskId);
  expect(cancelledEvent!.n).toBe(1);
});

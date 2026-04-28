import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_003_dead_worker_without_pr_or_signal_schedules_crash_retry", () => {
  h = createHarness();
  h.clock.set("2026-04-26T14:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-crash");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-crash",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  // Remote branch never pushed; no PR created.
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "crashed" }]);

  // Task back to queued; attempts_consumed not yet incremented for the retry
  // (budget consumption happens at the next promotion, not at scheduling).
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >(`SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`)
    .get(t.taskId);
  expect(task!.state).toBe("queued");
  expect(task!.attempts_consumed).toBe(1);

  // Dead attempt marked crashed.
  const dead = h.db
    .query<
      {
        exit_kind: string | null;
        ended_at: string | null;
        remote_sha_at_exit: string | null;
      },
      [number]
    >(
      `SELECT exit_kind, ended_at, remote_sha_at_exit
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_kind).toBe("crashed");
  expect(dead!.ended_at).toBe("2026-04-26T14:00:00.000Z");
  expect(dead!.remote_sha_at_exit).toBeNull();

  // Pending crash retry inserted with consumed_budget = 1.
  const pending = h.db
    .query<
      {
        attempt_id: number;
        attempt_number: number;
        reason: string;
        consumed_budget: number;
        spawned_at: string | null;
        tmux_session: string | null;
      },
      [string]
    >(
      `SELECT attempt_id, attempt_number, reason, consumed_budget,
              spawned_at, tmux_session
         FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .all(t.taskId);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.attempt_number).toBe(t.attemptNumber + 1);
  expect(pending[0]!.reason).toBe("crash");
  expect(pending[0]!.consumed_budget).toBe(1);
  expect(pending[0]!.spawned_at).toBeNull();
  expect(pending[0]!.tmux_session).toBeNull();

  // Single crashed event, transition logged.
  const ev = h.db
    .query<
      {
        event_type: string;
        from_state: string | null;
        to_state: string | null;
      },
      [string]
    >(
      `SELECT event_type, from_state, to_state
         FROM events WHERE task_id = ? AND event_type = 'crashed'`,
    )
    .all(t.taskId);
  expect(ev).toEqual([
    { event_type: "crashed", from_state: "running", to_state: "queued" },
  ]);
});

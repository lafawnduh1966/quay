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

test("test_074_no_remote_progress_is_no_progress", () => {
  h = createHarness();
  h.clock.set("2026-04-26T17:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-no-progress");
  const worktreesRoot = join(h.dataDir, "worktrees");

  // Retry attempt with an existing PR; remote SHA does not advance.
  const t = insertRunningTask(h.db, {
    taskId: "task-no-progress",
    repoId,
    worktreesRoot,
    attemptNumber: 2,
    reason: "crash",
    consumedBudget: 1,
    remoteShaAtSpawn: "abc123",
    prExistedAtSpawn: 1,
    attemptsConsumed: 2,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "abc123"); // unchanged
  built.github.setPrExists(repoId, t.branchName, true);

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "no_progress" }]);

  // Classified as no_progress, not pr-open.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >(`SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`)
    .get(t.taskId);
  expect(task!.state).toBe("queued");
  // Budget consumption deferred to next promotion: still 2.
  expect(task!.attempts_consumed).toBe(2);

  const dead = h.db
    .query<
      {
        exit_kind: string | null;
        remote_sha_at_exit: string | null;
        ended_at: string | null;
      },
      [number]
    >(
      `SELECT exit_kind, remote_sha_at_exit, ended_at
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_kind).toBe("no_progress");
  expect(dead!.remote_sha_at_exit).toBe("abc123");
  expect(dead!.ended_at).toBe("2026-04-26T17:00:00.000Z");

  // Pending budget-consuming `crash` retry scheduled.
  const pending = h.db
    .query<
      { reason: string; consumed_budget: number; spawned_at: string | null },
      [string]
    >(
      `SELECT reason, consumed_budget, spawned_at FROM attempts
         WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .all(t.taskId);
  expect(pending).toEqual([
    { reason: "crash", consumed_budget: 1, spawned_at: null },
  ]);

  const ev = h.db
    .query<
      { from_state: string | null; to_state: string | null },
      [string]
    >(
      `SELECT from_state, to_state FROM events
         WHERE task_id = ? AND event_type = 'no_progress'`,
    )
    .all(t.taskId);
  expect(ev).toEqual([{ from_state: "running", to_state: "queued" }]);
});

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

test("test_073_retry_attempt_does_not_create_duplicate_pr", () => {
  h = createHarness();
  h.clock.set("2026-04-26T16:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-update");
  const worktreesRoot = join(h.dataDir, "worktrees");

  // Retry attempt N+1: prior attempt opened a PR and pushed; this attempt
  // pushes more commits to the same branch.
  const t = insertRunningTask(h.db, {
    taskId: "task-pr-update",
    repoId,
    worktreesRoot,
    attemptNumber: 2,
    reason: "crash",
    consumedBudget: 1,
    remoteShaAtSpawn: "old-sha",
    prExistedAtSpawn: 1,
    attemptsConsumed: 2,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  // Worker advanced the remote branch; PR still exists (existing one).
  built.git.setRemoteHeadSha(repoId, t.branchName, "new-sha");
  built.github.setPrExists(repoId, t.branchName, true);

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "pr_opened" }]);

  // Task transitions to pr-open without scheduling a retry.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >(`SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`)
    .get(t.taskId);
  expect(task!.state).toBe("pr-open");
  expect(task!.attempts_consumed).toBe(2);

  const att = h.db
    .query<
      { exit_kind: string | null; remote_sha_at_exit: string | null },
      [number]
    >(
      `SELECT exit_kind, remote_sha_at_exit FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(att!.exit_kind).toBe("pr_opened");
  expect(att!.remote_sha_at_exit).toBe("new-sha");

  // No new pending attempt — no duplicate retry, no duplicate PR work.
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
         WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(t.taskId);
  expect(pending!.n).toBe(0);

  // pr_opened transition event recorded.
  const ev = h.db
    .query<
      { from_state: string | null; to_state: string | null },
      [string]
    >(
      `SELECT from_state, to_state FROM events
         WHERE task_id = ? AND event_type = 'pr_opened'`,
    )
    .all(t.taskId);
  expect(ev).toEqual([{ from_state: "running", to_state: "pr-open" }]);
});

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

test("test_074c_pr_created_during_attempt_counts_as_progress", () => {
  h = createHarness();
  h.clock.set("2026-04-26T18:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-created");
  const worktreesRoot = join(h.dataDir, "worktrees");

  // Setup: prior attempt pushed but did not open a PR. This attempt opens
  // the PR without further pushes — the remote SHA does not change during
  // *this* attempt.
  const t = insertRunningTask(h.db, {
    taskId: "task-pr-created",
    repoId,
    worktreesRoot,
    attemptNumber: 2,
    reason: "crash",
    consumedBudget: 1,
    remoteShaAtSpawn: "pushed-by-prev",
    prExistedAtSpawn: 0,
    attemptsConsumed: 2,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "pushed-by-prev"); // unchanged
  built.github.setPrExists(repoId, t.branchName, true); // PR opened this attempt

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "pr_opened" }]);

  // PR creation counts as progress even with unchanged remote SHA.
  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task!.state).toBe("pr-open");

  const dead = h.db
    .query<
      { exit_kind: string | null; remote_sha_at_exit: string | null },
      [number]
    >(
      `SELECT exit_kind, remote_sha_at_exit FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_kind).toBe("pr_opened");
  expect(dead!.remote_sha_at_exit).toBe("pushed-by-prev");

  // No retry scheduled, no crash event.
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
         WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(t.taskId);
  expect(pending!.n).toBe(0);

  const noProgressEvents = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
         WHERE task_id = ? AND event_type IN ('no_progress', 'crashed')`,
    )
    .get(t.taskId);
  expect(noProgressEvents!.n).toBe(0);
});

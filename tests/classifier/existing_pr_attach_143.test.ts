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

test("AST-143 attaches an existing open PR instead of retrying as no_progress", async () => {
  h = createHarness();
  h.clock.set("2026-05-19T23:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-existing-pr");
  const worktreesRoot = join(h.dataDir, "worktrees");

  const t = insertRunningTask(h.db, {
    taskId: "task-existing-pr",
    repoId,
    branchName: "quay/BRIX-1431",
    worktreesRoot,
    attemptNumber: 3,
    reason: "crash",
    consumedBudget: 1,
    remoteShaAtSpawn: "head-924",
    prExistedAtSpawn: 1,
    attemptsConsumed: 3,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "head-924");
  built.github.setPrExists(repoId, t.branchName, true);
  built.github.setOpenPrsForBranchBase(repoId, t.branchName, "main", [
    {
      number: 924,
      url: "https://github.example/repo/pull/924",
      headSha: "head-924",
      baseSha: "base-main",
      baseRef: "main",
    },
  ]);

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "existing_pr_attached" }]);

  const task = h.db
    .query<
      {
        state: string;
        pr_number: number | null;
        pr_url: string | null;
        head_sha: string | null;
        base_sha: string | null;
        attempts_consumed: number;
      },
      [string]
    >(
      `SELECT state, pr_number, pr_url, head_sha, base_sha, attempts_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({
    state: "pr-open",
    pr_number: 924,
    pr_url: "https://github.example/repo/pull/924",
    head_sha: "head-924",
    base_sha: "base-main",
    attempts_consumed: 3,
  });

  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
         WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(t.taskId);
  expect(pending!.n).toBe(0);

  const attempt = h.db
    .query<
      { exit_kind: string | null; remote_sha_at_exit: string | null },
      [number]
    >(
      `SELECT exit_kind, remote_sha_at_exit
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(attempt).toEqual({
    exit_kind: "pr_opened",
    remote_sha_at_exit: "head-924",
  });

  const events = h.db
    .query<
      { event_type: string; from_state: string | null; to_state: string | null; event_data: string | null },
      [string]
    >(
      `SELECT event_type, from_state, to_state, event_data
         FROM events
        WHERE task_id = ?
          AND event_type IN ('existing_pr_attached', 'no_progress')
        ORDER BY event_id`,
    )
    .all(t.taskId);
  expect(events).toHaveLength(1);
  expect(events[0]!.event_type).toBe("existing_pr_attached");
  expect(events[0]!.from_state).toBe("running");
  expect(events[0]!.to_state).toBe("pr-open");
  expect(JSON.parse(events[0]!.event_data!)).toMatchObject({
    reason: "existing_open_pr_for_task_branch_base",
    pr_number: 924,
    branch_name: "quay/BRIX-1431",
    base_branch: "main",
    remote_unchanged: true,
    pr_existed_at_spawn: true,
  });
});

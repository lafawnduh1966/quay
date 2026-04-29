// §5 "pr-open polls PR state": a `pr-open` task whose PR was closed without
// merge transitions to `closed_unmerged`. Per §5 cleanup matrix, both local
// and remote branches are deleted (the human chose to discard the work).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_054_pr_open_closed_transitions_closed_unmerged", () => {
  h = createHarness();
  h.clock.set("2026-04-29T13:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-closed");
  const taskId = insertTask(h.db, {
    taskId: "task-pr-closed",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T12:00:00.000Z",
  });

  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [`quay/${taskId}`]);
  built.git.setRemoteBranches(repoId, [`quay/${taskId}`]);

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "closed_unmerged",
    headSha: "head-closed",
    baseSha: "base-closed",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-closed",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "pr_closed_unmerged" }]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("closed_unmerged");

  // Worktree removed; both branches deleted (closed_unmerged matrix row).
  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();
  expect(built.git.remoteBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();

  const evt = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'closed'`,
    )
    .get(taskId);
  expect(evt).toEqual({
    event_type: "closed",
    from_state: "pr-open",
    to_state: "closed_unmerged",
  });
});

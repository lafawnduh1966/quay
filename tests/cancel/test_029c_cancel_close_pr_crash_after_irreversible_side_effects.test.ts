// Cancel --close-pr on `done` survives a crash AFTER irreversible side
// effects (gh pr close already returned) but BEFORE the SQL terminal
// transition (spec §15 case 29c, §14 invariants).
//
// Critical invariant proven here: tick recovery NEVER misclassifies the task
// as `closed_unmerged`. Without the durable task-level cancel intent + the
// top-of-loop finalizer, the next tick's `done` poll would see a closed PR
// and drive the task to `closed_unmerged` — losing the operator's actual
// terminal intent. The cancel finalizer runs first because cancel intent
// is honored from every non-terminal state.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import {
  clearAllFailpoints,
  setFailpoint,
} from "../../src/core/failpoints.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  clearAllFailpoints();
  h?.cleanup();
  h = null;
});

function insertDoneTask(
  h: Harness,
  repoId: string,
  taskId: string,
  worktreePath: string,
  branchName: string,
  tmuxId: string,
) {
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         attempts_consumed, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'done', ?, ?, ?, 1, 5, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      branchName,
      tmuxId,
      worktreePath,
      "2026-04-28T08:00:00.000Z",
      "2026-04-28T09:00:00.000Z",
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:30:00.000Z",
  });
  // Mark attempt as already terminated (pr_opened) — the historical exit is
  // preserved across cancellation.
  h.db
    .query(
      `UPDATE attempts SET ended_at = ?, exit_kind = 'pr_opened',
                          tmux_session = NULL
        WHERE attempt_id = ?`,
    )
    .run("2026-04-28T08:45:00.000Z", attemptId);
  return attemptId;
}

test("test_029c_cancel_close_pr_crash_after_irreversible_side_effects", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-029c");
  const taskId = "task-029c";
  const branchName = `quay/${taskId}`;
  const tmuxId = `tmux-${taskId}`;
  const worktreePath = join(h.dataDir, "worktrees", taskId);
  const attemptId = insertDoneTask(h, repoId, taskId, worktreePath, branchName, tmuxId);

  const built = buildTickDeps(h);
  // PR is currently open on GitHub; remote branch exists; local branch
  // exists. Default `done` polling would see CI pass / closed PR / etc. and
  // misroute this task without the cancel-first guard.
  built.github.setPrIsOpen(repoId, branchName, true);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);

  // Crash AFTER `gh pr close` returns and AFTER the remote branch delete is
  // attempted, but BEFORE step 4's SQL terminal transition. The
  // `after_github_pr_close` failpoint is the spec-named boundary.
  setFailpoint("after_github_pr_close", () => {
    throw new Error("simulated crash after irreversible cleanup");
  });

  expect(() =>
    cancel_task(built.deps, { taskId, closePr: true }),
  ).toThrow(/simulated crash/);

  // Irreversible side effects landed: gh pr close called; PR no longer open.
  expect(built.github.closePrCalls).toEqual([
    { repoId, branch: branchName },
  ]);
  expect(built.github.prIsOpen(repoId, branchName)).toBe(false);

  // Mid-cancel SQL state: intent + flags durable; task still in `done`.
  const mid = h.db
    .query<
      {
        state: string;
        cancel_requested_at: string | null;
        cancel_close_pr: number;
      },
      [string]
    >(
      `SELECT state, cancel_requested_at, cancel_close_pr
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(mid!.state).toBe("done");
  expect(mid!.cancel_requested_at).not.toBeNull();
  expect(mid!.cancel_close_pr).toBe(1);

  // No `closed` (closed_unmerged) event has been or will be written — the
  // top-of-loop cancel finalizer runs first.
  const closedEventBefore = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND to_state = 'closed_unmerged'`,
    )
    .get(taskId);
  expect(closedEventBefore!.n).toBe(0);

  // Recovery: clear failpoint and run a tick.
  clearAllFailpoints();
  const tickResults = tick_once(built.deps);
  expect(tickResults).toEqual([{ task_id: taskId, action: "cancel_finalized" }]);

  // Terminal convergence to `cancelled` (NOT `closed_unmerged`).
  const final = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(final!.state).toBe("cancelled");

  // Recovery's gh pr close on the already-closed PR is idempotent. We don't
  // assert exact call counts on closePr (recovery may re-call it; either way
  // it's a no-op success).

  // Remote branch is deleted; local branch deleted; worktree gone.
  expect(built.git.remoteBranches.get(repoId)?.has(branchName) ?? false).toBe(
    false,
  );
  expect(built.git.localBranches.get(repoId)?.has(branchName) ?? false).toBe(
    false,
  );
  expect(built.git.worktrees.has(worktreePath)).toBe(false);

  // Cancel event recorded; closed_unmerged was never written.
  const cancelledEvent = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'cancelled'`,
    )
    .get(taskId);
  expect(cancelledEvent!.n).toBe(1);
  const closedEventAfter = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND to_state = 'closed_unmerged'`,
    )
    .get(taskId);
  expect(closedEventAfter!.n).toBe(0);

  // Original pr_opened exit_kind preserved on the historical attempt — the
  // cancellation is an event, not a synthesized attempt exit.
  const att = h.db
    .query<{ exit_kind: string | null; kill_intent: string | null }, [number]>(
      `SELECT exit_kind, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.exit_kind).toBe("pr_opened");
  expect(att!.kill_intent).toBeNull();
});

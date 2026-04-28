// Cancel from a parked state — `worktree_error`, `orchestrator_loop`,
// `non_budget_loop` (spec §15 case 29f, §5 cleanup matrix).
//
// Each parked state writes durable cancel intent, runs the canonical
// cancelled cleanup matrix (overriding the parked retention), and transitions
// to `cancelled`.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const PARKED_STATES = [
  "worktree_error",
  "orchestrator_loop",
  "non_budget_loop",
] as const;

function insertParkedTask(
  h: Harness,
  repoId: string,
  taskId: string,
  state: string,
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
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 5, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      state,
      branchName,
      tmuxId,
      worktreePath,
      "2026-04-28T08:00:00.000Z",
      "2026-04-28T09:00:00.000Z",
    );
  return insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:30:00.000Z",
  });
}

test("test_029f_cancel_parked_state_runs_cleanup", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-029f");

  const built = buildTickDeps(h);

  for (const state of PARKED_STATES) {
    const taskId = `task-029f-${state}`;
    const branchName = `quay/${taskId}`;
    const tmuxId = `tmux-${taskId}`;
    const worktreePath = join(h.dataDir, "worktrees", taskId);
    insertParkedTask(h, repoId, taskId, state, worktreePath, branchName, tmuxId);

    // Seed local + remote branches; no PR open → default cleanup deletes
    // everything per the cancelled row of the matrix.
    const local = new Set(built.git.localBranches.get(repoId) ?? []);
    local.add(branchName);
    built.git.setLocalBranches(repoId, Array.from(local));
    const remote = new Set(built.git.remoteBranches.get(repoId) ?? []);
    remote.add(branchName);
    built.git.setRemoteBranches(repoId, Array.from(remote));
    built.github.setPrIsOpen(repoId, branchName, false);

    const result = cancel_task(built.deps, { taskId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.outcome).toBe("cancelled");

    const row = h.db
      .query<
        {
          state: string;
          cancel_requested_at: string | null;
        },
        [string]
      >(
        `SELECT state, cancel_requested_at FROM tasks WHERE task_id = ?`,
      )
      .get(taskId);
    expect(row!.state).toBe("cancelled");
    expect(row!.cancel_requested_at).not.toBeNull();

    // Cleanup matrix applied: local + remote branches gone, worktree gone.
    expect(built.git.localBranches.get(repoId)?.has(branchName) ?? false).toBe(
      false,
    );
    expect(built.git.remoteBranches.get(repoId)?.has(branchName) ?? false).toBe(
      false,
    );
    expect(built.git.worktrees.has(worktreePath)).toBe(false);

    // Cancel event records the from-state for forensics.
    const ev = h.db
      .query<
        { from_state: string | null; to_state: string | null; n: number },
        [string]
      >(
        `SELECT from_state, to_state, COUNT(*) AS n FROM events
          WHERE task_id = ? AND event_type = 'cancelled'
          GROUP BY from_state, to_state`,
      )
      .all(taskId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.from_state).toBe(state);
    expect(ev[0]!.to_state).toBe("cancelled");
    expect(ev[0]!.n).toBe(1);
  }
});

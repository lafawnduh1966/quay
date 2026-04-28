import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertRepo,
  insertRunningTask,
  writeBlockerFile,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_spawn_window_null_session_uses_same_classifier", () => {
  h = createHarness();
  h.clock.set("2026-04-26T20:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-spawn-window");
  const worktreesRoot = join(h.dataDir, "worktrees");
  // Spawn-window crash: tmux_session is NULL but spawned_at is set. The
  // worker still managed to start and write a blocker before exiting.
  const t = insertRunningTask(h.db, {
    taskId: "task-spawn-window",
    repoId,
    worktreesRoot,
    tmuxSession: null,
  });
  const canonicalSession = `quay-task-${t.tmuxId}-${t.attemptNumber}`;

  const blockerBody = "Cannot proceed: missing config.\n";
  const blockerPath = writeBlockerFile(t.worktreePath, blockerBody);

  const built = buildTickDeps(h);
  // Simulate an orphan canonical-name session that survived the spawn crash.
  built.tmux.liveSessions.add(canonicalSession);

  const results = tick_once(built.deps);
  expect(results).toEqual([
    { task_id: t.taskId, action: "spawn_window_recovered" },
  ]);

  // Recovery killed the canonical orphan session before classifying.
  expect(built.tmux.killCalls).toContain(canonicalSession);

  // Same evidence classifier ran: blocker ingested, task to awaiting-next-brief.
  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task!.state).toBe("awaiting-next-brief");

  const arts = h.db
    .query<{ artifact_id: number }, [string, number]>(
      `SELECT artifact_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'blocker'`,
    )
    .all(t.taskId, t.attemptId);
  expect(arts).toHaveLength(1);

  const att = h.db
    .query<{ exit_kind: string | null }, [number]>(
      `SELECT exit_kind FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(att!.exit_kind).toBe("blocker_written");

  // Worktree file removed.
  expect(existsSync(blockerPath)).toBe(false);

  // No spawn_failed write — the unconditional rollback path was avoided.
  const evTypes = h.db
    .query<{ event_type: string }, [string]>(
      `SELECT event_type FROM events WHERE task_id = ?`,
    )
    .all(t.taskId)
    .map((r) => r.event_type);
  expect(evTypes).toContain("blocker_ingested");
  expect(evTypes).not.toContain("spawn_failed");
});

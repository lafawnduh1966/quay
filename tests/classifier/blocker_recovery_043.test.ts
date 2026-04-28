import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import {
  clearAllFailpoints,
  setFailpoint,
} from "../../src/core/failpoints.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertRepo,
  insertRunningTask,
  writeBlockerFile,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  clearAllFailpoints();
  h?.cleanup();
  h = null;
});

test("test_043_blocker_crash_after_artifact_write_converges", () => {
  h = createHarness();
  h.clock.set("2026-04-26T15:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-blocker-crash");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-blocker-crash",
    repoId,
    worktreesRoot,
  });

  const blockerBody = "Cannot proceed: schema mismatch.\n";
  const blockerPath = writeBlockerFile(t.worktreePath, blockerBody);

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);

  // Tick #1 crashes immediately after the blocker artifact is durably written
  // but before the state/event commit and file delete.
  setFailpoint("after_blocker_artifact_write", () => {
    throw new Error("simulated crash after blocker artifact write");
  });

  const first = tick_once(built.deps);
  expect(first).toHaveLength(1);
  expect(first[0]!.task_id).toBe(t.taskId);
  expect(first[0]!.action).toBe("tick_error");

  // Mid-state assertion: artifact row exists but no event/state transition.
  const partialArts = h.db
    .query<
      { artifact_id: number; content_hash: string | null },
      [string, number]
    >(
      `SELECT artifact_id, content_hash FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'blocker'`,
    )
    .all(t.taskId, t.attemptId);
  expect(partialArts).toHaveLength(1);
  const firstArtifactId = partialArts[0]!.artifact_id;

  let task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task!.state).toBe("running");

  let evCount = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
         WHERE task_id = ? AND event_type = 'blocker_ingested'`,
    )
    .get(t.taskId);
  expect(evCount!.n).toBe(0);

  // Worktree signal file is still on disk.
  expect(existsSync(blockerPath)).toBe(true);

  // Tick #2: failpoint cleared. Recovery reuses the artifact via content_hash,
  // writes the missing event/state, deletes the file.
  clearAllFailpoints();

  const second = tick_once(built.deps);
  expect(second).toEqual([{ task_id: t.taskId, action: "blocker_ingested" }]);

  // Exactly one blocker artifact row — the recovery did NOT insert a duplicate.
  const arts = h.db
    .query<{ artifact_id: number }, [string, number]>(
      `SELECT artifact_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'blocker'`,
    )
    .all(t.taskId, t.attemptId);
  expect(arts).toEqual([{ artifact_id: firstArtifactId }]);

  // State + event now applied.
  task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task!.state).toBe("awaiting-next-brief");

  const ev = h.db
    .query<
      { from_state: string | null; to_state: string | null; payload_artifact_id: number | null },
      [string]
    >(
      `SELECT from_state, to_state, payload_artifact_id FROM events
         WHERE task_id = ? AND event_type = 'blocker_ingested'`,
    )
    .all(t.taskId);
  expect(ev).toEqual([
    {
      from_state: "running",
      to_state: "awaiting-next-brief",
      payload_artifact_id: firstArtifactId,
    },
  ]);

  // File deleted.
  expect(existsSync(blockerPath)).toBe(false);
});

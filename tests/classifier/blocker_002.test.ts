import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

test("test_002_worker_blocker_transitions_to_awaiting_next_brief", () => {
  h = createHarness();
  h.clock.set("2026-04-26T13:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-blocker");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-blocker",
    repoId,
    worktreesRoot,
  });

  const blockerBody = "Cannot proceed: missing API contract.\n";
  const blockerPath = writeBlockerFile(t.worktreePath, blockerBody);

  const built = buildTickDeps(h);
  // Worker is dead — no live session.
  built.tmux.markDead(t.sessionName!);

  const results = tick_once(built.deps);

  expect(results).toEqual([{ task_id: t.taskId, action: "blocker_ingested" }]);

  // Task transitions to awaiting-next-brief; budget unchanged (no retry).
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >(`SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`)
    .get(t.taskId);
  expect(task!.state).toBe("awaiting-next-brief");
  expect(task!.attempts_consumed).toBe(1);

  // Attempt: exit_kind set, ended_at recorded.
  const att = h.db
    .query<
      { exit_kind: string | null; ended_at: string | null },
      [number]
    >(`SELECT exit_kind, ended_at FROM attempts WHERE attempt_id = ?`)
    .get(t.attemptId);
  expect(att!.exit_kind).toBe("blocker_written");
  expect(att!.ended_at).toBe("2026-04-26T13:00:00.000Z");

  // Blocker artifact: row exists, content matches, content_hash recorded.
  const arts = h.db
    .query<
      { artifact_id: number; file_path: string; content_hash: string | null },
      [string, number]
    >(
      `SELECT artifact_id, file_path, content_hash FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'blocker'`,
    )
    .all(t.taskId, t.attemptId);
  expect(arts).toHaveLength(1);
  expect(arts[0]!.content_hash).not.toBeNull();
  expect(readFileSync(arts[0]!.file_path, "utf8")).toBe(blockerBody);

  // Worktree signal file deleted after durable ingest.
  expect(existsSync(blockerPath)).toBe(false);

  // Exactly one blocker_ingested event, payload pointing at the artifact.
  const ev = h.db
    .query<
      {
        event_type: string;
        from_state: string | null;
        to_state: string | null;
        payload_artifact_id: number | null;
      },
      [string]
    >(
      `SELECT event_type, from_state, to_state, payload_artifact_id
         FROM events WHERE task_id = ? AND event_type = 'blocker_ingested'`,
    )
    .all(t.taskId);
  expect(ev).toEqual([
    {
      event_type: "blocker_ingested",
      from_state: "running",
      to_state: "awaiting-next-brief",
      payload_artifact_id: arts[0]!.artifact_id,
    },
  ]);

  // No retry attempt scheduled.
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
         WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(t.taskId);
  expect(pending!.n).toBe(0);
});

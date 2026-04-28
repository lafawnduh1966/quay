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

test("test_malformed_blocker_schedules_malformed_signal_retry", () => {
  h = createHarness();
  h.clock.set("2026-04-26T19:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-malformed");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-malformed",
    repoId,
    worktreesRoot,
  });

  // Whitespace-only body fails the spec's "non-empty after trim" rule.
  const malformedBody = "   \n\t  \n";
  const blockerPath = writeBlockerFile(t.worktreePath, malformedBody);

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "malformed_signal" }]);

  // Persisted as a malformed_signal artifact, raw bytes preserved.
  const arts = h.db
    .query<
      { file_path: string; content_hash: string | null },
      [string, number]
    >(
      `SELECT file_path, content_hash FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'malformed_signal'`,
    )
    .all(t.taskId, t.attemptId);
  expect(arts).toHaveLength(1);
  expect(arts[0]!.content_hash).not.toBeNull();
  expect(readFileSync(arts[0]!.file_path, "utf8")).toBe(malformedBody);

  // Worktree file deleted after durable ingest.
  expect(existsSync(blockerPath)).toBe(false);

  // Task back to queued; previous attempt marked crashed; budget consumption
  // deferred until the malformed_signal retry's promotion.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >(`SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`)
    .get(t.taskId);
  expect(task!.state).toBe("queued");
  expect(task!.attempts_consumed).toBe(1);

  const att = h.db
    .query<{ exit_kind: string | null }, [number]>(
      `SELECT exit_kind FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(att!.exit_kind).toBe("crashed");

  // Pending malformed_signal retry inserted with consumed_budget = 1.
  const pending = h.db
    .query<
      {
        attempt_number: number;
        reason: string;
        consumed_budget: number;
        spawned_at: string | null;
      },
      [string]
    >(
      `SELECT attempt_number, reason, consumed_budget, spawned_at
         FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .all(t.taskId);
  expect(pending).toEqual([
    {
      attempt_number: t.attemptNumber + 1,
      reason: "malformed_signal",
      consumed_budget: 1,
      spawned_at: null,
    },
  ]);
});

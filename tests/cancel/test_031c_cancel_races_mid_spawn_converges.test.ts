// Cancel races a tick that promoted a queued task and is in the middle of
// spawning tmux (spec §15 case 31c, §14 supervisor lock invariant).
//
// The supervisor lock serializes side effects: tick runs the substrate spawn
// to completion under the lock; cancel acquires after release; the cancel
// finalizer kills the freshly spawned worker before marking `cancelled`.
// This test exercises the lock-serialized path and asserts that no
// half-spawned state is observable from the outside.

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_031c_cancel_races_mid_spawn_converges", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-031c");
  const taskId = insertTask(h.db, { taskId: "task-031c", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  const branchName = `quay/${taskId}`;
  built.git.setRemoteHeadSha(repoId, branchName, null);
  built.github.setPrExists(repoId, branchName, false);
  built.github.setPrIsOpen(repoId, branchName, false);

  // Tick under the supervisor lock: promote queued → running, then perform
  // the substrate spawn (creating a live tmux session). Cancel cannot run
  // concurrently because the lock is held for the full cycle.
  const tickResults = tick_once(built.deps);
  expect(tickResults).toEqual([{ task_id: taskId, action: "spawned" }]);

  const sessionName = `quay-task-${
    h.db
      .query<{ tmux_id: string }, [string]>(
        `SELECT tmux_id FROM tasks WHERE task_id = ?`,
      )
      .get(taskId)!.tmux_id
  }-1`;
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(built.tmux.spawnCalls[0]!.sessionName).toBe(sessionName);
  expect(built.tmux.liveSessions.has(sessionName)).toBe(true);

  const afterTick = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(afterTick!.state).toBe("running");
  expect(afterTick!.attempts_consumed).toBe(1);

  // Now cancel acquires the supervisor lock (released by tick). The
  // finalizer kills the freshly spawned worker and marks cancelled.
  const result = cancel_task(built.deps, { taskId });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok");
  expect(result.value.outcome).toBe("cancelled");

  const final = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(final!.state).toBe("cancelled");

  // The freshly-spawned worker was killed before terminal SQL.
  expect(built.tmux.killCalls).toContain(sessionName);
  expect(built.tmux.liveSessions.has(sessionName)).toBe(false);

  const att = h.db
    .query<
      { exit_kind: string | null; ended_at: string | null; kill_intent: string | null },
      [number]
    >(
      `SELECT exit_kind, ended_at, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.exit_kind).toBe("killed_cancel");
  expect(att!.ended_at).not.toBeNull();
  expect(att!.kill_intent).toBeNull();

  const cancelledEvent = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'cancelled'`,
    )
    .get(taskId);
  expect(cancelledEvent!.n).toBe(1);
});

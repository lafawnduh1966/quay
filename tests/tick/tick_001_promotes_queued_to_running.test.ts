import { afterEach, expect, test } from "bun:test";
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

test("test_001_tick_promotes_queued_to_running", () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick");
  const taskId = insertTask(h.db, { taskId: "task-promote", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, "deadbeef");
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  const results = tick_once(built.deps);

  expect(results).toHaveLength(1);
  expect(results[0]).toEqual({ task_id: taskId, action: "spawned" });

  // tmux spawn happened with the canonical session name.
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const expectedSession = `quay-task-quay-task-${taskId}-1`;
  expect(built.tmux.spawnCalls[0]!.sessionName).toBe(expectedSession);

  // git side-effects: tolerant fetch then read remote head before promotion.
  // (`fetchBranchIfExists` is the right call because the first attempt's
  // `quay/<slug>` ref may not exist on origin yet.)
  expect(built.git.countCalls("fetchBranchIfExists")).toBe(1);
  expect(built.git.countCalls("remoteHeadSha")).toBe(1);

  // Task row transitioned, budget consumed exactly once.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >("SELECT state, attempts_consumed FROM tasks WHERE task_id = ?")
    .get(taskId);
  expect(task!.state).toBe("running");
  expect(task!.attempts_consumed).toBe(1);

  // Attempt row: spawned_at, remote_sha_at_spawn, pr_existed_at_spawn,
  // tmux_session all set.
  const att = h.db
    .query<
      {
        spawned_at: string | null;
        remote_sha_at_spawn: string | null;
        pr_existed_at_spawn: number;
        tmux_session: string | null;
      },
      [number]
    >(
      `SELECT spawned_at, remote_sha_at_spawn, pr_existed_at_spawn, tmux_session
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.spawned_at).toBe("2026-04-26T10:00:00.000Z");
  expect(att!.remote_sha_at_spawn).toBe("deadbeef");
  expect(att!.pr_existed_at_spawn).toBe(0);
  expect(att!.tmux_session).toBe(expectedSession);

  // A `spawned` event row exists for the promotion.
  const ev = h.db
    .query<
      {
        event_type: string;
        from_state: string | null;
        to_state: string | null;
        attempt_id: number | null;
      },
      [string]
    >(
      `SELECT event_type, from_state, to_state, attempt_id
         FROM events WHERE task_id = ? ORDER BY event_id`,
    )
    .all(taskId);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toEqual({
    event_type: "spawned",
    from_state: "queued",
    to_state: "running",
    attempt_id: attemptId,
  });
});

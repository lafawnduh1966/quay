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

// Regression: a brand-new task has no remote `quay/<slug>` branch yet (the
// worker pushes for the first time partway through the attempt). The tick
// flow used to call `git.fetch` unconditionally and surface git's normal
// "couldn't find remote ref" failure as a tick_error, blocking the very
// first spawn for every task. The tolerant `fetchBranchIfExists` lets that
// case fall through to `remoteHeadSha = null`, which is the spec's intended
// state for `remote_sha_at_spawn` on the first attempt.
let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("first_tick_spawns_when_remote_branch_does_not_yet_exist", () => {
  h = createHarness();
  h.clock.set("2026-04-26T11:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-no-remote-branch");
  const taskId = insertTask(h.db, { taskId: "task-fresh", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  // Deliberately do NOT seed a remote head — this models the fresh-enqueue
  // state where the worker hasn't pushed `quay/<slug>` yet. The fake's
  // `remoteHeadSha` returns null in that case.
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  const results = tick_once(built.deps);

  // The tick spawns; it does not fail with tick_error.
  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);

  // remote_sha_at_spawn is null per spec — first attempt, no remote yet.
  const att = h.db
    .query<{ remote_sha_at_spawn: string | null }, [number]>(
      `SELECT remote_sha_at_spawn FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.remote_sha_at_spawn).toBeNull();

  // Tolerant fetch was used — not the strict `fetch`.
  expect(built.git.countCalls("fetchBranchIfExists")).toBe(1);
  expect(built.git.countCalls("fetch")).toBe(0);
});

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

test("test_035_capacity_cap_prevents_extra_spawn", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-cap");
  const tasks = ["task-a", "task-b", "task-c"];
  for (const id of tasks) {
    insertTask(h.db, { taskId: id, repoId });
    const attemptId = insertAttempt(h.db, {
      taskId: id,
      attemptNumber: 1,
      reason: "initial",
      consumedBudget: 1,
    });
    insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, id, attemptId);
  }

  const built = buildTickDeps(h);
  for (const id of tasks) {
    built.git.setRemoteHeadSha(repoId, `quay/${id}`, null);
    built.github.setPrExists(repoId, `quay/${id}`, false);
  }

  const results = tick_once(built.deps, { maxConcurrent: 2 });

  expect(results).toHaveLength(3);
  const promoted = results.filter((r) => r.action === "spawned").length;
  const skipped = results.filter((r) => r.action === "skipped_capacity").length;
  expect(promoted).toBe(2);
  expect(skipped).toBe(1);

  // Exactly 2 tmux spawns happened — the third was capped.
  expect(built.tmux.spawnCalls).toHaveLength(2);
  expect(built.tmux.spawnAttempts).toHaveLength(2);

  // Capped task: still queued, no budget consumed, attempt still pending.
  const cappedRows = h.db
    .query<
      { state: string; attempts_consumed: number },
      []
    >(
      `SELECT state, attempts_consumed FROM tasks WHERE state = 'queued'`,
    )
    .all();
  expect(cappedRows).toHaveLength(1);
  expect(cappedRows[0]!.attempts_consumed).toBe(0);

  const cappedAttempts = h.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM attempts WHERE spawned_at IS NULL`,
    )
    .get();
  // The single capped task's attempt remains pending.
  expect(cappedAttempts!.n).toBe(1);

  // No git fetch / remote-head read happened for the capped task either —
  // capacity is checked before any external work.
  expect(built.git.countCalls("fetchBranchIfExists")).toBe(2);
  expect(built.git.countCalls("remoteHeadSha")).toBe(2);
});

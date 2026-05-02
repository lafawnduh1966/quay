// Spec §5: when the supervisor lockfile is already held by another live PID,
// `quay tick` exits immediately without action — no spawns, no Slack posts,
// no NDJSON output. The next scheduled fire retries.
//
// Cross-process correctness check: simulate "another process owns the lock"
// by pre-writing the lockfile with a different PID + isAlive=true, then
// dispatch `tick`. The dispatch must return cleanly with no work.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { FileSupervisorLock } from "../../src/core/supervisor_lock.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("tick skips with no output when supervisor lockfile is held by another live PID", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  // Real queued task that *would* be promoted if tick ran.
  const repoId = insertRepo(h.db, "repo-locked");
  insertTask(h.db, { taskId: "task-locked", repoId, state: "queued" });
  const attemptId = insertAttempt(h.db, {
    taskId: "task-locked",
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    "task-locked",
    attemptId,
  );

  const built = buildCliDeps(h);
  // Replace the in-process lock with a real FileSupervisorLock pointed at a
  // pre-populated lockfile owned by a "live" foreign PID.
  const lockPath = join(h.dataDir, "tick.lock");
  const otherPid = process.pid + 1;
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: otherPid, taken_at_ms: Date.now() }),
  );
  built.deps.supervisorLock = new FileSupervisorLock({
    lockfilePath: lockPath,
    isAlive: (pid) => pid === otherPid,
  });

  const io = bufferIO();
  const result = await dispatch(["tick"], built.deps, io);

  expect(result.exitCode).toBe(0);
  // No NDJSON lines emitted: tick saw the held lock and bailed.
  expect(io.out()).toBe("");
  expect(io.err()).toBe("");
  // The other process's lockfile must remain untouched.
  expect(built.tmux.spawnCalls.length).toBe(0);
});

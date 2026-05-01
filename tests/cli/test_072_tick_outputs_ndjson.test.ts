import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
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

test("test_072_tick_outputs_ndjson", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick");
  // Two queued tasks → two NDJSON lines, each independently parseable.
  for (const id of ["task-a", "task-b"]) {
    insertTask(h.db, { taskId: id, repoId, state: "queued" });
    const attemptId = insertAttempt(h.db, {
      taskId: id,
      attemptNumber: 1,
      reason: "initial",
      consumedBudget: 1,
    });
    insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, id, attemptId);
  }

  const built = buildCliDeps(h);
  built.git.setRemoteHeadSha(repoId, "quay/task-a", "sha-a");
  built.git.setRemoteHeadSha(repoId, "quay/task-b", "sha-b");
  built.github.setPrExists(repoId, "quay/task-a", false);
  built.github.setPrExists(repoId, "quay/task-b", false);

  const io = bufferIO();
  const result = await dispatch(["tick"], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");

  // NDJSON: trailing newline, no leading blank lines, no commas, no array wrapper.
  const out = io.out();
  expect(out.endsWith("\n")).toBe(true);
  expect(out.startsWith("[")).toBe(false);

  const lines = out.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(2);

  // Each line parses independently as a JSON object.
  const parsed = lines.map((l) => JSON.parse(l));
  for (const p of parsed) {
    expect(typeof p).toBe("object");
    expect(p).not.toBeNull();
    expect(typeof p.task_id).toBe("string");
    expect(typeof p.action).toBe("string");
  }
  const ids = parsed.map((p) => p.task_id).sort();
  expect(ids).toEqual(["task-a", "task-b"]);
});

test("test_072_tick_with_no_tasks_outputs_empty_stream", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["tick"], built.deps, io);
  expect(result.exitCode).toBe(0);
  // No NDJSON lines emitted means stdout is the empty string. (NDJSON has no
  // bracket wrapper, so the empty case is `""`, NOT `"[]\n"`.)
  expect(io.out()).toBe("");
  expect(io.err()).toBe("");
});

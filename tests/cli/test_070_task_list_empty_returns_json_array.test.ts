import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_070_task_list_empty_returns_json_array", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["task", "list"], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  // Empty match set must be `[]\n` — JSON array, not null/undefined/""/object.
  expect(io.out()).toBe("[]\n");
  const parsed = JSON.parse(io.out());
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toEqual([]);
});

test("test_070_task_list_with_rows_returns_json_array", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-list");
  insertTask(h.db, { taskId: "task-a", repoId, state: "queued" });
  insertTask(h.db, { taskId: "task-b", repoId, state: "running" });

  const built = buildCliDeps(h);
  const io = bufferIO();
  const result = await dispatch(["task", "list"], built.deps, io);

  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(io.out());
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(2);
  const ids = parsed.map((t: { task_id: string }) => t.task_id).sort();
  expect(ids).toEqual(["task-a", "task-b"]);
});

import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_cli_write_errors_are_json_objects", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  // Missing required fields -> QuayError(validation_error).
  const result = await dispatch(
    ["repo", "add", "--input", JSON.stringify({ repo_id: "" })],
    built.deps,
    io,
  );

  expect(result.exitCode).not.toBe(0);
  expect(io.out()).toBe("");
  // Error must be a single JSON object on stderr with an `error` key.
  const trimmed = io.err().trim();
  expect(trimmed.length).toBeGreaterThan(0);
  // No bare-string error: must parse as an object.
  const parsed = JSON.parse(trimmed);
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  expect(parsed.error).toBe("validation_error");
  expect(typeof parsed.message).toBe("string");
  expect(parsed.message.length).toBeGreaterThan(0);
});

test("test_cli_write_errors_cancel_unknown_task_is_json_object", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["cancel", "task-nope"], built.deps, io);

  expect(result.exitCode).not.toBe(0);
  expect(io.out()).toBe("");
  const parsed = JSON.parse(io.err().trim());
  expect(parsed.error).toBe("unknown_task");
  expect(parsed.task_id).toBe("task-nope");
});

test("test_cli_write_errors_unknown_command_is_json_object", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["bogus-command"], built.deps, io);

  expect(result.exitCode).not.toBe(0);
  const parsed = JSON.parse(io.err().trim());
  expect(parsed.error).toBe("usage_error");
  expect(typeof parsed.message).toBe("string");
});

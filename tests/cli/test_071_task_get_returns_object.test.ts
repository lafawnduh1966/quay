import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_071_task_get_returns_object", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-get");
  const taskId = insertTask(h.db, { taskId: "task-get", repoId, state: "queued" });
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run("GPRIVATE123:999.000000", taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  // Drop a state-transition event so the recent_events list isn't empty.
  h.db
    .query(
      `INSERT INTO events (task_id, event_type, from_state, to_state, occurred_at)
       VALUES (?, 'enqueued', NULL, 'queued', ?)`,
    )
    .run(taskId, "2026-01-01T00:00:00.000Z");

  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["task", "get", taskId], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");

  const parsed = JSON.parse(io.out());
  // Single object, NOT an array.
  expect(Array.isArray(parsed)).toBe(false);
  expect(typeof parsed).toBe("object");
  expect(parsed).not.toBeNull();
  expect(parsed.task_id).toBe(taskId);
  expect(parsed.state).toBe("queued");
  expect(parsed.repo_id).toBe(repoId);
  expect(parsed.slack_thread_ref).toBe("GPRIVATE123:999.000000");
  // Current attempt is the most recent attempt row for this task.
  expect(parsed.current_attempt).toBeDefined();
  expect(parsed.current_attempt.attempt_number).toBe(1);
  expect(parsed.current_attempt.reason).toBe("initial");
  // Recent events present and in newest-first order.
  expect(Array.isArray(parsed.recent_events)).toBe(true);
  expect(parsed.recent_events.length).toBeGreaterThan(0);
  expect(parsed.recent_events[0].event_type).toBe("enqueued");
});

test("test_071_task_get_unknown_emits_error_object_on_stderr", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["task", "get", "nope"], built.deps, io);

  expect(result.exitCode).toBe(1);
  expect(io.out()).toBe("");
  const parsed = JSON.parse(io.err());
  expect(parsed.error).toBe("unknown_task");
  expect(typeof parsed.message).toBe("string");
});

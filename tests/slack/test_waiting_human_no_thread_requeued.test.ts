import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("legacy waiting_human without a slack thread is requeued for orchestrator ownership", async () => {
  h = createHarness();
  h.clock.set("2026-05-14T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-waiting-no-thread");
  const taskId = insertTask(h.db, {
    taskId: "task-waiting-no-thread",
    repoId,
    state: "waiting_human",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-14T08:00:00.000Z",
  });

  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);

  expect(results).toContainEqual({
    task_id: taskId,
    action: "waiting_human_requeued",
  });
  expect(built.slack.totalCalls()).toBe(0);

  const task = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "awaiting-next-brief", claim_id: null });

  const handoff = h.db
    .query<{ reason: string; status: string; payload_json: string | null }, [string]>(
      `SELECT reason, status, payload_json
         FROM orchestrator_handoffs WHERE task_id = ?`,
    )
    .get(taskId);
  expect(handoff).toMatchObject({
    reason: "manual_resume",
    status: "pending",
  });
  expect(JSON.parse(handoff!.payload_json!)).toMatchObject({
    previous_state: "waiting_human",
    reason: "missing_slack_thread_ref",
  });
});

// Spec §15 case 47: if the Slack API fails before any post exists, the
// task remains `waiting_human`; the next tick retries; no tight loop runs
// inside one tick.

import { afterEach, expect, test } from "bun:test";
import { claim_task, escalate_human } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
  markWaitingHumanLegacy,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_047_slack_post_failure_retries_without_looping", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-047");
  const taskId = insertTask(h.db, {
    taskId: "task-047",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T08:00:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run("C047:0.1", taskId);

  const built = buildTickDeps(h);
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("nonce0047");
  const esc = await escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "down for retry?",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");
  markWaitingHumanLegacy(h.db, taskId);

  // Tick #1: Slack API throws. Tick logs tick_error and skips. No tight
  // loop: exactly one post attempt within this tick.
  built.slack.failPostOnce("rate_limited");
  const r1 = await tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);

  const tickErrorEvents = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'tick_error'`,
    )
    .get(taskId);
  expect(tickErrorEvents!.n).toBe(1);
  expect(
    r1.find((r) => r.task_id === taskId && r.action === "tick_error"),
  ).toBeDefined();

  // Task remains in waiting_human; no post timestamps recorded.
  const midTask = h.db
    .query<
      { state: string; tick_error: string | null },
      [string]
    >(`SELECT state, tick_error FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(midTask!.state).toBe("waiting_human");
  expect(midTask!.tick_error).not.toBeNull();

  const midArt = h.db
    .query<
      {
        slack_post_ts: string | null;
        slack_recovered_post_ts: string | null;
        slack_pre_post_fence_ts: string | null;
      },
      [number]
    >(
      `SELECT slack_post_ts, slack_recovered_post_ts, slack_pre_post_fence_ts
         FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(midArt!.slack_post_ts).toBeNull();
  expect(midArt!.slack_recovered_post_ts).toBeNull();
  // Fence was captured before the failed post — that's correct: a
  // subsequent tick reuses it as the fallback lower bound.
  expect(midArt!.slack_pre_post_fence_ts).not.toBeNull();

  // Tick #2: failure cleared, retry succeeds.
  const r2 = await tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(2);
  expect(
    r2.find((r) => r.task_id === taskId && r.action === "slack_posted"),
  ).toBeDefined();

  const finalArt = h.db
    .query<
      { slack_post_ts: string | null; slack_recovered_post_ts: string | null },
      [number]
    >(
      `SELECT slack_post_ts, slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(finalArt!.slack_post_ts).not.toBeNull();
  expect(finalArt!.slack_recovered_post_ts).toBe(finalArt!.slack_post_ts);

  // tick_error was cleared on the next successful tick.
  const finalTask = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(finalTask!.state).toBe("waiting_human");
  expect(finalTask!.tick_error).toBeNull();
});

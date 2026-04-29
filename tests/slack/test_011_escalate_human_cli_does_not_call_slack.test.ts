// Spec §15 case 11: `escalate-human` CLI is SQL/artifact-only — no Slack
// call. Tick is the single Slack writer; the post lands inside one tick
// interval of the CLI returning.

import { afterEach, expect, test } from "bun:test";
import { claim_task, escalate_human } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_011_escalate_human_cli_does_not_call_slack", () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-011");
  const taskId = insertTask(h.db, {
    taskId: "task-011",
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
    .run("C123:0.42", taskId);

  const built = buildTickDeps(h);

  // Claim + escalate via the CLI service path. No Slack API call should
  // occur during this phase.
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("nonce0011");
  const esc = escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "is this approach OK?",
    },
  );
  if (!esc.ok) throw new Error("expected escalation success");

  expect(built.slack.totalCalls()).toBe(0);

  const taskMid = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(taskMid!.state).toBe("waiting_human");
  expect(taskMid!.claim_id).toBeNull();

  const artBefore = h.db
    .query<
      { slack_post_ts: string | null; slack_recovered_post_ts: string | null },
      [number]
    >(
      `SELECT slack_post_ts, slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(artBefore!.slack_post_ts).toBeNull();
  expect(artBefore!.slack_recovered_post_ts).toBeNull();

  // Tick now performs the post under the supervisor lock.
  const results = tick_once(built.deps);

  expect(built.slack.fenceCalls).toHaveLength(1);
  expect(built.slack.searchCalls).toHaveLength(1);
  expect(built.slack.postCalls).toHaveLength(1);
  expect(built.slack.postCalls[0]!.threadRef).toBe("C123:0.42");
  expect(built.slack.postCalls[0]!.body).toContain("is this approach OK?");
  expect(built.slack.postCalls[0]!.body).toContain(esc.value.escalation_nonce);

  const actions = results
    .filter((r) => r.task_id === taskId)
    .map((r) => r.action);
  expect(actions).toContain("slack_fence_captured");
  expect(actions).toContain("slack_posted");

  const artAfter = h.db
    .query<
      { slack_post_ts: string | null; slack_recovered_post_ts: string | null },
      [number]
    >(
      `SELECT slack_post_ts, slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(artAfter!.slack_post_ts).not.toBeNull();
  expect(artAfter!.slack_recovered_post_ts).toBe(artAfter!.slack_post_ts);
});

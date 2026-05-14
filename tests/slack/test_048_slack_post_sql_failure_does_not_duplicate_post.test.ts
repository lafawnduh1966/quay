// Spec §15 case 48: Slack post accepted before SQL timestamp persistence
// is recovered by nonce on the next tick. A subsequent human reply is
// ingested. Exactly one Slack post is ever made.

import { afterEach, expect, test } from "bun:test";
import { claim_task, escalate_human } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { clearAllFailpoints, setFailpoint } from "../../src/core/failpoints.ts";
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
  clearAllFailpoints();
});

test("test_048_slack_post_sql_failure_does_not_duplicate_post", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-048");
  const taskId = insertTask(h.db, {
    taskId: "task-048",
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
    .run("C77:0.7", taskId);

  const built = buildTickDeps(h);
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("nonce0048");
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
      questionBody: "do we ship X or Y?",
    },
  );
  if (!esc.ok) throw new Error("expected escalation success");
  markWaitingHumanLegacy(h.db, taskId);

  // Tick #1: Slack accepts the post but persist crashes immediately after.
  setFailpoint("after_slack_post", () => {
    throw new Error("simulated crash after_slack_post");
  });
  await tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);
  setFailpoint("after_slack_post", null);

  // Tick #2: nonce recovery, no replies yet. Still waiting_human, no second
  // post made.
  await tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);
  const stillWaiting = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(stillWaiting!.state).toBe("waiting_human");

  // A human reply lands.
  const replyTs = built.slack.appendHumanReply("C77:0.7", "ship X");

  // Tick #3: ingest reply, transition to awaiting-next-brief.
  const r3 = await tick_once(built.deps);
  const actions3 = r3.filter((r) => r.task_id === taskId).map((r) => r.action);
  expect(actions3).toContain("slack_reply_ingested");

  expect(built.slack.postCalls).toHaveLength(1);

  const finalTask = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(finalTask!.state).toBe("awaiting-next-brief");

  const replyArt = h.db
    .query<
      { kind: string; content_hash: string | null; file_path: string },
      [string]
    >(
      `SELECT kind, content_hash, file_path FROM artifacts
        WHERE task_id = ? AND kind = 'slack_reply'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(replyArt).not.toBeNull();
  expect(replyArt!.content_hash).not.toBeNull();

  const ev = h.db
    .query<{ event_type: string; from_state: string; to_state: string }, [string]>(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'slack_reply_ingested'`,
    )
    .all(taskId);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toEqual({
    event_type: "slack_reply_ingested",
    from_state: "waiting_human",
    to_state: "awaiting-next-brief",
  });

  // The recovered ts is the bot post ts, not the reply ts.
  const tsRow = h.db
    .query<
      { slack_recovered_post_ts: string | null },
      [number]
    >(
      `SELECT slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(tsRow!.slack_recovered_post_ts).not.toBeNull();
  expect(tsRow!.slack_recovered_post_ts).not.toBe(replyTs);
});

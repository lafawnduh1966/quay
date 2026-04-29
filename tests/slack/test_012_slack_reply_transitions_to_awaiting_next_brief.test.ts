// Spec §15 case 12: tick polls a `waiting_human` task, ingests the first
// non-bot reply with `ts > lower_bound`, and transitions the task to
// `awaiting-next-brief` without pushing to the orchestrator (pull-only).

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

test("test_012_slack_reply_transitions_to_awaiting_next_brief", () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-012");
  const taskId = insertTask(h.db, {
    taskId: "task-012",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T08:00:00.000Z",
  });
  const THREAD = "C012:0.5";
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run(THREAD, taskId);

  const built = buildTickDeps(h);
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("nonce0012");
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
      questionBody: "ship?",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  // Tick #1: post.
  tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);

  // Human reply lands after the bot post.
  const replyText = "ship it now";
  const replyTs = built.slack.appendHumanReply(THREAD, replyText);
  // Sanity: reply ts is strictly greater than recovered post ts.
  const tsRow = h.db
    .query<
      { slack_recovered_post_ts: string | null },
      [number]
    >(
      `SELECT slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(Number(replyTs)).toBeGreaterThan(
    Number(tsRow!.slack_recovered_post_ts),
  );

  // Tick #2: ingest reply.
  const r2 = tick_once(built.deps);
  const actions = r2.filter((r) => r.task_id === taskId).map((r) => r.action);
  expect(actions).toContain("slack_reply_ingested");

  // No second post call.
  expect(built.slack.postCalls).toHaveLength(1);

  const finalTask = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(finalTask!.state).toBe("awaiting-next-brief");
  expect(finalTask!.claim_id).toBeNull();

  const replyArt = h.db
    .query<
      {
        kind: string;
        attempt_id: number | null;
        content_hash: string | null;
        file_path: string;
      },
      [string]
    >(
      `SELECT kind, attempt_id, content_hash, file_path
         FROM artifacts WHERE task_id = ? AND kind = 'slack_reply'
         ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(replyArt).not.toBeNull();
  expect(replyArt!.attempt_id).not.toBeNull();
  expect(replyArt!.content_hash).not.toBeNull();

  // The slack_reply event references the right artifact and transition.
  const ev = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
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
});

import { afterEach, expect, test } from "bun:test";
import {
  claim_task,
  escalate_human,
  record_human_reply,
  submit_brief,
} from "../../src/core/claims.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { enqueueOrchestratorHandoff } from "../../src/core/orchestrator_handoffs.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { FakeSlack } from "../support/fakes/slack.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_escalate_human_claim_transition_is_sql_only", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-escalate");
  const taskId = insertTask(h.db, {
    taskId: "task-escalate",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ?, claim_expirations_consecutive = 1 WHERE task_id = ?`)
    .run("C123:0.42", taskId);

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });
  const slack = new FakeSlack();
  h.ids.push("randompart"); // deterministic suffix in the nonce

  const result = await escalate_human(
    { db: h.db, clock: h.clock, artifactStore: store, ids: h.ids },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "is this approach OK?",
    },
  );
  if (!result.ok) throw new Error("expected escalation success");

  // Slack fake recorded zero calls — the orchestrator owns Slack transport.
  expect(slack.totalCalls()).toBe(0);

  // Task transitioned and the orchestrator claim remains live.
  const task = h.db
    .query<
      {
        state: string;
        claim_id: string | null;
        claimed_at: string | null;
        claim_expirations_consecutive: number;
        slack_thread_ref: string | null;
        next_escalation_seq: number;
      },
      [string]
    >(
      `SELECT state, claim_id, claimed_at, claim_expirations_consecutive,
              slack_thread_ref, next_escalation_seq
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("waiting_human");
  expect(task!.claim_id).toBe(claim.value.claim_id);
  expect(task!.claimed_at).not.toBeNull();
  expect(task!.claim_expirations_consecutive).toBe(0);
  expect(task!.slack_thread_ref).toBe("C123:0.42");
  expect(task!.next_escalation_seq).toBe(2);

  // Artifact carries seq + nonce + content_hash; Slack timestamps are NULL.
  const art = h.db
    .query<
      {
        kind: string;
        escalation_seq: number | null;
        escalation_nonce: string | null;
        content_hash: string | null;
        slack_pre_post_fence_ts: string | null;
        slack_post_ts: string | null;
        slack_recovered_post_ts: string | null;
      },
      [number]
    >(
      `SELECT kind, escalation_seq, escalation_nonce, content_hash,
              slack_pre_post_fence_ts, slack_post_ts, slack_recovered_post_ts
         FROM artifacts WHERE artifact_id = ?`,
    )
    .get(result.value.artifact_id);
  expect(art!.kind).toBe("slack_escalation_post");
  expect(art!.escalation_seq).toBe(1);
  expect(art!.escalation_nonce).toBe(result.value.escalation_nonce);
  expect(art!.escalation_nonce).toContain("quay-esc-");
  expect(art!.content_hash).not.toBeNull();
  expect(art!.slack_pre_post_fence_ts).toBeNull();
  expect(art!.slack_post_ts).toBeNull();
  expect(art!.slack_recovered_post_ts).toBeNull();

  const ev = h.db
    .query<
      { event_type: string; from_state: string | null; to_state: string | null },
      [string]
    >(
      `SELECT event_type, from_state, to_state
         FROM events WHERE task_id = ? AND event_type = 'human_escalated'`,
    )
    .all(taskId);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toEqual({
    event_type: "human_escalated",
    from_state: "claimed-by-orchestrator",
    to_state: "waiting_human",
  });
});

test("test_escalate_human_thread_ref_override_persists", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-escalate-override");
  const taskId = insertTask(h.db, {
    taskId: "task-escalate-override",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run("C123:0.1", taskId);

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });

  const result = await escalate_human(
    { db: h.db, clock: h.clock, artifactStore: store, ids: h.ids },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "override thread test",
      threadRef: "C999:0.42",
    },
  );
  if (!result.ok) throw new Error("expected escalation success");

  const task = h.db
    .query<{ slack_thread_ref: string | null }, [string]>(
      `SELECT slack_thread_ref FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.slack_thread_ref).toBe("C999:0.42");
});

test("test_orchestrator_owned_human_loop_records_reply_then_submits_brief", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-human-loop");
  const taskId = insertTask(h.db, {
    taskId: "task-human-loop",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });
  const eventId = insertAwaitingEvent(taskId, "blocker_ingested");
  enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId, reason: "worker_blocker", stateEventId: eventId },
  );

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });

  h.ids.push("nothread");
  const esc = await escalate_human(
    { db: h.db, clock: h.clock, artifactStore: store, ids: h.ids },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "Which fallback route should I use?",
    },
  );
  if (!esc.ok) throw new Error("expected escalation success");
  expect(esc.value.thread_ref).toBeNull();

  expect(singleHandoff(taskId)).toMatchObject({
    status: "claimed",
    claim_id: claim.value.claim_id,
  });

  const reply = await record_human_reply(
    { db: h.db, clock: h.clock, artifactStore: store },
    {
      taskId,
      claimId: claim.value.claim_id,
      replyBody: "Use the deployment fallback channel and proceed.",
      threadRef: "Cfallback:123.456",
      messageTs: "123.789",
      author: "U123",
    },
  );
  if (!reply.ok) throw new Error("expected reply record success");
  expect(reply.value.state).toBe("claimed-by-orchestrator");

  const replyEvent = h.db
    .query<{ event_type: string; from_state: string; to_state: string }, [string]>(
      `SELECT event_type, from_state, to_state
         FROM events WHERE task_id = ? AND event_type = 'human_reply_recorded'`,
    )
    .get(taskId);
  expect(replyEvent).toEqual({
    event_type: "human_reply_recorded",
    from_state: "waiting_human",
    to_state: "claimed-by-orchestrator",
  });

  const submitted = await submit_brief(
    { db: h.db, clock: h.clock, artifactStore: store },
    {
      taskId,
      claimId: claim.value.claim_id,
      brief: "Proceed using the fallback route the human approved.",
      reason: "advice_answered",
    },
  );
  if (!submitted.ok) throw new Error("expected submit success");

  const finalTask = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(finalTask).toEqual({ state: "queued", claim_id: null });
  expect(singleHandoff(taskId)).toMatchObject({
    status: "completed",
    claim_id: claim.value.claim_id,
  });

  const attempts = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget
         FROM attempts WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(attempts).toEqual({ reason: "advice_answered", consumed_budget: 0 });
});

function insertAwaitingEvent(taskId: string, eventType: string): number {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ event_id: number }, [string, string, string]>(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, ?, 'running', 'awaiting-next-brief', ?)
       RETURNING event_id`,
    )
    .get(taskId, eventType, h.clock.nowISO());
  if (!row) throw new Error("event insert returned no row");
  return row.event_id;
}

function singleHandoff(taskId: string) {
  if (!h) throw new Error("missing harness");
  const rows = h.db
    .query<{ status: string; claim_id: string | null }, [string]>(
      `SELECT status, claim_id
         FROM orchestrator_handoffs
        WHERE task_id = ?
        ORDER BY handoff_id`,
    )
    .all(taskId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

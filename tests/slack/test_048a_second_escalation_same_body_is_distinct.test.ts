// Spec §15 case 48a: a legitimate second escalation with the same question
// body gets a new sequence, nonce, content_hash, artifact, and Slack post —
// it is NOT deduped against the first by the recovery-path partial unique
// index.

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

test("test_048a_second_escalation_same_body_is_distinct", () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-048a");
  const taskId = insertTask(h.db, {
    taskId: "task-048a",
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
    .run("C48a:0.1", taskId);

  const built = buildTickDeps(h);

  const QUESTION = "are these constraints right?";

  // First escalation cycle.
  const claim1 = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim1.ok) throw new Error("expected claim 1");
  h.ids.push("first048a");
  const esc1 = escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
    },
    {
      taskId,
      claimId: claim1.value.claim_id,
      questionBody: QUESTION,
    },
  );
  if (!esc1.ok) throw new Error("expected escalate 1");
  expect(esc1.value.escalation_seq).toBe(1);

  tick_once(built.deps); // post #1
  built.slack.appendHumanReply("C48a:0.1", "yes ship it");
  tick_once(built.deps); // ingest reply → awaiting-next-brief

  const stateAfterIngest = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(stateAfterIngest!.state).toBe("awaiting-next-brief");
  expect(built.slack.postCalls).toHaveLength(1);

  // Second escalation cycle, same body.
  const claim2 = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim2.ok) throw new Error("expected claim 2");
  h.ids.push("second48a");
  const esc2 = escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
    },
    {
      taskId,
      claimId: claim2.value.claim_id,
      questionBody: QUESTION,
    },
  );
  if (!esc2.ok) throw new Error("expected escalate 2");

  expect(esc2.value.escalation_seq).toBe(2);
  expect(esc2.value.escalation_nonce).not.toBe(esc1.value.escalation_nonce);
  expect(esc2.value.artifact_id).not.toBe(esc1.value.artifact_id);

  // Distinct artifact rows with distinct content hashes (hash includes
  // seq + nonce, so identical body still hashes differently).
  const artifacts = h.db
    .query<
      {
        artifact_id: number;
        escalation_seq: number | null;
        escalation_nonce: string | null;
        content_hash: string | null;
      },
      [string]
    >(
      `SELECT artifact_id, escalation_seq, escalation_nonce, content_hash
         FROM artifacts WHERE task_id = ? AND kind = 'slack_escalation_post'
         ORDER BY artifact_id`,
    )
    .all(taskId);
  expect(artifacts).toHaveLength(2);
  expect(artifacts[0]!.escalation_seq).toBe(1);
  expect(artifacts[1]!.escalation_seq).toBe(2);
  expect(artifacts[0]!.content_hash).not.toBe(artifacts[1]!.content_hash);
  expect(artifacts[0]!.escalation_nonce).not.toBe(artifacts[1]!.escalation_nonce);

  // Tick again to perform the second post.
  tick_once(built.deps);

  expect(built.slack.postCalls).toHaveLength(2);
  expect(built.slack.postCalls[0]!.body).toContain(esc1.value.escalation_nonce);
  expect(built.slack.postCalls[1]!.body).toContain(esc2.value.escalation_nonce);
});

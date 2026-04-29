// Spec §15 case 11b: a tick that posts to Slack but crashes before
// persisting the timestamp is recovered by the next tick's nonce-based
// search. No second post is ever made; `slack_recovered_post_ts` is filled
// from the existing bot message.

import { afterEach, expect, test } from "bun:test";
import { claim_task, escalate_human } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { clearAllFailpoints, setFailpoint } from "../../src/core/failpoints.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
  clearAllFailpoints();
});

test("test_011b_tick_recovers_posted_slack_message_by_nonce", () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-011b");
  const taskId = insertTask(h.db, {
    taskId: "task-011b",
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
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("nonce011b");
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

  // Crash immediately after Slack returns ts but before SQL persistence.
  setFailpoint("after_slack_post", () => {
    throw new Error("simulated crash after_slack_post");
  });

  // Tick #1 — Slack accepts the post; the failpoint kills the persist phase.
  const r1 = tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);
  // Slack records the bot message even though we crashed before SQL persist.
  expect(r1.find((r) => r.task_id === taskId && r.action === "tick_error"))
    .toBeDefined();

  const artMid = h.db
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
  expect(artMid!.slack_post_ts).toBeNull();
  expect(artMid!.slack_recovered_post_ts).toBeNull();
  expect(artMid!.slack_pre_post_fence_ts).not.toBeNull();

  // Disable the failpoint so the next tick proceeds normally.
  setFailpoint("after_slack_post", null);

  // Tick #2 — recovery via nonce. Must NOT repost.
  const r2 = tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);
  expect(built.slack.searchCalls.length).toBeGreaterThanOrEqual(2);
  const actions2 = r2.filter((r) => r.task_id === taskId).map((r) => r.action);
  expect(actions2).toContain("slack_post_recovered");

  const artAfter = h.db
    .query<
      {
        slack_post_ts: string | null;
        slack_recovered_post_ts: string | null;
      },
      [number]
    >(
      `SELECT slack_post_ts, slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(artAfter!.slack_recovered_post_ts).not.toBeNull();
  expect(artAfter!.slack_post_ts).toBe(artAfter!.slack_recovered_post_ts);

  // Task is still waiting_human until a non-bot reply lands.
  const stateAfter = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(stateAfter!.state).toBe("waiting_human");
});

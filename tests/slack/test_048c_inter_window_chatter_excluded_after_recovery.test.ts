// Spec §15 case 48c: once the actual bot-post timestamp is recovered,
// thread chatter that landed between the pre-post fence and the bot post is
// excluded from reply ingestion. Only replies with `ts > recovered_ts`
// qualify.

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

test("test_048c_inter_window_chatter_excluded_after_recovery", () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-048c");
  const taskId = insertTask(h.db, {
    taskId: "task-048c",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T08:00:00.000Z",
  });
  const THREAD = "C48c:0.1";
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run(THREAD, taskId);

  const built = buildTickDeps(h);
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("nonce048c");
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
      questionBody: "thread cursor regression",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  // Tick #1: the search call throws, so this tick captures the fence but
  // fails before posting. Lets us inject inter-window chatter before the
  // post on the next tick.
  built.slack.failSearchOnce();
  tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(0);

  const fenceTs = h.db
    .query<
      { slack_pre_post_fence_ts: string | null },
      [number]
    >(
      `SELECT slack_pre_post_fence_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(fenceTs!.slack_pre_post_fence_ts).not.toBeNull();

  // Inter-window chatter — lands AFTER the fence read, but BEFORE the bot
  // post. With the fake's monotonic ts counter, both messages land at ts
  // values strictly greater than the fence and strictly less than the
  // upcoming post.
  const chatterTs1 = built.slack.appendHumanReply(THREAD, "drive-by comment 1");
  const chatterTs2 = built.slack.appendHumanReply(THREAD, "drive-by comment 2");
  expect(Number(chatterTs1)).toBeGreaterThan(Number(fenceTs!.slack_pre_post_fence_ts));
  expect(Number(chatterTs2)).toBeGreaterThan(Number(chatterTs1));

  // Tick #2: post + persist (no failures this time).
  tick_once(built.deps);
  expect(built.slack.postCalls).toHaveLength(1);

  const tsAfterPost = h.db
    .query<
      { slack_recovered_post_ts: string | null },
      [number]
    >(
      `SELECT slack_recovered_post_ts FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(tsAfterPost!.slack_recovered_post_ts).not.toBeNull();
  // The recovered ts MUST be after the inter-window chatter.
  expect(Number(tsAfterPost!.slack_recovered_post_ts)).toBeGreaterThan(
    Number(chatterTs2),
  );

  // Tick #3: should not ingest any of the chatter — they all sit at ts <
  // recovered_ts. Task stays in waiting_human.
  tick_once(built.deps);
  const stateMid = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(stateMid!.state).toBe("waiting_human");
  const replyArts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'slack_reply'`,
    )
    .get(taskId);
  expect(replyArts!.n).toBe(0);

  // Confirm reply polling used the recovered ts as the lower bound.
  const lastListCall = built.slack.listCalls.at(-1);
  expect(lastListCall).toBeDefined();
  expect(lastListCall!.lowerBoundTs).toBe(tsAfterPost!.slack_recovered_post_ts!);

  // Now a real human reply lands after the bot post.
  const realReplyTs = built.slack.appendHumanReply(THREAD, "looks good");
  expect(Number(realReplyTs)).toBeGreaterThan(
    Number(tsAfterPost!.slack_recovered_post_ts),
  );

  // Tick #4: ingest only the real reply.
  tick_once(built.deps);
  const stateFinal = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(stateFinal!.state).toBe("awaiting-next-brief");

  const replyArt = h.db
    .query<
      { file_path: string },
      [string]
    >(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'slack_reply'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(replyArt).not.toBeNull();
  // Only one slack_reply was ingested.
  const replyCount = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'slack_reply'`,
    )
    .get(taskId);
  expect(replyCount!.n).toBe(1);
});

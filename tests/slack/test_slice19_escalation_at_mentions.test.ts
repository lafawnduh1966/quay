// Spec deployment-adapters §15 feature 3: when a task carries
// `tasks.authors_json` (populated by the `--linear-issue` adapter path),
// tick prepends `<@U...>` mentions to the Slack escalation body so the
// original ticket contributors get pinged. Tasks enqueued via the legacy
// `--brief-file` path keep `authors_json IS NULL` and post the original
// body unchanged.

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

interface Setup {
  taskId: string;
  threadRef: string;
  artifactId: number;
  escalationNonce: string;
  built: ReturnType<typeof buildTickDeps>;
}

async function setupEscalation(opts: {
  slug: string;
  authorsJson: string | null;
  questionBody?: string;
}): Promise<Setup> {
  if (!h) throw new Error("harness not initialized");
  const repoId = insertRepo(h.db, `repo-${opts.slug}`);
  const taskId = insertTask(h.db, {
    taskId: `task-${opts.slug}`,
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T08:00:00.000Z",
  });
  const threadRef = `C${opts.slug}:0.1`;
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run(threadRef, taskId);
  h.db
    .query(`UPDATE tasks SET authors_json = ? WHERE task_id = ?`)
    .run(opts.authorsJson, taskId);

  const built = buildTickDeps(h);
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push(`nonce-${opts.slug}`);
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
      questionBody: opts.questionBody ?? "ship?",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");
  markWaitingHumanLegacy(h.db, taskId);

  return {
    taskId,
    threadRef,
    artifactId: esc.value.artifact_id,
    escalationNonce: esc.value.escalation_nonce,
    built,
  };
}

test("test_slack_escalation_at_mentions_authors_when_authors_json_set", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const authors = JSON.stringify([
    { name: "Fabian", slack_id: "U06TDC56VJB" },
    { name: "Marvin", slack_id: "U07ABCDE" },
  ]);
  const s = await setupEscalation({ slug: "s19a", authorsJson: authors });

  await tick_once(s.built.deps);

  expect(s.built.slack.postCalls).toHaveLength(1);
  const body = s.built.slack.postCalls[0]!.body;
  expect(body.startsWith("<@U06TDC56VJB> <@U07ABCDE>\n\n")).toBe(true);
  // Original escalation body still present after the mention prefix.
  expect(body).toContain("ship?");
});

test("test_slack_escalation_no_mentions_when_authors_json_null", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const s = await setupEscalation({ slug: "s19b", authorsJson: null });

  await tick_once(s.built.deps);

  expect(s.built.slack.postCalls).toHaveLength(1);
  const body = s.built.slack.postCalls[0]!.body;
  expect(body).not.toContain("<@");
  expect(body.startsWith("ship?")).toBe(true);
});

test("test_slack_escalation_drops_malformed_slack_ids", async () => {
  // `authors_json` is opaque text in the DB — the parser validates on write,
  // but a tampered or future-malformed payload must not reach Slack mrkdwn.
  // IDs that fail the bare `^U[A-Z0-9]+$` shape are silently skipped at the
  // sink; the prefix is built from the survivors only.
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const authors = JSON.stringify([
    { name: "ok", slack_id: "U06TDC56VJB" },
    { name: "channel-injection", slack_id: "!channel" }, // would render <@!channel>
    { name: "lowercase-prefix", slack_id: "u123abc" }, // wrong case
    { name: "trailing-bracket", slack_id: "U123>" }, // tries to close mrkdwn early
    { name: "empty", slack_id: "" },
    { name: "ok-2", slack_id: "U07ABCDE" },
  ]);
  const s = await setupEscalation({ slug: "s19-malformed", authorsJson: authors });

  await tick_once(s.built.deps);

  expect(s.built.slack.postCalls).toHaveLength(1);
  const body = s.built.slack.postCalls[0]!.body;
  expect(body.startsWith("<@U06TDC56VJB> <@U07ABCDE>\n\n")).toBe(true);
  expect(body).not.toContain("!channel");
  expect(body).not.toContain("u123abc");
  expect(body).not.toContain("U123>");
});

test("test_slack_escalation_dedupes_duplicate_slack_ids", async () => {
  // Two author entries pointing at the same Slack user must produce one
  // mention, not two — the rendered body would otherwise ping the same
  // human twice.
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const authors = JSON.stringify([
    { name: "Fabian (lead)", slack_id: "U06TDC56VJB" },
    { name: "Fabian (alt)", slack_id: "U06TDC56VJB" },
    { name: "Marvin", slack_id: "U07ABCDE" },
  ]);
  const s = await setupEscalation({ slug: "s19-dupe", authorsJson: authors });

  await tick_once(s.built.deps);

  const body = s.built.slack.postCalls[0]!.body;
  expect(body.startsWith("<@U06TDC56VJB> <@U07ABCDE>\n\n")).toBe(true);
  expect(body.match(/U06TDC56VJB/g)?.length).toBe(1);
});

test("test_slack_escalation_no_mentions_when_authors_json_empty_array", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const s = await setupEscalation({ slug: "s19c", authorsJson: "[]" });

  await tick_once(s.built.deps);

  expect(s.built.slack.postCalls).toHaveLength(1);
  const body = s.built.slack.postCalls[0]!.body;
  expect(body).not.toContain("<@");
  expect(body.startsWith("ship?")).toBe(true);
});

test("test_slack_escalation_existing_fence_capture_unchanged", async () => {
  const authors = JSON.stringify([{ name: "Fabian", slack_id: "U06TDC56VJB" }]);

  for (const [slug, authorsJson] of [
    ["s19d-null", null],
    ["s19d-set", authors],
  ] as const) {
    h?.cleanup();
    h = createHarness();
    h.clock.set("2026-04-29T10:00:00.000Z");
    const s = await setupEscalation({ slug, authorsJson });

    await tick_once(s.built.deps);

    const art = h.db
      .query<{ slack_pre_post_fence_ts: string | null }, [number]>(
        `SELECT slack_pre_post_fence_ts FROM artifacts WHERE artifact_id = ?`,
      )
      .get(s.artifactId);
    expect(art!.slack_pre_post_fence_ts).not.toBeNull();
    expect(s.built.slack.fenceCalls).toContain(s.threadRef);
  }
});

test("test_slack_escalation_existing_recovery_probe_unchanged", async () => {
  const authors = JSON.stringify([{ name: "Fabian", slack_id: "U06TDC56VJB" }]);

  for (const [slug, authorsJson] of [
    ["s19e-null", null],
    ["s19e-set", authors],
  ] as const) {
    h?.cleanup();
    h = createHarness();
    h.clock.set("2026-04-29T10:00:00.000Z");
    const s = await setupEscalation({ slug, authorsJson });

    // Crash after Slack accepts the post but before SQL persistence.
    setFailpoint("after_slack_post", () => {
      throw new Error("simulated crash");
    });
    await tick_once(s.built.deps);
    setFailpoint("after_slack_post", null);

    const searchBefore = s.built.slack.searchCalls.length;
    // Tick again — recovery probe runs and matches by nonce. No second post.
    const r = await tick_once(s.built.deps);
    const searchAfter = s.built.slack.searchCalls.length;
    expect(searchAfter).toBeGreaterThan(searchBefore);
    expect(s.built.slack.postCalls).toHaveLength(1);
    const actions = r.filter((x) => x.task_id === s.taskId).map((x) => x.action);
    expect(actions).toContain("slack_post_recovered");
  }
});

test("test_slack_escalation_existing_reply_ingestion_unchanged", async () => {
  const authors = JSON.stringify([{ name: "Fabian", slack_id: "U06TDC56VJB" }]);

  for (const [slug, authorsJson] of [
    ["s19f-null", null],
    ["s19f-set", authors],
  ] as const) {
    h?.cleanup();
    h = createHarness();
    h.clock.set("2026-04-29T10:00:00.000Z");
    const s = await setupEscalation({ slug, authorsJson });

    // Tick #1: post.
    await tick_once(s.built.deps);
    expect(s.built.slack.postCalls.length).toBeGreaterThanOrEqual(1);

    s.built.slack.appendHumanReply(s.threadRef, "go ahead");

    // Tick #2: ingest.
    const r = await tick_once(s.built.deps);
    const actions = r.filter((x) => x.task_id === s.taskId).map((x) => x.action);
    expect(actions).toContain("slack_reply_ingested");

    const finalTask = h.db
      .query<{ state: string }, [string]>(
        `SELECT state FROM tasks WHERE task_id = ?`,
      )
      .get(s.taskId);
    expect(finalTask!.state).toBe("awaiting-next-brief");

    const replyArt = h.db
      .query<{ kind: string }, [string]>(
        `SELECT kind FROM artifacts WHERE task_id = ? AND kind = 'slack_reply'`,
      )
      .get(s.taskId);
    expect(replyArt).not.toBeNull();
  }
});

test("test_slack_escalation_mention_prefix_preserves_escalation_nonce", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");
  const authors = JSON.stringify([
    { name: "Fabian", slack_id: "U06TDC56VJB" },
    { name: "Marvin", slack_id: "U07ABCDE" },
  ]);
  const s = await setupEscalation({ slug: "s19g", authorsJson: authors });

  await tick_once(s.built.deps);

  expect(s.built.slack.postCalls).toHaveLength(1);
  const body = s.built.slack.postCalls[0]!.body;
  expect(body).toContain("<@U06TDC56VJB>");
  expect(body).toContain("<@U07ABCDE>");
  // Italic-footer nonce is still present so the recovery probe can match.
  expect(body).toContain(`_${s.escalationNonce}_`);
});

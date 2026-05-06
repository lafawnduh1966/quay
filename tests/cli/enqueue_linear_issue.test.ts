// Slice 16 — `quay enqueue --linear-issue` end-to-end. Adapters spec §3
// (atomicity), §8 (CLI behavior), §11 (validator integration), §12
// (failure modes), §13 (worked example).
//
// Tests below match the slice-16 expected_tests gate names verbatim.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { SpawnedValidatorRunner } from "../../src/core/validator_runner.ts";
import type { LinearIssue } from "../../src/ports/linear.ts";
import type { SlackThreadMessage } from "../../src/ports/slack.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
const scratchDirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  h = null;
  for (const d of scratchDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "quay-enq-li-"));
  scratchDirs.push(d);
  return d;
}

function writeTemp(contents: string, name = "f.md"): string {
  const dir = tempDir();
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

const FENCE = "```";
const REPO_ID = "repo-li";
const SLACK_URL = "https://inverter.slack.com/archives/C0123ABC/p1700000123000001";
const SLACK_THREAD_REF = "C0123ABC:1700000123.000001";

interface BlockOpts {
  repo?: string;
  tags?: string[];
  slack_thread?: string | null;
  authors?: { name: string; slack_id: string }[];
}

function quayConfigBlock(opts: BlockOpts = {}): string {
  const repo = opts.repo ?? REPO_ID;
  const tags = opts.tags ?? ["auth-session", "cache"];
  const authors = opts.authors ?? [
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
    { name: "Marvin Gross", slack_id: "U07ABCDEFGH" },
  ];
  const lines: string[] = [`${FENCE}quay-config`, `repo: ${repo}`, "tags:"];
  for (const t of tags) lines.push(`  - ${t}`);
  if (opts.slack_thread !== null && opts.slack_thread !== undefined) {
    lines.push(`slack_thread: ${opts.slack_thread}`);
  }
  lines.push("authors:");
  for (const a of authors) {
    lines.push(`  - name: ${a.name}`);
    lines.push(`    slack_id: ${a.slack_id}`);
  }
  lines.push(FENCE);
  return lines.join("\n");
}

// Linear ticket bodies must be long enough to satisfy the validator's
// shipped-default `body.min_length = 10`. Default body comfortably exceeds it.
function makeIssue(opts: { identifier?: string; block?: BlockOpts; body?: string } = {}): LinearIssue {
  const identifier = opts.identifier ?? "ENG-1276";
  const blockText = quayConfigBlock(opts.block ?? {});
  const body =
    opts.body ??
    `## Context\n\nWe're seeing stale auth sessions when multiple devices invalidate the cache concurrently. Need to nail down the invalidation propagation timing.\n\n${blockText}\n`;
  return {
    identifier,
    url: `https://linear.app/inverter/issue/${identifier}`,
    title: "Cache invalidation under concurrent updates",
    body,
    comments: [],
  };
}

function configureSlackThread(slackFake: ReturnType<typeof buildCliDeps>["slack"]): void {
  const parent: SlackThreadMessage = {
    ts: "1700000123.000001",
    authorBot: false,
    authorName: "Fabian Scherer",
    text: "Original ask: cache invalidation timing under concurrent writes?",
  };
  const replies: SlackThreadMessage[] = [
    {
      ts: "1700000200.000001",
      authorBot: false,
      authorName: "Marvin Gross",
      text: "Read replicas same-tick or eventual?",
    },
  ];
  slackFake.configureThreadContext(SLACK_THREAD_REF, parent, replies);
}

async function addRepo(built: ReturnType<typeof buildCliDeps>): Promise<void> {
  const r = await dispatch(
    [
      "repo",
      "add",
      "--id",
      REPO_ID,
      "--url",
      "git@example.com:owner/r.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  expect(r.exitCode).toBe(0);
  // Quay is a pure consumer of bare clones; the operator (or, here, the
  // test) must materialize the clone before enqueuing.
  built.git.seedBareClone(REPO_ID);
}

// ---------------------------------------------------------------------------

test("test_enqueue_linear_issue_end_to_end", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      identifier: "ENG-1276",
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: SLACK_URL,
        authors: [
          { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
          { name: "Marvin Gross", slack_id: "U07ABCDEFGH" },
        ],
      },
    }),
  );
  configureSlackThread(built.slack);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  expect(typeof enqResult.task_id).toBe("string");
  expect(enqResult.state).toBe("queued");
  expect(typeof enqResult.attempt_id).toBe("number");
  expect(typeof enqResult.branch_name).toBe("string");
  expect(typeof enqResult.tmux_id).toBe("string");
  expect(typeof enqResult.worktree_path).toBe("string");

  // Adapters were exercised.
  expect(built.linear.getIssueCalls).toContain("ENG-1276");
  expect(built.slack.fetchThreadContextCalls).toContain(SLACK_THREAD_REF);
  expect(built.validatorRunner.runCalls).toHaveLength(1);

  // Task row carries the adapter-derived fields.
  const taskRow = h.db
    .query<
      { external_ref: string | null; slack_thread_ref: string | null; authors_json: string | null },
      [string]
    >(
      `SELECT external_ref, slack_thread_ref, authors_json FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(taskRow?.external_ref).toBe("ENG-1276");
  expect(taskRow?.slack_thread_ref).toBe(SLACK_THREAD_REF);
  expect(taskRow?.authors_json).not.toBeNull();
  const authors = JSON.parse(taskRow!.authors_json!);
  expect(authors).toEqual([
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
    { name: "Marvin Gross", slack_id: "U07ABCDEFGH" },
  ]);

  // Two task_tags rows, one per block tag.
  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(enqResult.task_id);
  expect(tags.map((r) => r.tag)).toEqual(["auth-session", "cache"]);
});

test("test_enqueue_linear_issue_validation_failure_writes_no_db_state", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(makeIssue());
  built.validatorRunner.setInvalid([
    { field: "tags", code: "MIN_COUNT", message: "tags must contain at least 1 entries" },
  ]);

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).not.toBe(0);
  // Validator errors[] are surfaced verbatim on stdout per spec §11 step 3.
  const out = JSON.parse(io.out().trim());
  expect(out.valid).toBe(false);
  expect(Array.isArray(out.errors)).toBe(true);
  expect(out.errors[0].code).toBe("MIN_COUNT");

  // No DB writes (atomicity §3).
  const taskCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(taskCount?.n).toBe(0);
  const tagCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_tags`)
    .get();
  expect(tagCount?.n).toBe(0);
  const artifactCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM artifacts`)
    .get();
  expect(artifactCount?.n).toBe(0);
});

test("test_enqueue_linear_issue_combines_with_cli_tags", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--tag",
      "urgent",
      "--tag",
      "cache", // dupe with block — should dedupe
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());

  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(enqResult.task_id);
  // Block tags ∪ CLI tags, deduped, alphabetically (ORDER BY tag).
  expect(tags.map((r) => r.tag)).toEqual(["auth-session", "cache", "urgent"]);
});

test("test_enqueue_linear_issue_normalizes_block_and_cli_tag_case", async () => {
  // Block tags `Auth-Session` / CLI tag `URGENT` must converge to the
  // canonical lower-case set the validator and the `tasks` table expect.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["Auth-Session", "Cache"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--tag",
      "URGENT",
      "--tag",
      "CACHE",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());

  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(enqResult.task_id);
  expect(tags.map((r) => r.tag)).toEqual(["auth-session", "cache", "urgent"]);
});

test("test_enqueue_linear_issue_forwards_merged_tags_to_validator", async () => {
  // Block + CLI tags must reach the validator as one merged, lower-cased,
  // exact-deduped list — so the schema's charset/count rules apply
  // uniformly to everything that ends up persisted, not just the block.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["Auth-Session", "cache"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--tag",
      "URGENT",
      "--tag",
      "Cache",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);

  expect(built.validatorRunner.runCalls).toHaveLength(1);
  const sent = built.validatorRunner.runCalls[0]!.payload as {
    tags: string[];
  };
  expect(sent.tags).toEqual(["auth-session", "cache", "urgent"]);
});

test("test_enqueue_linear_issue_idempotent_on_external_ref", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const ioA = bufferIO();
  const a = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    ioA,
  );
  expect(a.exitCode).toBe(0);
  const first = JSON.parse(ioA.out().trim());

  const ioB = bufferIO();
  const b = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    ioB,
  );
  expect(b.exitCode).toBe(0);
  const second = JSON.parse(ioB.out().trim());

  expect(second.task_id).toBe(first.task_id);
  // Only one task, one set of tags, in the DB.
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(1);
});

test("test_enqueue_linear_issue_mutually_exclusive_with_brief_file", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const briefPath = writeTemp("ignored", "brief.md");

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--brief-file",
      briefPath,
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("usage_error");
  // No adapter call, no DB write.
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.validatorRunner.runCalls).toEqual([]);
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
});

test("test_enqueue_linear_issue_mutually_exclusive_with_external_ref", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--external-ref",
      "FOO-99",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("usage_error");
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.validatorRunner.runCalls).toEqual([]);
});

test("test_enqueue_linear_issue_mutually_exclusive_with_slack_thread_ref", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      REPO_ID,
      "--linear-issue",
      "ENG-1276",
      "--slack-thread-ref",
      "C111:222.333",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("usage_error");
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.validatorRunner.runCalls).toEqual([]);
});

test("test_enqueue_linear_issue_atomicity_failure_before_substrate", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.set5xx("ENG-1276", "linear is sad");

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("adapter_error");

  // Atomicity: no substrate side-effects started.
  // No DB rows.
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
  const tags = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_tags`)
    .get();
  expect(tags?.n).toBe(0);
  // No git substrate calls — dispatch failed before enqueue ran.
  expect(built.git.countCalls("fetch")).toBe(0);
  expect(built.git.countCalls("worktreeAdd")).toBe(0);
  // No worktree directory (should not have been created).
  expect(existsSync(join(built.worktreesRoot, "ENG-1276"))).toBe(false);
  // Validator never invoked.
  expect(built.validatorRunner.runCalls).toEqual([]);
});

test("test_enqueue_linear_issue_validator_payload_passes_authors_through", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  const authors = [
    { name: "Primary", slack_id: "U001ABCDE" },
    { name: "Second", slack_id: "U002ABCDE" },
    { name: "Third", slack_id: "U003ABCDE" },
  ];
  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: null,
        authors,
      },
    }),
  );

  const io = bufferIO();
  await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(built.validatorRunner.runCalls).toHaveLength(1);
  const payload = built.validatorRunner.runCalls[0]!.payload as Record<
    string,
    unknown
  >;
  // 1:1 with the block — same shape, same order, no munging.
  expect(payload.authors).toEqual(authors);
});

test("test_enqueue_linear_issue_validator_payload_omits_slack_thread_when_null", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(built.validatorRunner.runCalls).toHaveLength(1);
  const payload = built.validatorRunner.runCalls[0]!.payload as Record<
    string,
    unknown
  >;
  // Spec §11: when `slack_thread_ref` is null, the field is OMITTED entirely
  // from the validator payload (not passed as `null`).
  expect("slack_thread" in payload).toBe(false);
});

test("test_enqueue_linear_issue_invokes_validator_as_child_process", async () => {
  h = createHarness();
  // Wire the real spawned validator runner — confirms the child-process
  // path actually works end-to-end against the shipped default schema.
  const built = buildCliDeps(h, { validatorRunner: new SpawnedValidatorRunner() });
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );
  // If the validator subprocess spawned, the schema (shipped default) accepts
  // the payload, the child returns {valid: true}, and the task lands.
  expect(io.err()).toBe("");
  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("queued");
});

test("test_enqueue_linear_issue_fails_when_ticket_has_no_quay_config_block", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue({
    identifier: "ENG-1276",
    url: "https://linear.app/inverter/issue/ENG-1276",
    title: "No block",
    body: "## Context\n\nThis ticket body has no quay-config fence at all.\n",
    comments: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("ticket_block_invalid");
  // Validator was not invoked (the block parser fails first).
  expect(built.validatorRunner.runCalls).toEqual([]);
  // No DB writes.
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
});

test("test_enqueue_linear_issue_uses_ticket_repo_when_no_cli_repo", async () => {
  // When --repo is omitted, the ticket's `repo` field drives enqueue.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built); // registers REPO_ID

  built.linear.setIssue(
    makeIssue({
      block: {
        repo: REPO_ID, // ticket carries the repo
        tags: ["auth-session"],
        slack_thread: null,
        authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
      },
    }),
  );

  const io = bufferIO();
  // No --repo flag; the adapter must read it from the ticket.
  const result = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqResult = JSON.parse(io.out().trim());
  expect(enqResult.state).toBe("queued");

  // The task must have landed under REPO_ID (the ticket-supplied repo).
  const taskRow = h.db
    .query<{ repo_id: string }, [string]>(
      `SELECT repo_id FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(taskRow?.repo_id).toBe(REPO_ID);
});

test("test_enqueue_linear_issue_explicit_repo_overrides_ticket_repo", async () => {
  // Explicit --repo wins over the ticket's repo field.
  const OVERRIDE_REPO = "override-repo";
  h = createHarness();
  const built = buildCliDeps(h);
  // Register both repos.
  await addRepo(built); // REPO_ID
  await dispatch(
    [
      "repo", "add",
      "--id", OVERRIDE_REPO,
      "--url", "git@example.com:owner/override.git",
      "--base-branch", "main",
      "--package-manager", "bun",
      "--install-cmd", "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.git.seedBareClone(OVERRIDE_REPO);

  built.linear.setIssue(
    makeIssue({
      block: {
        repo: REPO_ID, // ticket says REPO_ID
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  const io = bufferIO();
  // Explicit --repo overrides the ticket value.
  const result = await dispatch(
    ["enqueue", "--repo", OVERRIDE_REPO, "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const enqResult = JSON.parse(io.out().trim());
  const taskRow = h.db
    .query<{ repo_id: string }, [string]>(
      `SELECT repo_id FROM tasks WHERE task_id = ?`,
    )
    .get(enqResult.task_id);
  expect(taskRow?.repo_id).toBe(OVERRIDE_REPO);
});

test("test_enqueue_linear_issue_idempotent_repoll_no_cli_repo_skips_linear_call", async () => {
  // Re-poll of an already-enqueued ticket on the no-`--repo` path must NOT
  // hit the Linear (or Slack) adapter — pre-fetch lookup by external_ref
  // alone short-circuits to the existing task. This preserves the
  // load-bearing property that re-polls don't burn API quota.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(
    makeIssue({
      block: {
        repo: REPO_ID,
        tags: ["foo"],
        slack_thread: null,
        authors: [{ name: "F", slack_id: "U001ABCDE" }],
      },
    }),
  );

  // First call — populates the row.
  const ioA = bufferIO();
  const a = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    ioA,
  );
  expect(a.exitCode).toBe(0);
  const first = JSON.parse(ioA.out().trim());

  const callsAfterFirst = built.linear.getIssueCalls.length;

  // Second call — must short-circuit before touching Linear.
  const ioB = bufferIO();
  const b = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    ioB,
  );
  expect(b.exitCode).toBe(0);
  const second = JSON.parse(ioB.out().trim());

  expect(second.task_id).toBe(first.task_id);
  expect(built.linear.getIssueCalls.length).toBe(callsAfterFirst);
});

test("test_enqueue_linear_issue_ticket_missing_repo_fails_via_validator", async () => {
  // When the ticket's quay-config block is missing `repo`, the block parser
  // throws ticket_block_invalid before the validator is invoked.
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  // Build a block without `repo` by constructing the raw YAML manually.
  const bodyWithoutRepo =
    `## Context\n\nNeeds work.\n\n\`\`\`quay-config\ntags:\n  - foo\nauthors:\n  - name: F\n    slack_id: U001ABCDE\n\`\`\`\n`;

  built.linear.setIssue({
    identifier: "ENG-1276",
    url: "https://linear.app/inverter/issue/ENG-1276",
    title: "Missing repo",
    body: bodyWithoutRepo,
    comments: [],
  });

  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--linear-issue", "ENG-1276"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err().trim());
  // Block parser catches missing repo before the validator runs.
  expect(err.error).toBe("ticket_block_invalid");
  expect(built.validatorRunner.runCalls).toEqual([]);
  const tasks = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(tasks?.n).toBe(0);
});

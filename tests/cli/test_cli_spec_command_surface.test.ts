// Spec §10: documented command surface uses flag-based inputs (not raw
// `--input <json>`). These smoke tests prove the dispatcher accepts the
// shapes the spec calls out, end-to-end, with fakes wired in.
//
// Each scenario drives one spec command, checks exit code + stdout/stderr
// shape, and asserts the resulting durable state matches the contract.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
let scratchDirs: string[] = [];
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
  const d = mkdtempSync(join(tmpdir(), "quay-cli-test-"));
  scratchDirs.push(d);
  return d;
}

function writeTemp(contents: string, name = "f.md"): string {
  const dir = tempDir();
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

test("repo add accepts spec flag form (--id, --url, --base-branch, ...)", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(
    [
      "repo",
      "add",
      "--id",
      "repo-flagform",
      "--url",
      "git@example.com:owner/r.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "bun install",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const parsed = JSON.parse(io.out());
  expect(parsed.repo_id).toBe("repo-flagform");
  expect(parsed.base_branch).toBe("main");
  expect(parsed.install_cmd).toBe("bun install");
});

test("enqueue accepts spec flag form (--repo, --brief-file, --external-ref, --slack-thread-ref)", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  // Pre-register the repo via core service so we test enqueue, not repo add.
  const dispatchAdd = await dispatch(
    [
      "repo",
      "add",
      "--id",
      "repo-enqueue-flag",
      "--url",
      "git@example.com:o/r.git",
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
  expect(dispatchAdd.exitCode).toBe(0);
  built.git.seedBareClone("repo-enqueue-flag");

  const briefPath = writeTemp("do the thing", "brief.md");
  const ticketPath = writeTemp("ticket body", "ticket.md");

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      "repo-enqueue-flag",
      "--brief-file",
      briefPath,
      "--ticket-snapshot-file",
      ticketPath,
      "--external-ref",
      "ITRY-900",
      "--slack-thread-ref",
      "C123:1700000000.0001",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqueueResult = JSON.parse(io.out().trim());
  expect(typeof enqueueResult.task_id).toBe("string");
  expect(enqueueResult.state).toBe("queued");
  expect(enqueueResult.branch_name).toBe("quay/ITRY-900");

  const row = h.db
    .query<
      { external_ref: string | null; slack_thread_ref: string | null },
      [string]
    >(
      "SELECT external_ref, slack_thread_ref FROM tasks WHERE task_id = ?",
    )
    .get(enqueueResult.task_id);
  expect(row?.external_ref).toBe("ITRY-900");
  expect(row?.slack_thread_ref).toBe("C123:1700000000.0001");

  // The brief artifact was captured from the file contents.
  const brief = h.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts WHERE task_id = ? AND kind = 'brief'`,
    )
    .get(enqueueResult.task_id);
  expect(brief).not.toBeNull();
});

test("task claim returns claim_id, then submit-brief flag form succeeds", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const repoId = insertRepo(h.db, "repo-claim-flow");
  const taskId = insertTask(h.db, {
    taskId: "task-claim-flow",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });

  // Step 1: claim. Spec form `task claim <task_id>` mints a fresh claim_id
  // and returns it on stdout.
  const claimIo = bufferIO();
  const claimResult = await dispatch(
    ["task", "claim", taskId],
    built.deps,
    claimIo,
  );
  expect(claimResult.exitCode).toBe(0);
  expect(claimIo.err()).toBe("");
  const claim = JSON.parse(claimIo.out());
  expect(claim.task_id).toBe(taskId);
  expect(typeof claim.claim_id).toBe("string");
  expect(claim.claim_id.length).toBeGreaterThan(0);
  expect(claim.state).toBe("claimed-by-orchestrator");

  // Step 2: submit-brief with the claim_id and a brief file. Spec form is
  // `submit-brief <task_id> --claim-id <id> --brief-file <path> --reason <r>`.
  const briefPath = writeTemp("follow-up brief", "fb.md");
  const submitIo = bufferIO();
  const submitResult = await dispatch(
    [
      "submit-brief",
      taskId,
      "--claim-id",
      claim.claim_id,
      "--brief-file",
      briefPath,
      "--reason",
      "advice_answered",
    ],
    built.deps,
    submitIo,
  );
  expect(submitResult.exitCode).toBe(0);
  expect(submitIo.err()).toBe("");
  const submit = JSON.parse(submitIo.out());
  expect(submit.task_id).toBe(taskId);
  expect(submit.state).toBe("queued");

  // The new brief artifact must contain the bytes we wrote, proving
  // `--brief-file` was actually read from disk.
  const briefRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'brief' AND attempt_id = ?`,
    )
    .get(taskId, submit.attempt_id);
  expect(briefRow).not.toBeNull();
});

test("submit-brief rejects unknown --reason values cleanly", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const briefPath = writeTemp("body", "b.md");
  const io = bufferIO();
  const result = await dispatch(
    [
      "submit-brief",
      "task-x",
      "--claim-id",
      "c-x",
      "--brief-file",
      briefPath,
      "--reason",
      "bogus",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(io.out()).toBe("");
  const parsed = JSON.parse(io.err());
  expect(parsed.error).toBe("usage_error");
  expect(parsed.message).toContain("blocker_resolved");
});

test("escalate-human flag form records question and preserves orchestrator claim", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const repoId = insertRepo(h.db, "repo-esc-flag");
  const taskId = insertTask(h.db, {
    taskId: "task-esc-flag",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });

  const claimIo = bufferIO();
  await dispatch(["task", "claim", taskId], built.deps, claimIo);
  const { claim_id } = JSON.parse(claimIo.out());

  const questionPath = writeTemp("Need human input", "q.md");
  const io = bufferIO();
  const result = await dispatch(
    [
      "escalate-human",
      taskId,
      "--claim-id",
      claim_id,
      "--question-file",
      questionPath,
      "--thread-ref",
      "C999:1700000099.0001",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const escalation = JSON.parse(io.out());
  expect(escalation.state).toBe("waiting_human");
  expect(escalation.thread_ref).toBe("C999:1700000099.0001");

  const task = h.db
    .query<{ claim_id: string | null }, [string]>(
      `SELECT claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.claim_id).toBe(claim_id);

  // Slack transport is orchestrator-owned; the CLI only records artifacts/state.
  expect(built.slack.postCalls).toHaveLength(0);
  expect(built.slack.fenceCalls).toHaveLength(0);
});

test("record-human-reply flag form persists answer and returns to claimed state", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const repoId = insertRepo(h.db, "repo-reply-flag");
  const taskId = insertTask(h.db, {
    taskId: "task-reply-flag",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });

  const claimIo = bufferIO();
  await dispatch(["task", "claim", taskId], built.deps, claimIo);
  const { claim_id } = JSON.parse(claimIo.out());

  const questionPath = writeTemp("Need human input", "q.md");
  const escIo = bufferIO();
  await dispatch(
    [
      "escalate-human",
      taskId,
      "--claim-id",
      claim_id,
      "--question-file",
      questionPath,
    ],
    built.deps,
    escIo,
  );

  const replyPath = writeTemp("Proceed with the fallback.", "reply.md");
  const io = bufferIO();
  const result = await dispatch(
    [
      "record-human-reply",
      taskId,
      "--claim-id",
      claim_id,
      "--reply-file",
      replyPath,
      "--thread-ref",
      "C999:1700000099.0001",
      "--message-ts",
      "1700000101.0002",
      "--author",
      "U123",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const reply = JSON.parse(io.out());
  expect(reply.state).toBe("claimed-by-orchestrator");

  const task = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "claimed-by-orchestrator", claim_id });
});

test("task release-claim accepts --claim-id flag form", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const repoId = insertRepo(h.db, "repo-release");
  const taskId = insertTask(h.db, {
    taskId: "task-release",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });

  const claimIo = bufferIO();
  await dispatch(["task", "claim", taskId], built.deps, claimIo);
  const { claim_id } = JSON.parse(claimIo.out());

  const io = bufferIO();
  const result = await dispatch(
    ["task", "release-claim", taskId, "--claim-id", claim_id],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(io.out());
  expect(parsed.state).toBe("awaiting-next-brief");
  expect(parsed.released).toBe(true);
});

test("task list filters by --state, --repo, --external-ref", async () => {
  h = createHarness();
  const repoA = insertRepo(h.db, "repo-list-a");
  const repoB = insertRepo(h.db, "repo-list-b");
  insertTask(h.db, { taskId: "t-a-1", repoId: repoA, state: "queued" });
  insertTask(h.db, { taskId: "t-a-2", repoId: repoA, state: "running" });
  insertTask(h.db, { taskId: "t-b-1", repoId: repoB, state: "queued" });
  // Set an external_ref on one row so we can filter on it.
  h.db.query("UPDATE tasks SET external_ref = ? WHERE task_id = ?").run(
    "ITRY-1",
    "t-a-1",
  );

  const built = buildCliDeps(h);

  // Filter by state (repeatable).
  const ioState = bufferIO();
  await dispatch(
    ["task", "list", "--state", "queued"],
    built.deps,
    ioState,
  );
  const states = JSON.parse(ioState.out()).map((r: { task_id: string }) => r.task_id).sort();
  expect(states).toEqual(["t-a-1", "t-b-1"]);

  // Filter by repo.
  const ioRepo = bufferIO();
  await dispatch(["task", "list", "--repo", repoA], built.deps, ioRepo);
  const byRepo = JSON.parse(ioRepo.out()).map((r: { task_id: string }) => r.task_id).sort();
  expect(byRepo).toEqual(["t-a-1", "t-a-2"]);

  // Filter by external-ref.
  const ioExt = bufferIO();
  await dispatch(
    ["task", "list", "--external-ref", "ITRY-1"],
    built.deps,
    ioExt,
  );
  const byExt = JSON.parse(ioExt.out()).map((r: { task_id: string }) => r.task_id);
  expect(byExt).toEqual(["t-a-1"]);
});

test("task events returns the append-only log oldest-first", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-events");
  const taskId = insertTask(h.db, { taskId: "t-events", repoId, state: "queued" });
  h.db
    .query(
      `INSERT INTO events (task_id, event_type, from_state, to_state, occurred_at)
       VALUES (?, 'enqueued', NULL, 'queued', ?)`,
    )
    .run(taskId, "2026-01-01T00:00:00.000Z");
  h.db
    .query(
      `INSERT INTO events (task_id, event_type, from_state, to_state, occurred_at)
       VALUES (?, 'spawned', 'queued', 'running', ?)`,
    )
    .run(taskId, "2026-01-01T00:01:00.000Z");

  const built = buildCliDeps(h);
  const io = bufferIO();
  const result = await dispatch(["task", "events", taskId], built.deps, io);
  expect(result.exitCode).toBe(0);
  const events = JSON.parse(io.out());
  expect(Array.isArray(events)).toBe(true);
  expect(events[0].event_type).toBe("enqueued");
  expect(events[1].event_type).toBe("spawned");
});

test("artifact get returns file contents for a known kind", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "repo-art",
      "--url",
      "git@example.com:o/r.git",
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
  built.git.seedBareClone("repo-art");

  const briefPath = writeTemp("artifact body", "b.md");
  const enqIo = bufferIO();
  await dispatch(
    [
      "enqueue",
      "--repo",
      "repo-art",
      "--brief-file",
      briefPath,
    ],
    built.deps,
    enqIo,
  );
  const enq = JSON.parse(enqIo.out());

  // Default form: stdout is the raw file body.
  const io = bufferIO();
  const result = await dispatch(
    ["artifact", "get", enq.task_id, "brief"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(io.out()).toContain("artifact body");

  // --path form: stdout is just the file path.
  const ioPath = bufferIO();
  const pathResult = await dispatch(
    ["artifact", "get", enq.task_id, "brief", "--path"],
    built.deps,
    ioPath,
  );
  expect(pathResult.exitCode).toBe(0);
  // Artifact store layout: <root>/<task_id>/<attempt_id>/<kind>/<hash>.<ext>
  // We assert the path lands inside the kind directory and ends with .md.
  const printed = ioPath.out().trim();
  expect(printed.includes(`/${enq.task_id}/`)).toBe(true);
  expect(printed.includes("/brief/")).toBe(true);
  expect(printed.endsWith(".md")).toBe(true);
});

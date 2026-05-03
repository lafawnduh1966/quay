// CLI dispatcher. Thin layer over core service API. Output shape is the
// product contract: read commands emit deterministic JSON on stdout; write
// errors emit `{error: ...}` on stderr with non-zero exit.
//
// Production wiring (real adapters) lives in src/cli/index.ts. This module
// stays free of adapter construction so tests can drive it with fakes.
//
// Command surface tracks spec §10. The flag-based forms (e.g.
// `--repo <id> --brief-file <path>`) are the documented interface. A
// `--input <json>` escape hatch is also accepted on write commands so tests
// and tooling can hand a structured payload directly.

import { readFileSync, writeFileSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort } from "../ports/github.ts";
import type { IdGenerator } from "../ports/id_generator.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import { enqueue, type EnqueueDeps } from "../core/enqueue.ts";
import { createRepoService } from "../core/repos/service.ts";
import {
  cancel_task,
  type CancelDeps,
  type CancelResult,
} from "../core/cancel.ts";
import {
  claim_task,
  release_claim,
  submit_brief,
  escalate_human,
  type ClaimDeps,
  type SubmitBriefDeps,
  type EscalateHumanDeps,
  type ServiceResult,
} from "../core/claims.ts";
import { tick_once, type TickDeps, type TickOptions } from "../core/tick.ts";
import type { SupervisorLock } from "../core/supervisor_lock.ts";
import { toCliError, serviceErrorToCli } from "./errors.ts";
import { getTask, listTasks } from "./format.ts";
import type { CliIO } from "./io.ts";

export interface CliPaths {
  reposRoot: string;
  worktreesRoot: string;
  artifactsRoot: string;
}

export interface CliDeps {
  db: DB;
  clock: Clock;
  ids: IdGenerator;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  slack: SlackPort;
  commandRunner: CommandRunner;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
  paths: CliPaths;
  tickOptions?: TickOptions;
  // Spec §13: `retry_budget` is a deployment-level knob (default 5). When
  // the operator overrides it in `~/.quay/config.toml`, the production CLI
  // forwards it here so enqueue copies the configured value into
  // `tasks.retry_budget` instead of the EnqueueDeps default.
  retryBudget?: number;
}

export interface DispatchResult {
  exitCode: number;
}

export async function dispatch(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (argv.length === 0) {
    return writeError(io, "usage_error", "no command provided", { argv });
  }

  const [head, ...rest] = argv;
  try {
    switch (head) {
      case "task":
        return await handleTask(rest, deps, io);
      case "tick":
        return handleTick(rest, deps, io);
      case "enqueue":
        return handleEnqueue(rest, deps, io);
      case "repo":
        return handleRepo(rest, deps, io);
      case "cancel":
        return handleCancel(rest, deps, io);
      case "submit-brief":
        return handleSubmitBrief(rest, deps, io);
      case "escalate-human":
        return handleEscalateHuman(rest, deps, io);
      case "artifact":
        return handleArtifact(rest, deps, io);
      default:
        return writeError(io, "usage_error", `unknown command: ${head}`, {
          command: head,
        });
    }
  } catch (err) {
    const payload = toCliError(err);
    io.stderr(`${JSON.stringify(payload)}\n`);
    return { exitCode: 1 };
  }
}

function writeError(
  io: CliIO,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): DispatchResult {
  io.stderr(`${JSON.stringify({ error: code, message, ...details })}\n`);
  return { exitCode: 1 };
}

async function handleTask(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (argv.length === 0) {
    return writeError(io, "usage_error", "task subcommand required");
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
      return handleTaskList(rest, deps, io);
    case "get":
      return handleTaskGet(rest, deps, io);
    case "events":
      return handleTaskEvents(rest, deps, io);
    case "claim":
      return handleClaim(rest, deps, io);
    case "release-claim":
      return handleReleaseClaim(rest, deps, io);
    default:
      return writeError(io, "usage_error", `unknown task subcommand: ${sub}`);
  }
}

function handleTaskList(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const states = collectFlagValues(argv, "--state");
  const repo = readFlag(argv, "--repo");
  const externalRef = readFlag(argv, "--external-ref");
  const rows = listTasks(deps.db).filter((r) => {
    if (states.length > 0 && !states.includes(r.state)) return false;
    if (repo !== null && r.repo_id !== repo) return false;
    if (externalRef !== null && r.external_ref !== externalRef) return false;
    return true;
  });
  io.stdout(`${JSON.stringify(rows)}\n`);
  return { exitCode: 0 };
}

function handleTaskGet(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task get requires <task_id>");
  }
  const payload = getTask(deps.db, taskId);
  if (!payload) {
    return writeError(io, "unknown_task", `task ${taskId} not found`, {
      task_id: taskId,
    });
  }
  io.stdout(`${JSON.stringify(payload)}\n`);
  return { exitCode: 0 };
}

interface EventRow {
  event_id: number;
  task_id: string;
  attempt_id: number | null;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload_artifact_id: number | null;
  occurred_at: string;
}

function handleTaskEvents(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task events requires <task_id>");
  }
  // `task events` returns the full append-only log, oldest first, so callers
  // can stream/replay transitions without reconciling reverse-order results.
  const events = deps.db
    .query<EventRow, [string]>(
      `SELECT event_id, task_id, attempt_id, event_type, from_state, to_state,
              payload_artifact_id, occurred_at
         FROM events
        WHERE task_id = ?
        ORDER BY occurred_at ASC, event_id ASC`,
    )
    .all(taskId);
  io.stdout(`${JSON.stringify(events)}\n`);
  return { exitCode: 0 };
}

function handleTick(
  _argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const tickDeps: TickDeps = pickTickDeps(deps);
  const results = tick_once(tickDeps, deps.tickOptions ?? {});
  for (const r of results) {
    io.stdout(`${JSON.stringify(r)}\n`);
  }
  return { exitCode: 0 };
}

function handleEnqueue(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: Record<string, unknown>;
  if (json.value !== undefined) {
    input = json.value as Record<string, unknown>;
  } else {
    // Spec §10: enqueue takes flag-based inputs.
    const repoId = readFlag(argv, "--repo");
    if (repoId === null) {
      return writeError(io, "usage_error", "enqueue requires --repo <id>");
    }
    const briefPath = readFlag(argv, "--brief-file");
    if (briefPath === null) {
      return writeError(io, "usage_error", "enqueue requires --brief-file <path>");
    }
    const ticketPath = readFlag(argv, "--ticket-snapshot-file");
    const externalRef = readFlag(argv, "--external-ref");
    const slackThreadRef = readFlag(argv, "--slack-thread-ref");
    const briefRead = tryReadFile(briefPath);
    if (!briefRead.ok) return writeError(io, "usage_error", briefRead.message);
    input = { repo_id: repoId, brief: briefRead.value };
    if (ticketPath !== null) {
      const t = tryReadFile(ticketPath);
      if (!t.ok) return writeError(io, "usage_error", t.message);
      input.ticket_snapshot = t.value;
    }
    if (externalRef !== null) input.external_ref = externalRef;
    if (slackThreadRef !== null) input.slack_thread_ref = slackThreadRef;
  }
  const enqueueDeps: EnqueueDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    paths: deps.paths,
  };
  if (deps.retryBudget !== undefined) {
    enqueueDeps.retryBudget = deps.retryBudget;
  }
  const result = enqueue(enqueueDeps, input);
  io.stdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

function handleRepo(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeError(io, "usage_error", "repo subcommand required");
  }
  const [sub, ...rest] = argv;
  const service = createRepoService({ db: deps.db, clock: deps.clock });
  switch (sub) {
    case "add":
      return handleRepoAdd(rest, service, io);
    case "update":
      return handleRepoUpdate(rest, service, io);
    case "remove": {
      const repoId = positional(rest);
      if (!repoId) {
        return writeError(io, "usage_error", "repo remove requires <repo_id>");
      }
      const row = service.remove(repoId);
      io.stdout(`${JSON.stringify(row)}\n`);
      return { exitCode: 0 };
    }
    case "list":
      return handleRepoList(service, io);
    case "export":
      return handleRepoExport(rest, service, io);
    case "import":
      return handleRepoImport(rest, service, io);
    default:
      return writeError(io, "usage_error", `unknown repo subcommand: ${sub}`);
  }
}

const REPO_FLAGS: Array<{ flag: string; key: string }> = [
  { flag: "--id", key: "repo_id" },
  { flag: "--url", key: "repo_url" },
  { flag: "--base-branch", key: "base_branch" },
  { flag: "--package-manager", key: "package_manager" },
  { flag: "--install-cmd", key: "install_cmd" },
  { flag: "--test-cmd", key: "test_cmd" },
  { flag: "--ci-workflow-name", key: "ci_workflow_name" },
  { flag: "--contribution-guide-path", key: "contribution_guide_path" },
];

function handleRepoAdd(
  argv: string[],
  service: ReturnType<typeof createRepoService>,
  io: CliIO,
): DispatchResult {
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  const input = json.value !== undefined ? json.value : flagsToObject(argv, REPO_FLAGS);
  const row = service.add(input);
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function handleRepoUpdate(
  argv: string[],
  service: ReturnType<typeof createRepoService>,
  io: CliIO,
): DispatchResult {
  const repoId = readFlag(argv, "--id") ?? positional(argv);
  if (!repoId) {
    return writeError(io, "usage_error", "repo update requires --id <repo_id>");
  }
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  const patch = json.value !== undefined
    ? json.value
    : flagsToObject(
        argv,
        // --id is the row selector, not a column to update.
        REPO_FLAGS.filter((f) => f.flag !== "--id"),
      );
  const row = service.update(repoId, patch);
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function handleRepoList(
  service: ReturnType<typeof createRepoService>,
  io: CliIO,
): DispatchResult {
  io.stdout(`${JSON.stringify(service.list())}\n`);
  return { exitCode: 0 };
}

function handleRepoExport(
  argv: string[],
  service: ReturnType<typeof createRepoService>,
  io: CliIO,
): DispatchResult {
  const out = readFlag(argv, "--out");
  const body = JSON.stringify(service.list());
  if (out !== null) {
    try {
      writeFileSync(out, `${body}\n`, { encoding: "utf8" });
    } catch (err) {
      return writeError(
        io,
        "io_error",
        `failed to write export to ${out}: ${(err as Error).message}`,
      );
    }
    // Stdout still gets the operator-friendly summary, mirroring how `task
    // get` / `repo add` always emit something so a wrapping script can
    // verify success.
    io.stdout(`${JSON.stringify({ out, count: service.list().length })}\n`);
    return { exitCode: 0 };
  }
  io.stdout(`${body}\n`);
  return { exitCode: 0 };
}

function handleRepoImport(
  argv: string[],
  service: ReturnType<typeof createRepoService>,
  io: CliIO,
): DispatchResult {
  const inputPath = readFlag(argv, "--in");
  if (inputPath === null) {
    return writeError(io, "usage_error", "repo import requires --in <path>");
  }
  const fileRead = tryReadFile(inputPath);
  if (!fileRead.ok) return writeError(io, "usage_error", fileRead.message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileRead.value);
  } catch (err) {
    return writeError(
      io,
      "usage_error",
      `repo import: ${inputPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    return writeError(
      io,
      "usage_error",
      `repo import: ${inputPath} must contain a JSON array of repo rows`,
    );
  }
  // Per spec §10: "Upserts (idempotent for restore use)." Validation per
  // row happens inside `service.upsert`; on the first failure we surface
  // the structured error and abort. We deliberately do NOT wrap the loop
  // in a SQL transaction: the documented use case is a backup-restore
  // dump produced by `repo export`, so partial success on a malformed
  // dump still leaves a useful set of recovered rows for the operator
  // to inspect — the ones that imported are the prefix of the array up
  // to the failing row.
  const ids: string[] = [];
  for (const row of parsed) {
    const r = service.upsert(row);
    ids.push(r.repo_id);
  }
  io.stdout(
    `${JSON.stringify({ imported: ids.length, repo_ids: ids })}\n`,
  );
  return { exitCode: 0 };
}

function handleCancel(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "cancel requires <task_id>");
  }
  // Cancel is destructive (kills the tmux session, removes the worktree,
  // optionally closes the PR). A misspelled flag must NOT be silently
  // ignored — `cancel --keep-worktre` would otherwise behave like a
  // worktree-removing cancel because `--keep-worktree` evaluates false,
  // costing the operator the on-disk state they wanted to preserve. Reject
  // any unknown long flag before invoking the finalizer.
  //
  // Boolean-flag detection below uses exact-match `argv.includes`, so the
  // validator must also reject the `--flag=value` form: `--keep-worktree=true`
  // would otherwise pass the membership check (we strip `=value` for that)
  // but get ignored by the detector, leaving the operator with the SAME
  // silent-flag-ignore failure mode this validator was added to prevent.
  // These flags carry no value; reject any `--keep-worktree=...` /
  // `--close-pr=...` outright with a usage_error.
  const allowedCancelFlags = new Set(["--close-pr", "--keep-worktree"]);
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const head = eq === -1 ? a : a.slice(0, eq);
    if (!allowedCancelFlags.has(head)) {
      return writeError(io, "usage_error", `unknown cancel flag: ${a}`, {
        flag: a,
      });
    }
    if (eq !== -1) {
      return writeError(
        io,
        "usage_error",
        `${head} is a boolean flag and does not take a value (got ${a})`,
        { flag: a },
      );
    }
  }
  const closePr = argv.includes("--close-pr");
  const keepWorktree = argv.includes("--keep-worktree");
  const cancelDeps: CancelDeps = {
    db: deps.db,
    clock: deps.clock,
    git: deps.git,
    github: deps.github,
    tmux: deps.tmux,
    artifactStore: deps.artifactStore,
    supervisorLock: deps.supervisorLock,
  };
  const result: CancelResult = cancel_task(cancelDeps, {
    taskId,
    closePr,
    keepWorktree,
  });
  return emitServiceResult(result, io);
}

function handleClaim(argv: string[], deps: CliDeps, io: CliIO): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task claim requires <task_id>");
  }
  const claimDeps: ClaimDeps = { db: deps.db, clock: deps.clock };
  return emitServiceResult(claim_task(claimDeps, { taskId }), io);
}

function handleReleaseClaim(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  // `--claim-id <id>` is the spec form. Also accept a positional second arg
  // for backwards compatibility with the previous CLI wiring.
  const claimId = readFlag(argv, "--claim-id") ?? positionalAt(argv, 1);
  if (!taskId || !claimId) {
    return writeError(
      io,
      "usage_error",
      "task release-claim requires <task_id> --claim-id <claim_id>",
    );
  }
  const claimDeps: ClaimDeps = { db: deps.db, clock: deps.clock };
  return emitServiceResult(release_claim(claimDeps, { taskId, claimId }), io);
}

function handleSubmitBrief(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: { taskId: string; claimId: string; brief: string; reason: string };
  if (json.value !== undefined) {
    input = json.value as never;
  } else {
    const taskId = positional(argv);
    const claimId = readFlag(argv, "--claim-id");
    const briefFile = readFlag(argv, "--brief-file");
    const reason = readFlag(argv, "--reason");
    if (!taskId || !claimId || !briefFile || !reason) {
      return writeError(
        io,
        "usage_error",
        "submit-brief requires <task_id> --claim-id <id> --brief-file <path> --reason <blocker_resolved|advice_answered>",
      );
    }
    const briefRead = tryReadFile(briefFile);
    if (!briefRead.ok) return writeError(io, "usage_error", briefRead.message);
    input = { taskId, claimId, brief: briefRead.value, reason };
  }
  if (input.reason !== "blocker_resolved" && input.reason !== "advice_answered") {
    return writeError(
      io,
      "usage_error",
      `submit-brief --reason must be blocker_resolved or advice_answered (got ${input.reason})`,
    );
  }
  const submitDeps: SubmitBriefDeps = {
    db: deps.db,
    clock: deps.clock,
    artifactStore: deps.artifactStore,
  };
  return emitServiceResult(
    submit_brief(submitDeps, {
      taskId: input.taskId,
      claimId: input.claimId,
      brief: input.brief,
      reason: input.reason as "blocker_resolved" | "advice_answered",
    }),
    io,
  );
}

function handleEscalateHuman(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: {
    taskId: string;
    claimId: string;
    questionBody: string;
    threadRef?: string | null;
  };
  if (json.value !== undefined) {
    input = json.value as never;
  } else {
    const taskId = positional(argv);
    const claimId = readFlag(argv, "--claim-id");
    const questionFile = readFlag(argv, "--question-file");
    const threadRef = readFlag(argv, "--thread-ref");
    if (!taskId || !claimId || !questionFile) {
      return writeError(
        io,
        "usage_error",
        "escalate-human requires <task_id> --claim-id <id> --question-file <path> [--thread-ref <ref>]",
      );
    }
    const qRead = tryReadFile(questionFile);
    if (!qRead.ok) return writeError(io, "usage_error", qRead.message);
    input = {
      taskId,
      claimId,
      questionBody: qRead.value,
      threadRef: threadRef ?? null,
    };
  }
  const escalateDeps: EscalateHumanDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    artifactStore: deps.artifactStore,
  };
  return emitServiceResult(escalate_human(escalateDeps, input), io);
}

interface ArtifactRow {
  artifact_id: number;
  task_id: string;
  attempt_id: number | null;
  kind: string;
  file_path: string;
  captured_at: string;
}

function handleArtifact(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0 || argv[0] !== "get") {
    return writeError(io, "usage_error", "artifact subcommand required (get)");
  }
  const rest = argv.slice(1);
  const taskId = positional(rest);
  const kind = positionalAt(rest, 1);
  if (!taskId || !kind) {
    return writeError(
      io,
      "usage_error",
      "artifact get requires <task_id> <kind>",
    );
  }
  const attemptArg = readFlag(rest, "--attempt");
  const attemptId = attemptArg !== null ? Number.parseInt(attemptArg, 10) : null;
  if (attemptArg !== null && Number.isNaN(attemptId)) {
    return writeError(io, "usage_error", `--attempt must be an integer (got ${attemptArg})`);
  }
  const wantPath = rest.includes("--path");

  // Latest matching artifact wins. Filter by attempt_id when provided.
  const row =
    attemptId === null
      ? deps.db
          .query<ArtifactRow, [string, string]>(
            `SELECT artifact_id, task_id, attempt_id, kind, file_path, captured_at
               FROM artifacts WHERE task_id = ? AND kind = ?
              ORDER BY artifact_id DESC LIMIT 1`,
          )
          .get(taskId, kind)
      : deps.db
          .query<ArtifactRow, [string, string, number]>(
            `SELECT artifact_id, task_id, attempt_id, kind, file_path, captured_at
               FROM artifacts WHERE task_id = ? AND kind = ? AND attempt_id = ?
              ORDER BY artifact_id DESC LIMIT 1`,
          )
          .get(taskId, kind, attemptId);
  if (!row) {
    return writeError(io, "unknown_artifact", `no ${kind} artifact for task ${taskId}`, {
      task_id: taskId,
      kind,
      attempt_id: attemptId,
    });
  }
  if (wantPath) {
    io.stdout(`${row.file_path}\n`);
    return { exitCode: 0 };
  }
  // Stream raw bytes — no UTF-8 round-trip. `malformed_signal` artifacts
  // intentionally preserve invalid UTF-8 sequences (that's literally what
  // the kind documents), so decoding here would corrupt the payload before
  // it reaches the operator. CliIO.stdout accepts Uint8Array for exactly
  // this path; the production sink is `process.stdout.write`, which also
  // accepts bytes natively.
  io.stdout(readFileSync(row.file_path));
  return { exitCode: 0 };
}

function emitServiceResult<T>(
  result: ServiceResult<T> | { ok: boolean; value?: T; error?: { code: string; message: string; details?: Record<string, unknown> } },
  io: CliIO,
): DispatchResult {
  if (result.ok) {
    io.stdout(`${JSON.stringify(result.value)}\n`);
    return { exitCode: 0 };
  }
  const err = (result as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  io.stderr(`${JSON.stringify(serviceErrorToCli(err))}\n`);
  return { exitCode: 1 };
}

function pickTickDeps(deps: CliDeps): TickDeps {
  return {
    db: deps.db,
    clock: deps.clock,
    git: deps.git,
    github: deps.github,
    tmux: deps.tmux,
    slack: deps.slack,
    artifactStore: deps.artifactStore,
    supervisorLock: deps.supervisorLock,
  };
}

// --- argv helpers --------------------------------------------------------

type ParseResult =
  | { ok: true; value: unknown | undefined }
  | { ok: false; message: string };

// Returns { ok: true, value: undefined } when --input is not present, so the
// caller falls through to flag-based parsing without an error.
function tryParseJsonFlag(argv: string[]): ParseResult {
  const raw = readFlag(argv, "--input");
  if (raw === null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: `invalid JSON for --input: ${(err as Error).message}`,
    };
  }
}

// Reads `--flag <value>` or `--flag=<value>`. Returns null when absent.
function readFlag(argv: string[], flag: string): string | null {
  const eq = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === flag) return argv[i + 1] ?? null;
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return null;
}

// Repeatable flag — collects every `--flag <v>` / `--flag=<v>` occurrence.
function collectFlagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  const eq = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === flag) {
      const v = argv[i + 1];
      if (v !== undefined) out.push(v);
    } else if (a.startsWith(eq)) {
      out.push(a.slice(eq.length));
    }
  }
  return out;
}

// First non-flag token.
function positional(argv: string[]): string | null {
  return positionalAt(argv, 0);
}

// Nth non-flag token (skipping every `--flag <value>` pair).
function positionalAt(argv: string[], n: number): string | null {
  let count = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      // Flags with `=` are self-contained; flags without an `=` consume the
      // next token unless that next token is itself a `--flag`.
      if (!a.includes("=")) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) i += 1;
      }
      continue;
    }
    if (count === n) return a;
    count += 1;
  }
  return null;
}

function flagsToObject(
  argv: string[],
  spec: ReadonlyArray<{ flag: string; key: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { flag, key } of spec) {
    const v = readFlag(argv, flag);
    if (v !== null) out[key] = v;
  }
  return out;
}

function tryReadFile(path: string): { ok: true; value: string } | { ok: false; message: string } {
  try {
    return { ok: true, value: readFileSync(path, "utf8") };
  } catch (err) {
    return {
      ok: false,
      message: `failed to read ${path}: ${(err as Error).message}`,
    };
  }
}

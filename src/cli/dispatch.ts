// CLI dispatcher. Thin layer over core service API. Output shape is the
// product contract: read commands emit deterministic JSON on stdout; write
// errors emit `{error: ...}` on stderr with non-zero exit.
//
// Production wiring (real adapters) lives in src/cli/index.ts. This module
// stays free of adapter construction so tests can drive it with fakes.

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
      case "task": {
        return await handleTask(rest, deps, io);
      }
      case "tick": {
        return handleTick(rest, deps, io);
      }
      case "enqueue": {
        return handleEnqueue(rest, deps, io);
      }
      case "repo": {
        return handleRepo(rest, deps, io);
      }
      case "cancel": {
        return handleCancel(rest, deps, io);
      }
      case "claim": {
        return handleClaim(rest, deps, io);
      }
      case "release-claim": {
        return handleReleaseClaim(rest, deps, io);
      }
      case "submit-brief": {
        return handleSubmitBrief(rest, deps, io);
      }
      case "escalate-human": {
        return handleEscalateHuman(rest, deps, io);
      }
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
    case "list": {
      const rows = listTasks(deps.db);
      io.stdout(`${JSON.stringify(rows)}\n`);
      return { exitCode: 0 };
    }
    case "get": {
      const taskId = rest[0];
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
    default:
      return writeError(io, "usage_error", `unknown task subcommand: ${sub}`);
  }
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
  const input = parseJsonFlag(argv);
  if (!input.ok) return writeError(io, "usage_error", input.message);
  const enqueueDeps: EnqueueDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    paths: deps.paths,
  };
  const result = enqueue(enqueueDeps, input.value);
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
    case "add": {
      const input = parseJsonFlag(rest);
      if (!input.ok) return writeError(io, "usage_error", input.message);
      const row = service.add(input.value);
      io.stdout(`${JSON.stringify(row)}\n`);
      return { exitCode: 0 };
    }
    case "update": {
      const repoId = rest[0];
      if (!repoId) {
        return writeError(io, "usage_error", "repo update requires <repo_id>");
      }
      const input = parseJsonFlag(rest.slice(1));
      if (!input.ok) return writeError(io, "usage_error", input.message);
      const row = service.update(repoId, input.value);
      io.stdout(`${JSON.stringify(row)}\n`);
      return { exitCode: 0 };
    }
    case "remove": {
      const repoId = rest[0];
      if (!repoId) {
        return writeError(io, "usage_error", "repo remove requires <repo_id>");
      }
      const row = service.remove(repoId);
      io.stdout(`${JSON.stringify(row)}\n`);
      return { exitCode: 0 };
    }
    default:
      return writeError(io, "usage_error", `unknown repo subcommand: ${sub}`);
  }
}

function handleCancel(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = argv[0];
  if (!taskId) {
    return writeError(io, "usage_error", "cancel requires <task_id>");
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
  const taskId = argv[0];
  if (!taskId) {
    return writeError(io, "usage_error", "claim requires <task_id>");
  }
  const claimDeps: ClaimDeps = { db: deps.db, clock: deps.clock };
  return emitServiceResult(claim_task(claimDeps, { taskId }), io);
}

function handleReleaseClaim(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = argv[0];
  const claimId = argv[1];
  if (!taskId || !claimId) {
    return writeError(
      io,
      "usage_error",
      "release-claim requires <task_id> <claim_id>",
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
  const input = parseJsonFlag(argv);
  if (!input.ok) return writeError(io, "usage_error", input.message);
  const submitDeps: SubmitBriefDeps = {
    db: deps.db,
    clock: deps.clock,
    artifactStore: deps.artifactStore,
  };
  return emitServiceResult(submit_brief(submitDeps, input.value as never), io);
}

function handleEscalateHuman(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const input = parseJsonFlag(argv);
  if (!input.ok) return writeError(io, "usage_error", input.message);
  const escalateDeps: EscalateHumanDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    artifactStore: deps.artifactStore,
  };
  return emitServiceResult(escalate_human(escalateDeps, input.value as never), io);
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

type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

// Accepts `--input <json>` or `--input=<json>`. Treats a single positional
// argument as a JSON literal too.
function parseJsonFlag(argv: string[]): ParseResult {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--input") {
      raw = argv[i + 1];
      break;
    }
    if (a.startsWith("--input=")) {
      raw = a.slice("--input=".length);
      break;
    }
  }
  if (raw === undefined && argv.length === 1) {
    raw = argv[0];
  }
  if (raw === undefined) {
    return { ok: false, message: "missing --input <json>" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: `invalid JSON for --input: ${(err as Error).message}`,
    };
  }
}

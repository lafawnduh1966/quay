// Dead-worker evidence classifier (spec §5 "Per-cycle behavior" running case +
// §"Spawn-failure recovery is evidence-first" + §14 "Idempotent PR contract").
//
// Shared between the normal `running` dead-worker branch and the spawn-window
// (`tmux_session = NULL`) recovery path. Writes exactly one terminal
// transition per worker outcome. Blocker / malformed_signal artifacts use
// crash-safe ingestion (artifact write → SQL commit → file delete) with
// content-hash idempotency so a tick that crashes mid-ingestion converges on
// the next run.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort } from "../ports/github.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import { fireFailpoint } from "./failpoints.ts";
import {
  scheduleDeterministicRetry,
  writeBlockerBudgetExhausted,
} from "./retries.ts";

const BLOCKER_FILENAME = ".quay-blocked.md";
const BLOCKER_MAX_BYTES = 64 * 1024;

export type ClassifyOutcome =
  | "blocker_written"
  | "malformed_signal"
  | "pr_opened"
  | "no_progress"
  | "crashed"
  | "spawn_window_no_evidence";

export interface ClassifyContextTask {
  task_id: string;
  repo_id: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  state: string;
}

export interface ClassifyContextAttempt {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  remote_sha_at_spawn: string | null;
  pr_existed_at_spawn: number;
  tmux_session: string | null;
}

export interface ClassifierDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  artifactStore: ArtifactStore;
}

export interface ClassifyOptions {
  // Canonical session name to operate on (kill orphan, collect log, etc).
  // For the normal dead-worker path this is `attempt.tmux_session`. For the
  // spawn-window recovery path the caller supplies the canonical
  // `quay-task-<tmux_id>-<attempt_number>` name since `tmux_session` is NULL.
  sessionName: string;
  // True when entering from the spawn-window recovery branch
  // (tmux_session IS NULL). Affects the no-evidence default: dead-worker
  // schedules a `crash` retry; spawn-window defers spawn_failed rollback to
  // a later slice and returns `spawn_window_no_evidence`.
  spawnWindow: boolean;
}

export interface ClassifyResult {
  outcome: ClassifyOutcome;
}

export function classifyAndApply(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  options: ClassifyOptions,
): ClassifyResult {
  // Step 1: best-effort session log capture. Idempotent across re-entry via
  // the recovery-path content_hash unique index.
  collectSessionLog(deps, task, attempt, options.sessionName);

  // Step 2: blocker file (valid → ingest; malformed → persist + retry).
  const blockerPath = join(task.worktree_path, BLOCKER_FILENAME);
  const probe = probeBlockerFile(blockerPath);
  if (probe.kind === "valid") {
    return ingestBlocker(deps, task, attempt, blockerPath, probe.content);
  }
  if (probe.kind === "malformed") {
    return ingestMalformed(deps, task, attempt, blockerPath, probe.bytes);
  }

  // Step 3: fresh remote/PR snapshot for the progress predicate. Use the
  // tolerant fetch: a worker that died before pushing (spawn-window crash,
  // immediate exit) leaves `quay/<slug>` absent on origin, which is exactly
  // the "no remote progress" evidence the predicate below feeds on. A hard
  // fetch failure here would mask that as a tick_error instead.
  deps.git.fetchBranchIfExists(task.repo_id, task.branch_name);
  const remoteShaAtExit = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  const prExistsAtExit = deps.github.prExistsForBranch(
    task.repo_id,
    task.branch_name,
  );
  const prExistedAtSpawn = attempt.pr_existed_at_spawn === 1;

  const remoteUnchanged =
    remoteShaAtExit === attempt.remote_sha_at_spawn || remoteShaAtExit === null;
  const prCreatedDuringAttempt = prExistsAtExit && !prExistedAtSpawn;
  const noProgress = remoteUnchanged && !prCreatedDuringAttempt;

  if (prExistsAtExit && !noProgress) {
    return transitionPrOpened(deps, task, attempt, remoteShaAtExit);
  }
  if (prExistsAtExit && noProgress) {
    return scheduleNoProgressRetry(deps, task, attempt, remoteShaAtExit);
  }
  if (options.spawnWindow) {
    // No evidence on the spawn-window path: the genuine spawn-failed default
    // (budget rollback + spawn_failures_consecutive) is owned by a later
    // slice. Leave the row untouched so that recovery converges later.
    return { outcome: "spawn_window_no_evidence" };
  }
  return scheduleCrashRetry(deps, task, attempt, remoteShaAtExit);
}

interface BlockerValid {
  kind: "valid";
  content: string;
}
interface BlockerMalformed {
  kind: "malformed";
  bytes: Uint8Array;
}
interface BlockerAbsent {
  kind: "absent";
}
type BlockerProbe = BlockerValid | BlockerMalformed | BlockerAbsent;

function probeBlockerFile(path: string): BlockerProbe {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { kind: "absent" };
  }
  if (!stats.isFile()) return { kind: "absent" };

  let raw: Uint8Array;
  try {
    raw = readFileSync(path);
  } catch {
    return { kind: "absent" };
  }

  if (raw.byteLength > BLOCKER_MAX_BYTES) {
    return { kind: "malformed", bytes: raw.subarray(0, BLOCKER_MAX_BYTES) };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { kind: "malformed", bytes: raw };
  }

  if (decoded.trim().length === 0) {
    return { kind: "malformed", bytes: raw };
  }

  return { kind: "valid", content: decoded };
}

function collectSessionLog(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  sessionName: string,
): void {
  let log: string | null;
  try {
    log = deps.tmux.collectLog(sessionName, task.worktree_path);
  } catch {
    return;
  }
  if (log === null) return;
  // Recovery-path partial unique index dedupes by content_hash, so re-entry on
  // the same attempt with the same log is naturally idempotent.
  try {
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      kind: "session_log",
      content: log,
      extension: "txt",
    });
  } catch {
    // ignore — best-effort.
  }
}

function ingestBlocker(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  blockerPath: string,
  content: string,
): ClassifyResult {
  const contentHash = sha256(content);
  const artifactId = upsertRecoveryArtifact(deps, {
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "blocker",
    contentHash,
    content,
    extension: "md",
  });
  fireFailpoint("after_blocker_artifact_write");

  const transitioned = transitionAlreadyApplied(
    deps.db,
    task.task_id,
    attempt.attempt_id,
    artifactId,
    "blocker_ingested",
  );
  if (!transitioned) {
    const now = deps.clock.nowISO();
    deps.db.exec("BEGIN");
    try {
      const taskUpd = deps.db
        .query(
          `UPDATE tasks
              SET state = 'awaiting-next-brief',
                  spawn_failures_consecutive = 0,
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND state = 'running'
              AND cancel_requested_at IS NULL`,
        )
        .run(now, task.task_id);
      const changes = (taskUpd as { changes?: number }).changes ?? 0;
      if (changes === 0) {
        deps.db.exec("ROLLBACK");
        // Another writer beat us; treat as already applied. Fall through to
        // file delete so recovery converges.
      } else {
        deps.db
          .query(
            `UPDATE attempts
                SET exit_kind = 'blocker_written',
                    ended_at = ?
              WHERE attempt_id = ? AND ended_at IS NULL`,
          )
          .run(now, attempt.attempt_id);
        writeBlockerBudgetExhausted(deps, {
          taskId: task.task_id,
          attempt,
          blockerContent: content,
        });
        deps.db
          .query(
            `INSERT INTO events (
               task_id, attempt_id, event_type,
               from_state, to_state, payload_artifact_id, occurred_at
             ) VALUES (?, ?, 'blocker_ingested', 'running', 'awaiting-next-brief', ?, ?)`,
          )
          .run(task.task_id, attempt.attempt_id, artifactId, now);
        deps.db.exec("COMMIT");
      }
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }
  fireFailpoint("after_blocker_state_commit");

  // Step 3 of crash-safe ingestion: delete the worktree file. Idempotent.
  try {
    rmSync(blockerPath, { force: true });
  } catch {}
  return { outcome: "blocker_written" };
}

function ingestMalformed(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  blockerPath: string,
  bytes: Uint8Array,
): ClassifyResult {
  const contentHash = sha256Bytes(bytes);
  const artifactId = upsertRecoveryArtifact(deps, {
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "malformed_signal",
    contentHash,
    content: bytes,
    extension: "bin",
  });

  const transitioned = transitionAlreadyApplied(
    deps.db,
    task.task_id,
    attempt.attempt_id,
    artifactId,
    "malformed_signal_ingested",
  );
  if (!transitioned) {
    const now = deps.clock.nowISO();
    deps.db.exec("BEGIN");
    try {
      const taskUpd = deps.db
        .query(
          `UPDATE tasks
              SET state = 'queued',
                  spawn_failures_consecutive = 0,
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND state = 'running'
              AND cancel_requested_at IS NULL`,
        )
        .run(now, task.task_id);
      const changes = (taskUpd as { changes?: number }).changes ?? 0;
      if (changes === 0) {
        deps.db.exec("ROLLBACK");
      } else {
        deps.db
          .query(
            `UPDATE attempts
                SET exit_kind = 'crashed',
                    ended_at = ?
              WHERE attempt_id = ? AND ended_at IS NULL`,
          )
          .run(now, attempt.attempt_id);
        scheduleDeterministicRetry(deps, {
          taskId: task.task_id,
          prevAttempt: attempt,
          reason: "malformed_signal",
          diagnostics: "Worker wrote a malformed .quay-blocked.md signal. The raw malformed bytes were persisted as a malformed_signal artifact.",
          fromState: "running",
        });
        deps.db
          .query(
            `INSERT INTO events (
               task_id, attempt_id, event_type,
               from_state, to_state, payload_artifact_id, occurred_at
             ) VALUES (?, ?, 'malformed_signal_ingested', 'running', 'queued', ?, ?)`,
          )
          .run(task.task_id, attempt.attempt_id, artifactId, now);
        deps.db.exec("COMMIT");
      }
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  try {
    rmSync(blockerPath, { force: true });
  } catch {}
  return { outcome: "malformed_signal" };
}

function transitionPrOpened(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
): ClassifyResult {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    const taskUpd = deps.db
      .query(
        `UPDATE tasks
          SET state = 'pr-open',
              spawn_failures_consecutive = 0,
              tick_error = NULL,
                updated_at = ?
          WHERE task_id = ? AND state = 'running'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changes = (taskUpd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { outcome: "pr_opened" };
    }
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'pr_opened',
                ended_at = ?,
                remote_sha_at_exit = ?
          WHERE attempt_id = ?`,
      )
      .run(now, remoteShaAtExit, attempt.attempt_id);
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type,
           from_state, to_state, occurred_at
         ) VALUES (?, ?, 'pr_opened', 'running', 'pr-open', ?)`,
      )
      .run(task.task_id, attempt.attempt_id, now);
    deps.db.exec("COMMIT");
    return { outcome: "pr_opened" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function scheduleCrashRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
): ClassifyResult {
  return scheduleRetry(deps, task, attempt, remoteShaAtExit, "crashed", "crash");
}

function scheduleNoProgressRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
): ClassifyResult {
  return scheduleRetry(
    deps,
    task,
    attempt,
    remoteShaAtExit,
    "no_progress",
    "crash",
  );
}

type DeadExitKind = "crashed" | "no_progress";

function scheduleRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
  exitKind: DeadExitKind,
  retryReason: "crash" | "malformed_signal",
): ClassifyResult {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    const taskUpd = deps.db
      .query(
        `UPDATE tasks
            SET spawn_failures_consecutive = 0,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ? AND state = 'running'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changes = (taskUpd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { outcome: exitKind === "no_progress" ? "no_progress" : "crashed" };
    }
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = ?,
                ended_at = ?,
                remote_sha_at_exit = ?
          WHERE attempt_id = ?`,
      )
      .run(exitKind, now, remoteShaAtExit, attempt.attempt_id);
    scheduleDeterministicRetry(deps, {
      taskId: task.task_id,
      prevAttempt: attempt,
      reason: retryReason,
      diagnostics:
        exitKind === "no_progress"
          ? "The worker exited with an existing PR but made no trackable remote progress during this attempt."
          : "The worker exited without producing a PR or valid blocker signal.",
      fromState: "running",
    });
    const eventType = exitKind === "no_progress" ? "no_progress" : "crashed";
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type,
           from_state, to_state, occurred_at
         ) VALUES (?, ?, ?, 'running', (SELECT state FROM tasks WHERE task_id = ?), ?)`,
      )
      .run(task.task_id, attempt.attempt_id, eventType, task.task_id, now);
    deps.db.exec("COMMIT");
    return { outcome: exitKind === "no_progress" ? "no_progress" : "crashed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

interface UpsertArtifactInput {
  taskId: string;
  attemptId: number;
  kind: string;
  contentHash: string;
  content: string | Uint8Array;
  extension: string;
}

function upsertRecoveryArtifact(
  deps: ClassifierDeps,
  input: UpsertArtifactInput,
): number {
  // Crash-recovery: if a previous tick wrote the artifact but crashed before
  // the state/event commit, the matching row is already on disk. Reuse it
  // rather than violating the partial unique index.
  const existing = deps.db
    .query<{ artifact_id: number }, [string, number, string, string]>(
      `SELECT artifact_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = ? AND content_hash = ?`,
    )
    .get(input.taskId, input.attemptId, input.kind, input.contentHash);
  if (existing) return existing.artifact_id;

  const result = deps.artifactStore.writeArtifact({
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.kind,
    content: input.content,
    extension: input.extension,
  });
  return result.artifactId;
}

function transitionAlreadyApplied(
  db: DB,
  taskId: string,
  attemptId: number,
  artifactId: number,
  eventType: string,
): boolean {
  const row = db
    .query<{ event_id: number }, [string, number, string, number]>(
      `SELECT event_id FROM events
         WHERE task_id = ? AND attempt_id = ?
           AND event_type = ? AND payload_artifact_id = ?`,
    )
    .get(taskId, attemptId, eventType, artifactId);
  return row !== null && row !== undefined;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

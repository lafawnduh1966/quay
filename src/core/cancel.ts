// Cancel finalizer (spec §5 "Cancel intent" + "Cancel finalizer", §10 cancel,
// §14 invariants on durable intent + crash recovery).
//
// Two entry points:
//   - cancel_task(...): synchronous CLI path. Acquires the supervisor lock,
//     writes durable task-level cancel intent (`tasks.cancel_requested_at` +
//     flags + per-attempt `kill_intent = 'cancel'` when running), kills the
//     running tmux session if applicable, and runs the finalizer to terminal.
//   - runCancelFinalizer(...): the canonical finalizer used by both the CLI
//     path (after the synchronous intent commit) and tick recovery (top-of-
//     loop check on `cancel_requested_at IS NOT NULL`). The caller owns the
//     supervisor lock — we do NOT take it here, otherwise tick recovery would
//     re-enter the in-process lock guard.
//
// Crash recovery: every step is idempotent on a task already in the target
// state. A crash anywhere between intent and the terminal SQL transition is
// recovered by the next tick — even if irreversible side effects (gh pr
// close, remote branch delete) already landed.

import { existsSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort } from "../ports/github.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import { fireFailpoint } from "./failpoints.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";

export type CancelErrorCode = "unknown_task" | "wrong_state";

export interface CancelError {
  code: CancelErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type CancelResult =
  | { ok: true; value: CancelTaskValue }
  | { ok: false; error: CancelError };

export interface CancelTaskValue {
  task_id: string;
  state: "cancelled";
  // "cancelled" — finalizer ran and converged.
  // "already_cancelled" — task was already cancelled; no SQL writes performed.
  outcome: "cancelled" | "already_cancelled";
}

export interface CancelDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
}

export interface CancelTaskInput {
  taskId: string;
  closePr?: boolean;
  keepWorktree?: boolean;
}

interface TaskRow {
  task_id: string;
  repo_id: string;
  state: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  cancel_requested_at: string | null;
  cancel_close_pr: number;
  cancel_keep_worktree: number;
  claim_id: string | null;
}

interface AttemptRow {
  attempt_id: number;
  attempt_number: number;
  tmux_session: string | null;
  spawned_at: string | null;
  ended_at: string | null;
  kill_intent: string | null;
}

const TERMINAL_NON_CANCELLED = new Set(["merged", "closed_unmerged"]);

function loadTaskRow(db: DB, taskId: string): TaskRow | null {
  return (
    db
      .query<TaskRow, [string]>(
        `SELECT task_id, repo_id, state, branch_name, tmux_id, worktree_path,
                cancel_requested_at, cancel_close_pr, cancel_keep_worktree,
                claim_id
           FROM tasks WHERE task_id = ?`,
      )
      .get(taskId) ?? null
  );
}

function loadLatestAttempt(db: DB, taskId: string): AttemptRow | null {
  return (
    db
      .query<AttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, tmux_session,
                spawned_at, ended_at, kill_intent
           FROM attempts
          WHERE task_id = ?
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function loadRunningAttempt(db: DB, taskId: string): AttemptRow | null {
  return (
    db
      .query<AttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, tmux_session,
                spawned_at, ended_at, kill_intent
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NOT NULL AND ended_at IS NULL
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

export function cancel_task(
  deps: CancelDeps,
  input: CancelTaskInput,
): CancelResult {
  return deps.supervisorLock.run(() => cancelUnderLock(deps, input));
}

function cancelUnderLock(deps: CancelDeps, input: CancelTaskInput): CancelResult {
  const initial = loadTaskRow(deps.db, input.taskId);
  if (!initial) {
    return {
      ok: false,
      error: {
        code: "unknown_task",
        message: `task ${input.taskId} not found`,
        details: { task_id: input.taskId },
      },
    };
  }
  if (initial.state === "cancelled") {
    return {
      ok: true,
      value: {
        task_id: input.taskId,
        state: "cancelled",
        outcome: "already_cancelled",
      },
    };
  }
  if (TERMINAL_NON_CANCELLED.has(initial.state)) {
    return {
      ok: false,
      error: {
        code: "wrong_state",
        message: `task ${input.taskId} is in terminal state ${initial.state}`,
        details: { task_id: input.taskId, state: initial.state },
      },
    };
  }

  // If cancel intent already landed (recovery path), skip the intent commit
  // and the synchronous tmux kill (those were either already done or will be
  // re-done idempotently inside the finalizer's step 1).
  const alreadyHadIntent = initial.cancel_requested_at !== null;
  if (!alreadyHadIntent) {
    commitCancelIntent(deps, input, initial);
    killRunningTmux(deps, initial);
  }

  // Failpoint boundary: intent committed, tmux kill returned (when applicable),
  // finalizer not yet complete. Tests that throw here exercise the
  // "task left mid-cancel" recovery path driven by tick.
  fireFailpoint("after_cancel_intent_commit");

  runCancelFinalizer(deps, input.taskId);

  return {
    ok: true,
    value: { task_id: input.taskId, state: "cancelled", outcome: "cancelled" },
  };
}

function commitCancelIntent(
  deps: CancelDeps,
  input: CancelTaskInput,
  initial: TaskRow,
): void {
  const now = deps.clock.nowISO();
  const closePrFlag = input.closePr ? 1 : 0;
  const keepWorktreeFlag = input.keepWorktree ? 1 : 0;

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    deps.db
      .query(
        `UPDATE tasks
            SET cancel_requested_at = ?,
                cancel_close_pr = ?,
                cancel_keep_worktree = ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ? AND cancel_requested_at IS NULL`,
      )
      .run(now, closePrFlag, keepWorktreeFlag, now, input.taskId);

    if (initial.state === "running") {
      const running = loadRunningAttempt(deps.db, input.taskId);
      if (running !== null) {
        deps.db
          .query(
            `UPDATE attempts SET kill_intent = 'cancel'
              WHERE attempt_id = ? AND kill_intent IS NULL`,
          )
          .run(running.attempt_id);
      }
    }
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function killRunningTmux(deps: CancelDeps, initial: TaskRow): void {
  if (initial.state !== "running") return;
  const attempt = loadRunningAttempt(deps.db, initial.task_id);
  if (!attempt) return;
  const session =
    attempt.tmux_session ??
    `quay-task-${initial.tmux_id}-${attempt.attempt_number}`;
  try {
    deps.tmux.kill(session);
  } catch {
    // tmux kill is documented idempotent; swallow any fake/adapter error.
  }
}

// Canonical finalizer (spec §5 "Cancel finalizer"). Callers must hold the
// supervisor lock — tick recovery already owns the lock for the cycle, and
// `cancel_task` takes it before invoking us.
export function runCancelFinalizer(deps: CancelDeps, taskId: string): void {
  const row = loadTaskRow(deps.db, taskId);
  if (!row) return;
  if (row.state === "cancelled") return; // idempotent re-entry
  if (TERMINAL_NON_CANCELLED.has(row.state)) return; // never reached via tick

  // Step 1: ensure no live worker. For `running` attempts kill the canonical
  // session (or the recorded tmux_session when set). For non-running states
  // there's no live attempt — this is a no-op.
  const latest = loadLatestAttempt(deps.db, taskId);
  if (latest !== null && row.state === "running") {
    const session =
      latest.tmux_session ??
      `quay-task-${row.tmux_id}-${latest.attempt_number}`;
    try {
      if (deps.tmux.isAlive(session)) {
        deps.tmux.kill(session);
      } else {
        // Defensive idempotent kill — fake's `kill` is a no-op for missing
        // sessions, so this is safe.
        deps.tmux.kill(session);
      }
    } catch {}
  }

  // Step 2: best-effort session-log capture. Done inside try/catch — failures
  // do not block terminal convergence.
  if (latest !== null) {
    try {
      const sessionName =
        latest.tmux_session ??
        `quay-task-${row.tmux_id}-${latest.attempt_number}`;
      const log = deps.tmux.collectLog(sessionName, row.worktree_path);
      if (log !== null && log.length > 0) {
        try {
          deps.artifactStore.writeArtifact({
            taskId,
            attemptId: latest.attempt_id,
            kind: "session_log",
            content: log,
            extension: "txt",
          });
        } catch {
          // Recovery-path session_log uniqueness isn't enforced by index, but
          // best-effort writes shouldn't abort cancel.
        }
      }
    } catch {}
  }

  // Step 3: cleanup matrix per §5. Substrate failures are logged-and-continue;
  // SQL terminal transition runs regardless.
  applyCleanupMatrix(deps, row);

  // Step 4: atomic terminal transition.
  commitTerminal(deps, row, latest);
}

function applyCleanupMatrix(deps: CancelDeps, row: TaskRow): void {
  const closePr = row.cancel_close_pr === 1;
  const keepWorktree = row.cancel_keep_worktree === 1;

  // gh pr close runs first when the operator opted in. Idempotent on already-
  // closed / non-existent PRs.
  if (closePr) {
    try {
      deps.github.closePr(row.repo_id, row.branch_name);
    } catch {}
    fireFailpoint("after_github_pr_close");
  }

  // Determine whether to retain the remote branch. With --close-pr, always
  // delete. Otherwise retain only when a PR is currently open (preserves the
  // human's option to take over the work — spec §5 cleanup matrix).
  let deleteRemote = true;
  if (!closePr) {
    try {
      const open = deps.github.prIsOpen(row.repo_id, row.branch_name);
      if (open) deleteRemote = false;
    } catch {
      // On read failure we err toward retention to avoid clobbering an open
      // PR. The cleanup is best-effort either way.
      deleteRemote = false;
    }
  }
  if (deleteRemote) {
    try {
      deps.git.deleteRemoteBranch(row.repo_id, row.branch_name);
    } catch {}
  }

  if (keepWorktree) {
    try {
      if (existsSync(row.worktree_path)) {
        deps.git.worktreeDetach(row.worktree_path);
      }
    } catch {}
  } else {
    try {
      if (existsSync(row.worktree_path)) {
        deps.git.worktreeRemove(row.worktree_path);
      }
    } catch {}
  }

  // Delete after removing or detaching the worktree. Git refuses to delete a
  // branch that is checked out by any linked worktree.
  try {
    deps.git.branchDelete(row.repo_id, row.branch_name);
  } catch {}
}

function commitTerminal(
  deps: CancelDeps,
  row: TaskRow,
  latest: AttemptRow | null,
): void {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'cancelled',
                claim_id = NULL,
                claimed_at = NULL,
                tick_error = NULL,
                claim_expirations_consecutive = 0,
                spawn_failures_consecutive = 0,
                updated_at = ?
          WHERE task_id = ? AND state != 'cancelled'`,
      )
      .run(now, row.task_id);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      // Another writer beat us; idempotent success. Roll back our own no-op
      // transaction without writing a duplicate event.
      deps.db.exec("ROLLBACK");
      return;
    }

    if (latest !== null) {
      // Only stamp killed_cancel on attempts that haven't already terminated
      // (e.g., a `done` task's pr_opened exit_kind is preserved as the
      // historical exit; the cancellation record lives in the events table).
      deps.db
        .query(
          `UPDATE attempts
              SET exit_kind = 'killed_cancel',
                  ended_at = ?,
                  kill_intent = NULL
            WHERE attempt_id = ? AND ended_at IS NULL`,
        )
        .run(now, latest.attempt_id);
      // Always clear kill_intent on the latest attempt — even a terminated
      // one — so a stale `kill_intent = 'cancel'` doesn't linger.
      deps.db
        .query(
          `UPDATE attempts SET kill_intent = NULL
            WHERE attempt_id = ? AND kill_intent IS NOT NULL`,
        )
        .run(latest.attempt_id);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, ?, 'cancelled', ?, 'cancelled', ?)`,
        )
        .run(row.task_id, latest.attempt_id, row.state, now);
    } else {
      deps.db
        .query(
          `INSERT INTO events (
             task_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, 'cancelled', ?, 'cancelled', ?)`,
        )
        .run(row.task_id, row.state, now);
    }
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

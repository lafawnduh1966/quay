import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort, PrSnapshot } from "../ports/github.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import { runCancelFinalizer } from "./cancel.ts";
import {
  classifyAndApply,
  type ClassifyContextAttempt,
  type ClassifyContextTask,
  type ClassifyOutcome,
} from "./classifier.ts";
import { classifyCi } from "./ci_status.ts";
import { fireFailpoint } from "./failpoints.ts";
import { scheduleNonBudgetRespawn } from "./non_budget_respawn.ts";
import {
  scheduleCleanSpawnRetry,
  scheduleDeterministicRetry,
  type BudgetRetryReason,
} from "./retries.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_ATTEMPT_DURATION_SECONDS = 3600;
export const DEFAULT_STALENESS_THRESHOLD_SECONDS = 600;
export const DEFAULT_MAX_SPAWN_FAILURES = 3;
export const DEFAULT_CLAIM_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_CLAIM_EXPIRATIONS = 3;
export const DEFAULT_MAX_NON_BUDGET_RESPAWNS = 20;
export const DEFAULT_AGENT_INVOCATION =
  "claude --permission-mode bypassPermissions < {prompt_file}";

export interface TickDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  slack: SlackPort;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
}

export interface TickOptions {
  maxConcurrent?: number;
  agentInvocation?: string;
  maxAttemptDurationSeconds?: number;
  stalenessThresholdSeconds?: number;
  maxSpawnFailures?: number;
  claimTimeoutSeconds?: number;
  maxClaimExpirations?: number;
  maxNonBudgetRespawns?: number;
}

export type TickAction =
  | "spawned"
  | "skipped_capacity"
  | "skipped_predicate"
  | "skipped_no_pending_attempt"
  | "spawn_substrate_failed"
  | "blocker_ingested"
  | "malformed_signal"
  | "pr_opened"
  | "no_progress"
  | "crashed"
  | "spawn_window_recovered"
  | "spawn_failed"
  | "wall_clock_killed"
  | "stale_killed"
  | "kill_intent_set"
  | "ci_failed"
  | "ci_pending"
  | "ci_passed"
  | "pr_merged"
  | "pr_closed_unmerged"
  | "review_respawn_scheduled"
  | "conflict_respawn_scheduled"
  | "non_budget_loop_parked"
  | "claim_expired"
  | "orchestrator_loop_parked"
  | "cancel_finalized"
  | "slack_fence_captured"
  | "slack_post_recovered"
  | "slack_posted"
  | "slack_reply_ingested"
  | "slack_skipped"
  | "tick_error";

export interface TickTaskResult {
  task_id: string;
  action: TickAction;
  error?: string;
}

interface QueuedTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  cancel_requested_at: string | null;
}

interface RunningTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  cancel_requested_at: string | null;
}

interface PrOpenTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  worktree_path: string;
  cancel_requested_at: string | null;
  last_review_id_acted_on: string | null;
  last_conflict_observation: string | null;
}

interface DoneTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  worktree_path: string;
  cancel_requested_at: string | null;
  last_review_id_acted_on: string | null;
  last_conflict_observation: string | null;
}

interface ClaimedTaskRow {
  task_id: string;
  claimed_at: string | null;
  claim_expirations_consecutive: number;
  cancel_requested_at: string | null;
}

interface PendingAttemptRow {
  attempt_id: number;
  attempt_number: number;
  consumed_budget: number;
  preamble_id: number;
}

interface CurrentAttemptRow {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  template_id: number | null;
  reason: string;
  consumed_budget: number;
  remote_sha_at_spawn: string | null;
  pr_existed_at_spawn: number;
  tmux_session: string | null;
  spawned_at: string | null;
  kill_intent: string | null;
}

export function tick_once(deps: TickDeps, options: TickOptions = {}): TickTaskResult[] {
  const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const agentInvocation = options.agentInvocation ?? DEFAULT_AGENT_INVOCATION;
  return deps.supervisorLock.run(() => {
    const results: TickTaskResult[] = [];

    // Top-of-loop cancel check (spec §5 + §14). Cancel intent is durable on
    // the task row, so honor it from every non-terminal state — running,
    // pr-open, done, awaiting-next-brief, claimed-by-orchestrator,
    // waiting_human, parked. Per-state handling for these tasks is skipped
    // this cycle; the finalizer drives them to `cancelled`.
    const cancelTargets = readCancelTargets(deps.db);
    const cancelledIds = new Set<string>();
    for (const task of cancelTargets) {
      try {
        runCancelFinalizer(deps, task.task_id);
        cancelledIds.add(task.task_id);
        results.push({ task_id: task.task_id, action: "cancel_finalized" });
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
        cancelledIds.add(task.task_id);
      }
    }

    // Snapshot active tasks once per tick (spec §5 "for each task in active
    // states"). Processing running first lets dead-worker classification run,
    // but tasks that transition through `queued` mid-tick are not promoted
    // until the next tick — the retry latency budget is one tick interval.
    const runningSnapshot = readRunning(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const prOpenSnapshot = readPrOpen(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const doneSnapshot = readDone(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const claimedSnapshot = readClaimed(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const waitingHumanSnapshot = readWaitingHuman(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const queuedSnapshot = readQueued(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );

    for (const task of runningSnapshot) {
      try {
        const result = processRunningTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    for (const task of prOpenSnapshot) {
      try {
        const result = processPrOpenTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    for (const task of doneSnapshot) {
      try {
        const result = processDoneTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    for (const task of claimedSnapshot) {
      try {
        const result = processClaimedTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    for (const task of waitingHumanSnapshot) {
      try {
        const taskResults = processWaitingHumanTask(deps, task);
        for (const r of taskResults) results.push(r);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    let runningCount = countRunning(deps.db);
    for (const task of queuedSnapshot) {
      if (runningCount >= max) {
        results.push({ task_id: task.task_id, action: "skipped_capacity" });
        continue;
      }
      try {
        results.push(promoteAndSpawn(deps, task, agentInvocation));
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
      // Re-read running count from the DB so terminal/non-promotion outcomes
      // don't drift the cap.
      runningCount = countRunning(deps.db);
    }

    return results;
  });
}

interface CancelTargetRow {
  task_id: string;
}

function readCancelTargets(db: DB): CancelTargetRow[] {
  return db
    .query<CancelTargetRow, []>(
      `SELECT task_id FROM tasks
        WHERE cancel_requested_at IS NOT NULL
          AND state NOT IN ('cancelled', 'merged', 'closed_unmerged')
        ORDER BY task_id`,
    )
    .all();
}

function readQueued(db: DB): QueuedTaskRow[] {
  return db
    .query<QueuedTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, tmux_id, worktree_path, cancel_requested_at
         FROM tasks
        WHERE state = 'queued'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readRunning(db: DB): RunningTaskRow[] {
  return db
    .query<RunningTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, tmux_id, worktree_path, cancel_requested_at
         FROM tasks
        WHERE state = 'running'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readClaimed(db: DB): ClaimedTaskRow[] {
  return db
    .query<ClaimedTaskRow, []>(
      `SELECT task_id, claimed_at, claim_expirations_consecutive, cancel_requested_at
         FROM tasks
        WHERE state = 'claimed-by-orchestrator'
        ORDER BY claimed_at, task_id`,
    )
    .all();
}

interface WaitingHumanTaskRow {
  task_id: string;
  slack_thread_ref: string | null;
  cancel_requested_at: string | null;
}

function readWaitingHuman(db: DB): WaitingHumanTaskRow[] {
  return db
    .query<WaitingHumanTaskRow, []>(
      `SELECT task_id, slack_thread_ref, cancel_requested_at
         FROM tasks
        WHERE state = 'waiting_human'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readPrOpen(db: DB): PrOpenTaskRow[] {
  return db
    .query<PrOpenTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, worktree_path,
              cancel_requested_at, last_review_id_acted_on,
              last_conflict_observation
         FROM tasks
        WHERE state = 'pr-open'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readDone(db: DB): DoneTaskRow[] {
  return db
    .query<DoneTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, worktree_path,
              cancel_requested_at, last_review_id_acted_on,
              last_conflict_observation
         FROM tasks
        WHERE state = 'done'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function loadCurrentAttempt(db: DB, taskId: string): CurrentAttemptRow | null {
  return (
    db
      .query<CurrentAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, preamble_id,
                template_id, reason, consumed_budget,
                remote_sha_at_spawn, pr_existed_at_spawn, tmux_session,
                spawned_at, kill_intent
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NOT NULL
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function processRunningTask(
  deps: TickDeps,
  task: RunningTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  // Cancel intent is the slice-7 finalizer's responsibility; skip cleanly.
  if (task.cancel_requested_at !== null) return null;

  const attempt = loadCurrentAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  const ctxTask: ClassifyContextTask = {
    task_id: task.task_id,
    repo_id: task.repo_id,
    branch_name: task.branch_name,
    tmux_id: task.tmux_id,
    worktree_path: task.worktree_path,
    state: "running",
  };
  const ctxAttempt: ClassifyContextAttempt = {
    attempt_id: attempt.attempt_id,
    attempt_number: attempt.attempt_number,
    preamble_id: attempt.preamble_id,
    remote_sha_at_spawn: attempt.remote_sha_at_spawn,
    pr_existed_at_spawn: attempt.pr_existed_at_spawn,
    tmux_session: attempt.tmux_session,
  };

  if (attempt.tmux_session === null) {
    // Spawn-window recovery: kill any orphan tmux session matching the
    // canonical name (idempotent — missing session is OK), then run the
    // same evidence classifier.
    const canonical = `quay-task-${task.tmux_id}-${attempt.attempt_number}`;
    try {
      deps.tmux.kill(canonical);
    } catch {}
    const res = classifyAndApply(
      deps,
      ctxTask,
      ctxAttempt,
      { sessionName: canonical, spawnWindow: true },
    );
    if (res.outcome === "spawn_window_no_evidence") {
      return handleSpawnFailure(deps, task, attempt, options);
    }
    return outcomeToResult(task.task_id, res.outcome, true);
  }

  if (deps.tmux.isAlive(attempt.tmux_session)) {
    if (attempt.kill_intent !== null) {
      deps.tmux.kill(attempt.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    const intent = detectKillIntent(deps, attempt, options);
    if (intent !== null) {
      setKillIntent(deps, task.task_id, attempt.attempt_id, intent);
      fireFailpoint("after_kill_intent_commit");
      deps.tmux.kill(attempt.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    return null;
  }

  if (attempt.kill_intent === "wall_clock" || attempt.kill_intent === "stale") {
    const retryReason: BudgetRetryReason = attempt.kill_intent;
    finalizeKillIntent(deps, task, attempt, retryReason);
    return {
      task_id: task.task_id,
      action: retryReason === "wall_clock" ? "wall_clock_killed" : "stale_killed",
    };
  }

  const res = classifyAndApply(
    { ...deps, artifactStore: deps.artifactStore },
    ctxTask,
    ctxAttempt,
    { sessionName: attempt.tmux_session, spawnWindow: false },
  );
  return outcomeToResult(task.task_id, res.outcome, false);
}

function outcomeToResult(
  taskId: string,
  outcome: ClassifyOutcome,
  spawnWindow: boolean,
): TickTaskResult | null {
  switch (outcome) {
    case "blocker_written":
      return {
        task_id: taskId,
        action: spawnWindow ? "spawn_window_recovered" : "blocker_ingested",
      };
    case "malformed_signal":
      return { task_id: taskId, action: "malformed_signal" };
    case "pr_opened":
      return { task_id: taskId, action: "pr_opened" };
    case "no_progress":
      return { task_id: taskId, action: "no_progress" };
    case "crashed":
      return { task_id: taskId, action: "crashed" };
    case "spawn_window_no_evidence":
      return null;
  }
}

function processPrOpenTask(
  deps: TickDeps,
  task: PrOpenTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null) {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR snapshot unavailable for branch ${task.branch_name}; tick will retry next cycle`,
      ),
    );
  }

  // 1. Terminal PR state (merged / closed_unmerged) takes precedence over
  //    everything else — even pending CI. A human merging or closing the PR
  //    while CI is still running must convert to terminal cleanly (spec §5
  //    "pr-open polls PR state").
  if (snapshot.state === "merged" || snapshot.state === "closed_unmerged") {
    return finalizePrTerminal(deps, task, attempt, snapshot.state, "pr-open");
  }

  // 2. Merge conflict: schedule a non-budget conflict respawn unless the
  //    (head_sha:base_sha) pair matches the dedupe key.
  if (snapshot.mergeable === "conflicting") {
    const observation = formatConflictObservation(snapshot);
    if (task.last_conflict_observation !== observation) {
      return scheduleConflictNonBudget(
        deps,
        task.task_id,
        attempt,
        snapshot,
        observation,
        "pr-open",
        options,
      );
    }
  }

  // 3. CI status (named workflow vs required vs no-checks).
  const repo = loadRepoForTask(deps.db, task.task_id);
  const ci = classifyCi(snapshot, repo?.ci_workflow_name ?? null);

  if (ci === "stale") {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR head SHA (${snapshot.headSha}) and check-run SHA (${snapshot.checks.checkSha}) disagree; skipping CI evaluation this tick`,
      ),
    );
  }
  if (ci === "pending") {
    return { task_id: task.task_id, action: "ci_pending" };
  }
  if (ci === "pass") {
    return transitionCiPassed(deps, task, attempt);
  }
  return scheduleCiFailRetry(deps, task, attempt, snapshot);
}

function processDoneTask(
  deps: TickDeps,
  task: DoneTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null) {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR snapshot unavailable for branch ${task.branch_name}; tick will retry next cycle`,
      ),
    );
  }

  // 1. Terminal PR state.
  if (snapshot.state === "merged" || snapshot.state === "closed_unmerged") {
    return finalizePrTerminal(deps, task, attempt, snapshot.state, "done");
  }

  // 2. Merge conflict.
  if (snapshot.mergeable === "conflicting") {
    const observation = formatConflictObservation(snapshot);
    if (task.last_conflict_observation !== observation) {
      return scheduleConflictNonBudget(
        deps,
        task.task_id,
        attempt,
        snapshot,
        observation,
        "done",
        options,
      );
    }
  }

  // 3. Review feedback.
  if (
    snapshot.latestReview.decision === "CHANGES_REQUESTED" &&
    snapshot.latestReview.latestReviewId !== null &&
    task.last_review_id_acted_on !== snapshot.latestReview.latestReviewId
  ) {
    return scheduleReviewNonBudget(
      deps,
      task.task_id,
      attempt,
      snapshot,
      "done",
      options,
    );
  }

  return null;
}

interface PrTerminalRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  worktree_path: string;
}

function finalizePrTerminal(
  deps: TickDeps,
  task: PrTerminalRow,
  attempt: CurrentAttemptRow,
  terminal: "merged" | "closed_unmerged",
  fromState: "pr-open" | "done",
): TickTaskResult {
  const now = deps.clock.nowISO();

  // Step 1: branch + worktree cleanup per the §5 cleanup matrix.
  applyTerminalCleanup(deps, task, terminal);

  // Step 2: atomic SQL terminal transition.
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = ?, tick_error = NULL, updated_at = ?
          WHERE task_id = ? AND state = ?
            AND cancel_requested_at IS NULL`,
      )
      .run(terminal, now, task.task_id, fromState);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { task_id: task.task_id, action: "skipped_predicate" };
    }
    // Stamp `pr_merged` / `pr_closed_unmerged` exit_kind on the latest attempt
    // when it has no terminal exit yet (e.g. CI was still pending — the
    // attempt itself didn't reach a clean done state, so the latest exit_kind
    // is whatever was set when the worker died, typically `pr_opened`).
    // We only update when ended_at IS NULL to preserve the historical exit.
    if (attempt.spawned_at !== null) {
      deps.db
        .query(
          `UPDATE attempts SET ended_at = ? WHERE attempt_id = ? AND ended_at IS NULL`,
        )
        .run(now, attempt.attempt_id);
    }
    const eventType = terminal === "merged" ? "merged" : "closed";
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(task.task_id, attempt.attempt_id, eventType, fromState, terminal, now);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    task_id: task.task_id,
    action: terminal === "merged" ? "pr_merged" : "pr_closed_unmerged",
  };
}

function applyTerminalCleanup(
  deps: TickDeps,
  task: PrTerminalRow,
  terminal: "merged" | "closed_unmerged",
): void {
  // Worktree removal (best-effort) per §5 cleanup matrix.
  try {
    if (existsSync(task.worktree_path)) {
      deps.git.worktreeRemove(task.worktree_path);
    }
  } catch {}

  // Local branch is deleted in both terminals.
  try {
    deps.git.branchDelete(task.repo_id, task.branch_name);
  } catch {}

  // Remote branch: delete only on closed_unmerged (the human chose to discard
  // the work). On merged, GitHub's "delete branch on merge" handles it.
  if (terminal === "closed_unmerged") {
    try {
      deps.git.deleteRemoteBranch(task.repo_id, task.branch_name);
    } catch {}
  }
}

function transitionCiPassed(
  deps: TickDeps,
  task: PrOpenTaskRow,
  attempt: CurrentAttemptRow,
): TickTaskResult | null {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'done', tick_error = NULL, updated_at = ?
          WHERE task_id = ? AND state = 'pr-open'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return null;
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, 'ci_passed', 'pr-open', 'done', ?)`,
      )
      .run(task.task_id, attempt.attempt_id, now);
    deps.db.exec("COMMIT");
    return { task_id: task.task_id, action: "ci_passed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function scheduleCiFailRetry(
  deps: TickDeps,
  task: PrOpenTaskRow,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
): TickTaskResult {
  const now = deps.clock.nowISO();
  const failureExcerpt = composeCiFailureExcerpt(snapshot);
  deps.db.exec("BEGIN");
  try {
    const excerpt = deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      kind: "ci_failure_excerpt",
      content: failureExcerpt,
      extension: "txt",
    });
    scheduleDeterministicRetry(deps, {
      taskId: task.task_id,
      prevAttempt: attempt,
      reason: "ci_fail",
      diagnostics: failureExcerpt,
      fromState: "pr-open",
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, 'ci_failed', 'pr-open', (SELECT state FROM tasks WHERE task_id = ?), ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        task.task_id,
        excerpt.artifactId,
        now,
      );
    deps.db.exec("COMMIT");
    return { task_id: task.task_id, action: "ci_failed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function composeCiFailureExcerpt(snapshot: PrSnapshot): string {
  if (snapshot.checks.failureExcerpt) return snapshot.checks.failureExcerpt;
  const fails = snapshot.checks.items
    .filter((c) => c.bucket === "fail" || c.bucket === "cancelled")
    .map((c) => `${c.workflow ?? "<no-workflow>"}/${c.name} = ${c.bucket}`);
  if (fails.length === 0) return "CI failed.";
  return ["CI failed:", ...fails.map((s) => `  - ${s}`)].join("\n");
}

function scheduleConflictNonBudget(
  deps: TickDeps,
  taskId: string,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
  observation: string,
  fromState: "pr-open" | "done",
  options: TickOptions,
): TickTaskResult {
  const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
  const sliceContent = JSON.stringify({
    head_sha: snapshot.headSha,
    base_sha: snapshot.baseSha,
    mergeable: snapshot.mergeable,
  });
  const result = scheduleNonBudgetRespawn(deps, {
    taskId,
    prevAttempt: attempt,
    reason: "conflict",
    diagnostics: `GitHub reports mergeable=${snapshot.mergeable} for head=${snapshot.headSha} base=${snapshot.baseSha ?? "<unknown>"}.`,
    fromState,
    snapshotKind: "conflict_slice",
    snapshotContent: sliceContent,
    snapshotExtension: "json",
    dedupeColumn: "last_conflict_observation",
    dedupeValue: observation,
    maxNonBudgetRespawns: cap,
  });
  if (result.outcome === "parked") {
    return { task_id: taskId, action: "non_budget_loop_parked" };
  }
  if (result.outcome === "scheduled") {
    return { task_id: taskId, action: "conflict_respawn_scheduled" };
  }
  return { task_id: taskId, action: "skipped_predicate" };
}

function scheduleReviewNonBudget(
  deps: TickDeps,
  taskId: string,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
  fromState: "done",
  options: TickOptions,
): TickTaskResult {
  const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
  const reviewId = snapshot.latestReview.latestReviewId!;
  const commentsContent = JSON.stringify({
    review_id: reviewId,
    decision: snapshot.latestReview.decision,
    comments: snapshot.latestReview.comments,
  });
  const result = scheduleNonBudgetRespawn(deps, {
    taskId,
    prevAttempt: attempt,
    reason: "review",
    diagnostics: `Reviewer marked CHANGES_REQUESTED in review ${reviewId}.`,
    fromState,
    snapshotKind: "review_comments",
    snapshotContent: commentsContent,
    snapshotExtension: "json",
    dedupeColumn: "last_review_id_acted_on",
    dedupeValue: reviewId,
    maxNonBudgetRespawns: cap,
  });
  if (result.outcome === "parked") {
    return { task_id: taskId, action: "non_budget_loop_parked" };
  }
  if (result.outcome === "scheduled") {
    return { task_id: taskId, action: "review_respawn_scheduled" };
  }
  return { task_id: taskId, action: "skipped_predicate" };
}

function formatConflictObservation(snapshot: PrSnapshot): string {
  const base = snapshot.baseSha ?? "";
  return `${snapshot.headSha}:${base}`;
}

function loadRepoForTask(
  db: DB,
  taskId: string,
): { ci_workflow_name: string | null } | null {
  return (
    db
      .query<{ ci_workflow_name: string | null }, [string]>(
        `SELECT r.ci_workflow_name AS ci_workflow_name
           FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
          WHERE t.task_id = ?`,
      )
      .get(taskId) ?? null
  );
}

function processClaimedTask(
  deps: TickDeps,
  task: ClaimedTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  // Cancel intent is the slice-7 finalizer's responsibility; skip cleanly.
  if (task.cancel_requested_at !== null) return null;
  if (task.claimed_at === null) return null;

  const claimTimeoutSeconds =
    options.claimTimeoutSeconds ?? DEFAULT_CLAIM_TIMEOUT_SECONDS;
  const maxClaimExpirations =
    options.maxClaimExpirations ?? DEFAULT_MAX_CLAIM_EXPIRATIONS;

  const nowMs = Date.parse(deps.clock.nowISO());
  const claimedMs = Date.parse(task.claimed_at);
  if (nowMs - claimedMs <= claimTimeoutSeconds * 1000) return null;

  const now = deps.clock.nowISO();
  const newCount = task.claim_expirations_consecutive + 1;
  const parking = newCount >= maxClaimExpirations;
  const targetState = parking ? "orchestrator_loop" : "awaiting-next-brief";

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = ?,
                claim_id = NULL,
                claimed_at = NULL,
                claim_expirations_consecutive = ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'claimed-by-orchestrator'
            AND cancel_requested_at IS NULL`,
      )
      .run(targetState, newCount, now, task.task_id);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return null;
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, 'claim_expired', 'claimed-by-orchestrator', ?, ?)`,
      )
      .run(task.task_id, targetState, now);
    if (parking) {
      deps.db
        .query(
          `INSERT INTO events (
             task_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, 'orchestrator_loop_parked', 'claimed-by-orchestrator', 'orchestrator_loop', ?)`,
        )
        .run(task.task_id, now);
    }
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    task_id: task.task_id,
    action: parking ? "orchestrator_loop_parked" : "claim_expired",
  };
}

interface EscalationArtifactRow {
  artifact_id: number;
  attempt_id: number | null;
  task_id: string;
  escalation_seq: number | null;
  escalation_nonce: string | null;
  content_hash: string | null;
  slack_pre_post_fence_ts: string | null;
  slack_post_ts: string | null;
  slack_recovered_post_ts: string | null;
  file_path: string;
}

function loadLatestEscalationArtifact(
  db: DB,
  taskId: string,
): EscalationArtifactRow | null {
  return (
    db
      .query<EscalationArtifactRow, [string]>(
        `SELECT artifact_id, attempt_id, task_id, escalation_seq,
                escalation_nonce, content_hash, slack_pre_post_fence_ts,
                slack_post_ts, slack_recovered_post_ts, file_path
           FROM artifacts
          WHERE task_id = ? AND kind = 'slack_escalation_post'
          ORDER BY artifact_id DESC LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function processWaitingHumanTask(
  deps: TickDeps,
  task: WaitingHumanTaskRow,
): TickTaskResult[] {
  if (task.cancel_requested_at !== null) return [];
  if (task.slack_thread_ref === null) {
    // No thread to post into; nothing to do.
    return [];
  }

  const art = loadLatestEscalationArtifact(deps.db, task.task_id);
  if (!art || art.attempt_id === null || art.escalation_nonce === null) {
    return [];
  }

  const results: TickTaskResult[] = [];
  const threadRef = task.slack_thread_ref;

  // Step 1: capture the pre-post fence if not yet captured.
  if (art.slack_pre_post_fence_ts === null) {
    const fenceTs = deps.slack.fenceTs(threadRef);
    const upd = deps.db
      .query(
        `UPDATE artifacts
            SET slack_pre_post_fence_ts = ?
          WHERE artifact_id = ?
            AND slack_pre_post_fence_ts IS NULL`,
      )
      .run(fenceTs, art.artifact_id);
    const changed = (upd as { changes?: number }).changes ?? 0;
    if (changed > 0) {
      art.slack_pre_post_fence_ts = fenceTs;
      results.push({ task_id: task.task_id, action: "slack_fence_captured" });
    }
  }

  // Step 2: try to recover an existing post via the nonce.
  if (art.slack_recovered_post_ts === null) {
    const match = deps.slack.searchByNonce(threadRef, art.escalation_nonce);
    if (match !== null) {
      // Persist recovered ts (and slack_post_ts if NULL) in one txn.
      // Predicate: cancel_requested_at IS NULL on the task row.
      deps.db.exec("BEGIN IMMEDIATE");
      try {
        const guard = deps.db
          .query<{ n: number }, [string]>(
            `SELECT 1 AS n FROM tasks
              WHERE task_id = ? AND cancel_requested_at IS NULL`,
          )
          .get(task.task_id);
        if (!guard) {
          deps.db.exec("ROLLBACK");
          return results;
        }
        deps.db
          .query(
            `UPDATE artifacts
                SET slack_recovered_post_ts = ?,
                    slack_post_ts = COALESCE(slack_post_ts, ?)
              WHERE artifact_id = ?
                AND slack_recovered_post_ts IS NULL`,
          )
          .run(match.ts, match.ts, art.artifact_id);
        deps.db.exec("COMMIT");
        art.slack_recovered_post_ts = match.ts;
        if (art.slack_post_ts === null) art.slack_post_ts = match.ts;
        clearTickError(deps, task.task_id);
        results.push({ task_id: task.task_id, action: "slack_post_recovered" });
        fireFailpoint("after_slack_recovery_ts_commit");
      } catch (err) {
        try {
          deps.db.exec("ROLLBACK");
        } catch {}
        throw err;
      }
    }
  }

  // Step 3: post if no recovery match and no post yet.
  if (art.slack_post_ts === null && art.slack_recovered_post_ts === null) {
    const body = readEscalationBody(art.file_path);
    const composedBody = `${body}\n\n_${art.escalation_nonce}_`;
    let postTs: string;
    try {
      postTs = deps.slack.post({ threadRef, body: composedBody }).ts;
    } catch (err) {
      // Slack API failure: log tick_error and skip; next tick retries.
      // The artifact stays without slack_post_ts so the recovery loop
      // re-enters here on the next tick.
      results.push(recordTickError(deps, task.task_id, err));
      return results;
    }
    fireFailpoint("after_slack_post");
    deps.db.exec("BEGIN IMMEDIATE");
    try {
      const guard = deps.db
        .query<{ n: number }, [string]>(
          `SELECT 1 AS n FROM tasks
            WHERE task_id = ? AND cancel_requested_at IS NULL`,
        )
        .get(task.task_id);
      if (!guard) {
        deps.db.exec("ROLLBACK");
        return results;
      }
      deps.db
        .query(
          `UPDATE artifacts
              SET slack_post_ts = ?,
                  slack_recovered_post_ts = ?
            WHERE artifact_id = ?
              AND slack_post_ts IS NULL`,
        )
        .run(postTs, postTs, art.artifact_id);
      deps.db.exec("COMMIT");
      art.slack_post_ts = postTs;
      art.slack_recovered_post_ts = postTs;
      clearTickError(deps, task.task_id);
      results.push({ task_id: task.task_id, action: "slack_posted" });
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
    return results;
  }

  // Step 4: ingest replies. Lower bound is recovered ts when known, else
  // the pre-post fence.
  const lowerBound =
    art.slack_recovered_post_ts !== null
      ? art.slack_recovered_post_ts
      : art.slack_pre_post_fence_ts;
  if (lowerBound === null) {
    return results;
  }
  const replies = deps.slack.listReplies(threadRef, lowerBound);
  const lb = Number(lowerBound);
  const firstNonBot = replies.find(
    (r) => !r.authorBot && Number(r.ts) > lb,
  );
  if (!firstNonBot) {
    clearTickError(deps, task.task_id);
    if (results.length === 0) results.push({ task_id: task.task_id, action: "slack_skipped" });
    return results;
  }

  ingestSlackReply(deps, task, art, firstNonBot);
  results.push({ task_id: task.task_id, action: "slack_reply_ingested" });
  return results;
}

function readEscalationBody(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `unable to read slack_escalation_post artifact at ${filePath}: ${message}`,
    );
  }
}

function ingestSlackReply(
  deps: TickDeps,
  task: WaitingHumanTaskRow,
  art: EscalationArtifactRow,
  reply: { ts: string; authorBot: boolean; text: string },
): void {
  const attemptId = art.attempt_id!;
  const replyContent = JSON.stringify({
    ts: reply.ts,
    text: reply.text,
    authorBot: reply.authorBot,
  });
  const replyContentHash = createHash("sha256").update(replyContent).digest("hex");

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const guard = deps.db
      .query<{ n: number }, [string]>(
        `SELECT 1 AS n FROM tasks
          WHERE task_id = ? AND state = 'waiting_human' AND cancel_requested_at IS NULL`,
      )
      .get(task.task_id);
    if (!guard) {
      deps.db.exec("ROLLBACK");
      return;
    }

    const artifact = deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId,
      kind: "slack_reply",
      content: replyContent,
      extension: "json",
    });
    // Set the explicit content_hash so it matches what the recovery-path
    // partial unique index expects (the artifact store already wrote it,
    // but content_hash can also act as the cursor for downstream reads).
    deps.db
      .query(`UPDATE artifacts SET content_hash = ? WHERE artifact_id = ?`)
      .run(replyContentHash, artifact.artifactId);

    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'awaiting-next-brief',
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'waiting_human'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changed = (upd as { changes?: number }).changes ?? 0;
    if (changed === 0) {
      deps.db.exec("ROLLBACK");
      return;
    }

    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, 'slack_reply_ingested', 'waiting_human', 'awaiting-next-brief', ?, ?)`,
      )
      .run(task.task_id, attemptId, artifact.artifactId, now);

    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function loadLatestAttempt(db: DB, taskId: string): CurrentAttemptRow | null {
  return (
    db
      .query<CurrentAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, preamble_id,
                template_id, reason, consumed_budget,
                remote_sha_at_spawn, pr_existed_at_spawn, tmux_session,
                spawned_at, kill_intent
           FROM attempts
          WHERE task_id = ?
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function detectKillIntent(
  deps: TickDeps,
  attempt: CurrentAttemptRow,
  options: TickOptions,
): "wall_clock" | "stale" | null {
  if (attempt.spawned_at === null || attempt.tmux_session === null) return null;
  const nowMs = Date.parse(deps.clock.nowISO());
  const spawnedMs = Date.parse(attempt.spawned_at);
  const maxAttemptSeconds =
    options.maxAttemptDurationSeconds ?? DEFAULT_MAX_ATTEMPT_DURATION_SECONDS;
  if (nowMs - spawnedMs > maxAttemptSeconds * 1000) return "wall_clock";

  const freshMs = Date.parse(
    deps.tmux.logFreshness(attempt.tmux_session, attempt.spawned_at),
  );
  const stalenessSeconds =
    options.stalenessThresholdSeconds ?? DEFAULT_STALENESS_THRESHOLD_SECONDS;
  if (nowMs - freshMs > stalenessSeconds * 1000) return "stale";
  return null;
}

function setKillIntent(
  deps: TickDeps,
  taskId: string,
  attemptId: number,
  intent: "wall_clock" | "stale",
): void {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts SET kill_intent = ? WHERE attempt_id = ? AND kill_intent IS NULL`,
      )
      .run(intent, attemptId);
    deps.db
      .query(
        `INSERT INTO events (task_id, attempt_id, event_type, occurred_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        taskId,
        attemptId,
        intent === "wall_clock" ? "wall_clock_exceeded" : "stale_detected",
        now,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function finalizeKillIntent(
  deps: TickDeps,
  task: RunningTaskRow,
  attempt: CurrentAttemptRow,
  reason: "wall_clock" | "stale",
): void {
  if (attempt.tmux_session) {
    try {
      const log = deps.tmux.collectLog(attempt.tmux_session);
      if (log !== null) {
        deps.artifactStore.writeArtifact({
          taskId: task.task_id,
          attemptId: attempt.attempt_id,
          kind: "session_log",
          content: log,
          extension: "txt",
        });
      }
    } catch {}
  }

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = ?,
                ended_at = ?,
                kill_intent = NULL
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        reason === "wall_clock" ? "killed_wall_clock" : "killed_stale",
        now,
        attempt.attempt_id,
      );
    scheduleDeterministicRetry(deps, {
      taskId: task.task_id,
      prevAttempt: attempt,
      reason,
      diagnostics:
        reason === "wall_clock"
          ? "The live worker exceeded max_attempt_duration_seconds and was killed."
          : "The live worker stopped producing fresh logs past staleness_threshold_seconds and was killed.",
      fromState: "running",
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, ?, 'running', (SELECT state FROM tasks WHERE task_id = ?), ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        reason === "wall_clock" ? "wall_clock_killed" : "stale_killed",
        task.task_id,
        now,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function handleSpawnFailure(
  deps: TickDeps,
  task: RunningTaskRow,
  attempt: CurrentAttemptRow,
  options: TickOptions,
): TickTaskResult {
  const now = deps.clock.nowISO();
  const maxSpawnFailures =
    options.maxSpawnFailures ?? DEFAULT_MAX_SPAWN_FAILURES;
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'spawn_failed',
                ended_at = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(now, attempt.attempt_id);
    const updated = deps.db
      .query<{ n: number }, [number, string, string]>(
        `UPDATE tasks
            SET attempts_consumed = attempts_consumed - ?,
                spawn_failures_consecutive = spawn_failures_consecutive + 1,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
          RETURNING spawn_failures_consecutive AS n`,
      )
      .get(attempt.consumed_budget, now, task.task_id);
    const failures = updated?.n ?? 0;
    if (failures >= maxSpawnFailures) {
      deps.db
        .query(`UPDATE tasks SET state = 'worktree_error' WHERE task_id = ?`)
        .run(task.task_id);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, ?, 'worktree_error', 'running', 'worktree_error', ?)`,
        )
        .run(task.task_id, attempt.attempt_id, now);
    } else {
      scheduleCleanSpawnRetry(deps, { taskId: task.task_id, prevAttempt: attempt });
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, ?, 'spawn_failed', 'running', 'queued', ?)`,
        )
        .run(task.task_id, attempt.attempt_id, now);
    }
    deps.db.exec("COMMIT");
    return { task_id: task.task_id, action: "spawn_failed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function countRunning(db: DB): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks WHERE state = 'running'`,
    )
    .get();
  return row?.n ?? 0;
}

function loadPendingAttempt(db: DB, taskId: string): PendingAttemptRow | null {
  return (
    db
      .query<PendingAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, consumed_budget, preamble_id
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NULL`,
      )
      .get(taskId) ?? null
  );
}

function loadFinalPrompt(db: DB, taskId: string, attemptId: number): string {
  const row = db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
         ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, attemptId);
  if (!row) {
    throw new Error(`missing final_prompt artifact for task ${taskId} attempt ${attemptId}`);
  }
  try {
    return readFileSync(row.file_path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`unable to read final_prompt artifact for task ${taskId} attempt ${attemptId}: ${message}`);
  }
}

function promoteAndSpawn(
  deps: TickDeps,
  task: QueuedTaskRow,
  agentInvocation: string,
): TickTaskResult {
  if (task.cancel_requested_at !== null) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  const pending = loadPendingAttempt(deps.db, task.task_id);
  if (!pending) {
    return { task_id: task.task_id, action: "skipped_no_pending_attempt" };
  }
  const promptContent = loadFinalPrompt(deps.db, task.task_id, pending.attempt_id);

  // Refresh the remote branch ref and snapshot spawn-time inputs *before* the
  // promotion transaction. These reads are external; we don't want them inside
  // the SQL transaction that flips state.
  deps.git.fetch(task.repo_id, task.branch_name);
  const remoteSha = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  const prExisted = deps.github.prExistsForBranch(task.repo_id, task.branch_name)
    ? 1
    : 0;
  const now = deps.clock.nowISO();

  const promoted = runPromotionTransaction(deps.db, {
    taskId: task.task_id,
    attemptId: pending.attempt_id,
    consumedBudget: pending.consumed_budget,
    spawnedAt: now,
    remoteSha,
    prExisted,
  });
  if (!promoted) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  // Substrate work happens outside the transaction. If spawn throws, the row
  // stays in (state = running, tmux_session = NULL); the slice-4 spawn-window
  // classifier recovers via the canonical session name.
  const sessionName = `quay-task-${task.tmux_id}-${pending.attempt_number}`;
  try {
    deps.tmux.spawn({
      sessionName,
      worktreePath: task.worktree_path,
      promptContent,
      agentInvocation,
    });
  } catch (err) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Test-only failpoint: tmux session created, attempts.tmux_session not yet
  // recorded. Lets tests exercise the spawn-window recovery branch
  // deterministically.
  fireFailpoint("after_tmux_session_created");

  // Record session AFTER successful substrate spawn so the spawn-failure
  // window (running + tmux_session NULL) is real. Resetting
  // spawn_failures_consecutive here (and not inside the promotion txn) is
  // load-bearing: a substrate failure between promotion and this point must
  // leave the consecutive counter intact so it can accumulate across ticks.
  deps.db
    .query(`UPDATE attempts SET tmux_session = ? WHERE attempt_id = ?`)
    .run(sessionName, pending.attempt_id);
  deps.db
    .query(`UPDATE tasks SET spawn_failures_consecutive = 0 WHERE task_id = ?`)
    .run(task.task_id);

  return { task_id: task.task_id, action: "spawned" };
}

function recordTickError(deps: TickDeps, taskId: string, err: unknown): TickTaskResult {
  const message = err instanceof Error ? err.message : String(err);
  const now = deps.clock.nowISO();
  try {
    deps.db.exec("BEGIN");
    deps.db
      .query(`UPDATE tasks SET tick_error = ?, updated_at = ? WHERE task_id = ?`)
      .run(message, now, taskId);
    deps.db
      .query(
        `INSERT INTO events (task_id, event_type, occurred_at)
         VALUES (?, 'tick_error', ?)`,
      )
      .run(taskId, now);
    deps.db.exec("COMMIT");
  } catch {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
  }
  return { task_id: taskId, action: "tick_error", error: message };
}

function clearTickError(deps: TickDeps, taskId: string): void {
  deps.db
    .query(
      `UPDATE tasks
          SET tick_error = NULL,
              updated_at = ?
        WHERE task_id = ?
          AND tick_error IS NOT NULL`,
    )
    .run(deps.clock.nowISO(), taskId);
}

interface PromotionInput {
  taskId: string;
  attemptId: number;
  consumedBudget: number;
  spawnedAt: string;
  remoteSha: string | null;
  prExisted: number;
}

function runPromotionTransaction(db: DB, p: PromotionInput): boolean {
  db.exec("BEGIN");
  try {
    const taskUpdate = db
      .query(
      `UPDATE tasks
          SET state = 'running',
              attempts_consumed = attempts_consumed + ?,
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ?
            AND state = 'queued'
            AND cancel_requested_at IS NULL`,
      )
      .run(p.consumedBudget, p.spawnedAt, p.taskId);

    const taskChanges = (taskUpdate as { changes?: number }).changes ?? 0;
    if (taskChanges === 0) {
      db.exec("ROLLBACK");
      return false;
    }

    db.query(
      `UPDATE attempts
          SET spawned_at = ?,
              remote_sha_at_spawn = ?,
              pr_existed_at_spawn = ?
        WHERE attempt_id = ? AND spawned_at IS NULL`,
    ).run(p.spawnedAt, p.remoteSha, p.prExisted, p.attemptId);

    db.query(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, ?, 'spawned', 'queued', 'running', ?)`,
    ).run(p.taskId, p.attemptId, p.spawnedAt);

    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

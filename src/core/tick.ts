import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort, PostedReview, PrSnapshot } from "../ports/github.ts";
import type { LinearPort } from "../ports/linear.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { PaneExitInfo, TmuxPort } from "../ports/tmux.ts";
import { probeAgentIdentity } from "./agent_identity.ts";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_CLAUDE_WORKER_INVOCATION,
  type AgentResolver,
  type AgentRole,
  type ResolvedAgent,
} from "./agents.ts";
import { runCancelFinalizer } from "./cancel.ts";
import { EXIT_INFO_NONE } from "./exit_status.ts";
import {
  LINEAR_STATE_IN_PROGRESS,
  LinearSyncQueue,
} from "./linear_state_sync.ts";
import { collectToolTraceArtifact } from "./tool_trace.ts";
import { collectUsageArtifact } from "./usage.ts";
import {
  classifyAndApply,
  type ClassifyContextAttempt,
  type ClassifyContextTask,
  type ClassifyOutcome,
} from "./classifier.ts";
import { classifyCi } from "./ci_status.ts";
import { fireFailpoint } from "./failpoints.ts";
import { scheduleNonBudgetRespawn } from "./non_budget_respawn.ts";
import { enterReview, isSyntheticTaskId } from "./pr_review.ts";
import {
  scheduleCleanSpawnRetry,
  scheduleDeterministicRetry,
  type BudgetRetryReason,
} from "./retries.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_CONCURRENT_REVIEWERS = 2;
export const DEFAULT_MAX_ATTEMPT_DURATION_SECONDS = 3600;
export const DEFAULT_STALENESS_THRESHOLD_SECONDS = 600;
export const DEFAULT_MAX_SPAWN_FAILURES = 3;
export const DEFAULT_CLAIM_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_CLAIM_EXPIRATIONS = 3;
export const DEFAULT_MAX_NON_BUDGET_RESPAWNS = 20;
// Canonical claude worker template, kept here as a named re-export so
// callers that imported it from `tick.ts` before the agent-resolver
// refactor (and tests that still pass `agentInvocation: "..."` as a
// shorthand) don't have to chase the rename.
//
// `--output-format json` makes claude print one final JSON envelope
// (tokens, cost, model id, full response) to stdout instead of the
// streaming human-readable text. We redirect that stdout to
// `.quay-usage.json` in the worktree so the dead-worker classifier
// can ingest it as a `usage` artifact.
//
// `--debug --debug-file .quay-tool-trace.log` captures claude's
// tool-dispatch / API events into a worktree-local file, ingested
// as a `tool_trace` artifact. This is the highest-signal data for
// prompt iteration; without it, only the final stdout reaches the
// session log and intermediate tool calls vanish.
//
// Operators with non-claude agent runtimes (Codex, Cursor, ...)
// register their own entry under `[agents.invocations]` and either
// emit the same `.quay-usage.json` / `.quay-tool-trace.log` files for
// capture, or accept null cost / no trace for those attempts.
export const DEFAULT_AGENT_INVOCATION = DEFAULT_CLAUDE_WORKER_INVOCATION;

export interface TickDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  slack: SlackPort;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
  // Passed through to runCancelFinalizer so the cancel sweep also picks
  // up the writeback without a separate wiring.
  linear?: LinearPort;
}

export interface TickOptions {
  maxConcurrent?: number;
  maxConcurrentReviewers?: number;
  reviewerEnabled?: boolean;
  gateQuayOwnedDone?: boolean;
  // gh login of the reviewer worker; threaded into fetchPostedReview so the
  // ingest matches the right author when tick and worker authenticate as
  // different identities. Defaults to whatever `gh api user` reports.
  reviewerLogin?: string;
  // Either `agentResolver` (production: looks up the registered agent
  // for a given (repo_id, role)) or `agentInvocation` (test shorthand:
  // same string for every attempt). When both are set, the resolver
  // wins. When neither is set, every attempt runs the built-in claude
  // default. `agentInvocation` is kept around so tests that just want
  // "run `bun --version` as the worker" don't have to construct a
  // resolver and a fake DB row.
  agentResolver?: AgentResolver;
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
  | "review_requested"
  | "review_approved"
  | "review_changes_requested"
  | "review_errored"
  | "review_retry_scheduled"
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
  external_ref: string | null;
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

interface ReviewAttemptTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  pr_number: number | null;
  cancel_requested_at: string | null;
  review_infra_failures_consecutive: number;
  review_infra_failure_head_sha: string | null;
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  head_sha: string;
  tmux_session: string | null;
  spawned_at: string | null;
  kill_intent: string | null;
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

export async function tick_once(
  deps: TickDeps,
  options: TickOptions = {},
): Promise<TickTaskResult[]> {
  const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const agentResolver = resolveTickAgentResolver(options);
  // Linear writebacks are scheduled inside the lock but drained after it
  // releases, so a slow or unreachable Linear cannot extend the supervisor-
  // lock-held window and starve concurrent ticks / cancels.
  const linearSyncs = new LinearSyncQueue(deps.linear);
  // Spec §5: a tick that fires while another tick (or `quay cancel`) holds
  // the supervisor lock exits immediately without action — the next
  // scheduled fire retries. `tryRun` returns `acquired: false` in that case;
  // we surface it as an empty result list rather than throwing, so cron
  // observes a clean exit.
  const attempt = await deps.supervisorLock.tryRun(async () => {
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
        await runCancelFinalizer(deps, task.task_id, linearSyncs);
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
    const runningReviewSnapshot = readRunningReviewAttempts(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const pendingReviewSnapshot = readPendingReviewAttempts(deps.db).filter(
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
        const taskResults = await processWaitingHumanTask(deps, task, linearSyncs);
        for (const r of taskResults) results.push(r);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    if (options.reviewerEnabled === true) {
      // Reap any review-only attempts that were marked ended + kill_intent
      // but whose tmux session is still alive. enterReview sets kill_intent
      // before COMMIT and kills the session after; a crash in between would
      // otherwise leave the worker running. Idempotent: a dead session is a
      // no-op.
      reapAbandonedReviewers(deps);

      for (const task of runningReviewSnapshot) {
        try {
          const result = processRunningReviewAttempt(deps, task, options);
          if (result !== null) results.push(result);
        } catch (err) {
          results.push(recordTickError(deps, task.task_id, err));
        }
      }

      const reviewCap =
        options.maxConcurrentReviewers ?? DEFAULT_MAX_CONCURRENT_REVIEWERS;
      let reviewerRunningCount = countRunningReviewers(deps.db);
      for (const task of pendingReviewSnapshot) {
        if (reviewerRunningCount >= reviewCap) {
          results.push({ task_id: task.task_id, action: "skipped_capacity" });
          continue;
        }
        try {
          results.push(promoteAndSpawnReviewer(deps, task, agentResolver, options));
        } catch (err) {
          results.push(recordTickError(deps, task.task_id, err));
        }
        reviewerRunningCount = countRunningReviewers(deps.db);
      }
    }

    let runningCount = countRunning(deps.db);
    for (const task of queuedSnapshot) {
      if (runningCount >= max) {
        results.push({ task_id: task.task_id, action: "skipped_capacity" });
        continue;
      }
      try {
        results.push(promoteAndSpawn(deps, task, agentResolver, linearSyncs));
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
      // Re-read running count from the DB so terminal/non-promotion outcomes
      // don't drift the cap.
      runningCount = countRunning(deps.db);
    }

    return results;
  });
  // Drain Linear writebacks outside the supervisor lock so the network
  // round-trips do not extend the lock-held window. Still awaited before
  // tick_once returns so tests observe the writebacks deterministically.
  await linearSyncs.drain();
  return attempt.acquired ? attempt.value : [];
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
      `SELECT task_id, repo_id, branch_name, tmux_id, worktree_path,
              cancel_requested_at, external_ref
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
  authors_json: string | null;
  external_ref: string | null;
}

function readWaitingHuman(db: DB): WaitingHumanTaskRow[] {
  return db
    .query<WaitingHumanTaskRow, []>(
      `SELECT task_id, slack_thread_ref, cancel_requested_at, authors_json,
              external_ref
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

function readRunningReviewAttempts(db: DB): ReviewAttemptTaskRow[] {
  return db
    .query<ReviewAttemptTaskRow, []>(
      `SELECT t.task_id, t.repo_id, t.branch_name, t.tmux_id, t.worktree_path,
              t.pr_number, t.cancel_requested_at,
              t.review_infra_failures_consecutive,
              t.review_infra_failure_head_sha,
              a.attempt_id, a.attempt_number, a.preamble_id, a.head_sha,
              a.tmux_session, a.spawned_at, a.kill_intent
         FROM attempts a
         JOIN tasks t ON t.task_id = a.task_id
        WHERE t.state = 'pr-review'
          AND a.reason = 'review_only'
          AND a.spawned_at IS NOT NULL
          AND a.ended_at IS NULL
        ORDER BY a.attempt_id`,
    )
    .all();
}

function readPendingReviewAttempts(db: DB): ReviewAttemptTaskRow[] {
  return db
    .query<ReviewAttemptTaskRow, []>(
      `SELECT t.task_id, t.repo_id, t.branch_name, t.tmux_id, t.worktree_path,
              t.pr_number, t.cancel_requested_at,
              t.review_infra_failures_consecutive,
              t.review_infra_failure_head_sha,
              a.attempt_id, a.attempt_number, a.preamble_id, a.head_sha,
              a.tmux_session, a.spawned_at, a.kill_intent
         FROM attempts a
         JOIN tasks t ON t.task_id = a.task_id
        WHERE t.state = 'pr-review'
          AND a.reason = 'review_only'
          AND a.spawned_at IS NULL
          AND a.ended_at IS NULL
        ORDER BY a.attempt_id`,
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
    // same evidence classifier. No worker process ever started in this
    // window, so there's no OS-level exit to capture — pass NONE.
    const canonical = `quay-task-${task.tmux_id}-${attempt.attempt_number}`;
    try {
      deps.tmux.kill(canonical);
    } catch {}
    const res = classifyAndApply(deps, ctxTask, ctxAttempt, {
      sessionName: canonical,
      spawnWindow: true,
      exitInfo: EXIT_INFO_NONE,
    });
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
    const intent = detectKillIntent(deps, task, attempt, options);
    if (intent !== null) {
      setKillIntent(deps, task, attempt, intent);
      fireFailpoint("after_kill_intent_commit");
      deps.tmux.kill(attempt.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    return null;
  }

  // Worker pane is dead. Capture the OS-level exit observation once, here,
  // before classifier cleanup deletes the marker file the wrapper wrote
  // into the worktree. The captured pair is stamped onto the attempts
  // row by whichever terminal path runs next.
  const exitInfo = readExitInfo(deps, attempt.tmux_session, task.worktree_path);

  if (attempt.kill_intent === "wall_clock" || attempt.kill_intent === "stale") {
    const retryReason: BudgetRetryReason = attempt.kill_intent;
    finalizeKillIntent(deps, task, attempt, retryReason, exitInfo);
    return {
      task_id: task.task_id,
      action: retryReason === "wall_clock" ? "wall_clock_killed" : "stale_killed",
    };
  }

  const res = classifyAndApply(
    { ...deps, artifactStore: deps.artifactStore },
    ctxTask,
    ctxAttempt,
    { sessionName: attempt.tmux_session, spawnWindow: false, exitInfo },
  );
  return outcomeToResult(task.task_id, res.outcome, false);
}

function processRunningReviewAttempt(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  if (task.tmux_session === null) {
    return markReviewInfraFailure(
      deps,
      task,
      "reviewer spawn did not record a tmux session",
      EXIT_INFO_NONE,
      options,
    );
  }
  if (deps.tmux.isAlive(task.tmux_session)) return null;

  const exitInfo = readExitInfo(deps, task.tmux_session, task.worktree_path);
  const blockerPath = join(task.worktree_path, ".quay-blocked.md");
  if (existsSync(blockerPath)) {
    let blocker = "";
    try {
      blocker = readFileSync(blockerPath, "utf8");
    } catch (err) {
      blocker = `Unable to read reviewer blocker file: ${(err as Error).message}`;
    }
    try {
      rmSync(blockerPath, { force: true });
    } catch {}
    // markReviewInfraFailure persists the blocker as a review_blocker
    // artifact inside its txn. A second write here would collide on the
    // (task_id, attempt_id, kind, content_hash) unique index and roll
    // the whole transition back, leaving the task stuck on tick_error.
    return markReviewInfraFailure(deps, task, blocker, exitInfo, options);
  }

  if (task.pr_number === null) {
    return markReviewInfraFailure(
      deps,
      task,
      "review task has no pr_number",
      exitInfo,
      options,
    );
  }

  const posted = deps.github.fetchPostedReview(
    task.repo_id,
    task.pr_number,
    task.head_sha,
    options.reviewerLogin,
  );
  if (posted === null) {
    return markReviewInfraFailure(
      deps,
      task,
      `no Quay-authored review found at head SHA ${task.head_sha}`,
      exitInfo,
      options,
    );
  }
  if (posted.decision === "COMMENTED") {
    return markReviewInfraFailure(
      deps,
      task,
      `review ${posted.reviewId} used COMMENTED instead of an approve/request-changes verdict`,
      exitInfo,
      options,
    );
  }
  return finalizePostedReview(deps, task, posted, exitInfo, options);
}

// Worker exit info is best-effort: a missing marker file (worker exec'd
// itself, was killed before the wrapper's printf ran) should never block
// the dead-worker path. EXIT_INFO_NONE leaves both columns NULL, which
// is indistinguishable from a pre-migration row for downstream consumers.
function readExitInfo(
  deps: TickDeps,
  sessionName: string,
  worktreePath: string,
): PaneExitInfo {
  try {
    return deps.tmux.getExitInfo(sessionName, worktreePath);
  } catch {
    return EXIT_INFO_NONE;
  }
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

  // Persist the PR's identifying metadata (number, url, head/base SHAs) onto
  // the task row before downstream branches can short-circuit (terminal
  // state, conflict, CI). The CLI/operator surface reads these columns; if
  // we wait until after CI passes we miss the entire pr-open window.
  persistPrMetadata(deps, task.task_id, snapshot);

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
    clearTickError(deps, task.task_id);
    return { task_id: task.task_id, action: "ci_pending" };
  }
  if (ci === "pass") {
    if (options.reviewerEnabled === true && options.gateQuayOwnedDone === true) {
      if (snapshot.prNumber === undefined || snapshot.prNumber === null) {
        return recordTickError(
          deps,
          task.task_id,
          new Error(
            `PR snapshot for ${task.branch_name} did not include a PR number; cannot enter pr-review`,
          ),
        );
      }
      const result = enterReview(
        {
          db: deps.db,
          clock: deps.clock,
          github: deps.github,
          artifactStore: deps.artifactStore,
          tmux: deps.tmux,
        },
        {
          repoId: task.repo_id,
          prNumber: snapshot.prNumber,
          headSha: snapshot.headSha,
          reviewerEnabled: true,
          gateQuayOwnedDone: true,
        },
      );
      return {
        task_id: task.task_id,
        action: result.scheduled ? "review_requested" : "skipped_predicate",
      };
    }
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

  // Same writeback as the pr-open path: keep PR metadata current while we
  // poll for review feedback / merge state in the done branch.
  persistPrMetadata(deps, task.task_id, snapshot);

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

  clearTickError(deps, task.task_id);
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

function finalizePostedReview(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  options: TickOptions,
): TickTaskResult {
  const verdict =
    posted.decision === "APPROVED" ? "approved" : "changes_requested";
  const content = reviewArtifactContent(posted, task.head_sha);
  const now = deps.clock.nowISO();
  // CHANGES_REQUESTED on a Quay-owned task hands the rest of the work off to
  // scheduleNonBudgetRespawn (its own transaction). For every other case the
  // attempt-end, counter-reset, artifact write, task transition, and event
  // insert must all commit atomically: a crash between two transactions
  // would otherwise strand the task in pr-review with no active reviewer.
  const handOffToRespawn =
    verdict === "changes_requested" && !isSyntheticTaskId(task.task_id);

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET ended_at = ?,
                exit_kind = ?,
                exit_code = ?,
                exit_signal = ?,
                review_verdict = ?,
                review_id = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        now,
        verdict === "approved" ? "review_approved" : "review_changes_requested",
        exitInfo.exitCode,
        exitInfo.exitSignal,
        verdict,
        posted.reviewId,
        task.attempt_id,
      );
    deps.db
      .query(
        `UPDATE tasks
            SET review_infra_failures_consecutive = 0,
                review_infra_failure_head_sha = NULL,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?`,
      )
      .run(now, task.task_id);

    if (!handOffToRespawn) {
      // Artifact write joins this transaction (the INSERT into `artifacts`
      // participates in the open BEGIN); a ROLLBACK below also rolls back
      // the artifact row. The file on disk is harmless orphan content with
      // a hash-derived name — it would be re-written byte-identical on a
      // retry of the same review.
      const artifact = deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: task.attempt_id,
        kind: "review_comments",
        content,
        extension: "json",
      });
      const toState =
        verdict === "approved" ? "done" : "waiting_external_changes";
      const eventType =
        verdict === "approved" ? "review_approved" : "changes_requested";
      deps.db
        .query(
          `UPDATE tasks
              SET state = ?,
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND state = 'pr-review'
              AND cancel_requested_at IS NULL`,
        )
        .run(toState, now, task.task_id);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state,
             payload_artifact_id, occurred_at
           ) VALUES (?, ?, ?, 'pr-review', ?, ?, ?)`,
        )
        .run(
          task.task_id,
          task.attempt_id,
          eventType,
          toState,
          artifact.artifactId,
          now,
        );
    }

    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  if (handOffToRespawn) {
    const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
    const codePreambleId = loadLatestCodePreambleId(deps.db) ?? task.preamble_id;
    const result = scheduleNonBudgetRespawn(deps, {
      taskId: task.task_id,
      prevAttempt: {
        attempt_id: task.attempt_id,
        attempt_number: task.attempt_number,
        preamble_id: codePreambleId,
      },
      reason: "review",
      diagnostics: `Quay reviewer marked CHANGES_REQUESTED in review ${posted.reviewId}.`,
      fromState: "pr-review",
      snapshotKind: "review_comments",
      snapshotContent: content,
      snapshotExtension: "json",
      dedupeColumn: "last_review_id_acted_on",
      dedupeValue: posted.reviewId,
      maxNonBudgetRespawns: cap,
    });
    if (result.outcome === "parked") {
      return { task_id: task.task_id, action: "non_budget_loop_parked" };
    }
    if (result.outcome === "scheduled") {
      return { task_id: task.task_id, action: "review_respawn_scheduled" };
    }
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  return {
    task_id: task.task_id,
    action:
      verdict === "approved" ? "review_approved" : "review_changes_requested",
  };
}

function markReviewInfraFailure(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  diagnostic: string,
  exitInfo: PaneExitInfo,
  options: TickOptions,
): TickTaskResult {
  const now = deps.clock.nowISO();
  const sameSha = task.review_infra_failure_head_sha === task.head_sha;
  const failures = sameSha ? task.review_infra_failures_consecutive + 1 : 1;
  const parking = failures >= 3;
  const priorBrief = loadAttemptArtifactContent(
    deps.db,
    task.task_id,
    task.attempt_id,
    "brief",
  );
  const priorPrompt = loadAttemptArtifactContent(
    deps.db,
    task.task_id,
    task.attempt_id,
    "final_prompt",
  );

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: task.attempt_id,
      kind: "review_blocker",
      content: diagnostic,
      extension: "md",
    });
    deps.db
      .query(
        `UPDATE attempts
            SET ended_at = ?,
                exit_kind = 'review_errored',
                exit_code = ?,
                exit_signal = ?,
                review_verdict = 'errored'
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(now, exitInfo.exitCode, exitInfo.exitSignal, task.attempt_id);
    deps.db
      .query(
        `UPDATE tasks
            SET review_infra_failures_consecutive = ?,
                review_infra_failure_head_sha = ?,
                state = ?,
                tick_error = ?,
                updated_at = ?
          WHERE task_id = ? AND state = 'pr-review'
            AND cancel_requested_at IS NULL`,
      )
      .run(
        failures,
        task.head_sha,
        parking ? "non_budget_loop" : "pr-review",
        parking ? diagnostic : null,
        now,
        task.task_id,
      );

    if (!parking) {
      const retryAttempt = deps.db
        .query<{ attempt_id: number }, [string, number, number, string, number, string]>(
          `INSERT INTO attempts (
             task_id, attempt_number, preamble_id, reason, consumed_budget, head_sha
           ) VALUES (?, ?, ?, ?, ?, ?)
           RETURNING attempt_id`,
        )
        .get(
          task.task_id,
          task.attempt_number + 1,
          task.preamble_id,
          "review_only",
          0,
          task.head_sha,
        );
      if (!retryAttempt) throw new Error("review retry insert returned no row");
      deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: retryAttempt.attempt_id,
        kind: "brief",
        content: priorBrief,
        extension: "md",
      });
      deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: retryAttempt.attempt_id,
        kind: "final_prompt",
        content: priorPrompt,
        extension: "md",
      });
    }

    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, 'review_infra_failed', 'pr-review', ?, ?)`,
      )
      .run(
        task.task_id,
        task.attempt_id,
        parking ? "non_budget_loop" : "pr-review",
        now,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    task_id: task.task_id,
    action: parking ? "non_budget_loop_parked" : "review_retry_scheduled",
  };
}

function reviewArtifactContent(posted: PostedReview, headSha: string): string {
  return JSON.stringify({
    review_id: posted.reviewId,
    decision: posted.decision,
    head_sha: headSha,
    body: posted.body,
    comments: posted.comments,
  });
}

function loadLatestCodePreambleId(db: DB): number | null {
  const row = db
    .query<{ preamble_id: number }, []>(
      `SELECT preamble_id FROM preambles
        WHERE kind = 'code'
        ORDER BY preamble_id DESC
        LIMIT 1`,
    )
    .get();
  return row?.preamble_id ?? null;
}

function loadAttemptArtifactContent(
  db: DB,
  taskId: string,
  attemptId: number,
  kind: "brief" | "final_prompt",
): string {
  const row = db
    .query<{ file_path: string }, [string, number, string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = ?
        ORDER BY artifact_id DESC
        LIMIT 1`,
    )
    .get(taskId, attemptId, kind);
  if (!row) return "";
  try {
    return readFileSync(row.file_path, "utf8");
  } catch {
    return "";
  }
}

function formatConflictObservation(snapshot: PrSnapshot): string {
  // Key on the base ref *tip*, not `baseSha` (which is the merge-base — stable
  // across base advances by construction). Keying on the tip means a base
  // advance that may have worsened the conflict re-enters the respawn path
  // even when head is unchanged. Fall back to `baseSha` when the tip is
  // unavailable (unfetched base, older gh) so the key still has *some* base
  // component rather than collapsing to head-only.
  const base = snapshot.baseTipSha ?? snapshot.baseSha ?? "";
  return `${snapshot.headSha}:${base}`;
}

// COALESCE-write so a snapshot with a missing field (older gh, transient
// failure of the merge-base shell-out) never overwrites a previously
// captured value with NULL. head_sha follows the same pattern: if the
// snapshot returns it, we accept the new value (force-pushes legitimately
// rotate it); if not, we keep what's there.
function persistPrMetadata(
  deps: TickDeps,
  taskId: string,
  snapshot: PrSnapshot,
): void {
  const prNumber = snapshot.prNumber ?? null;
  const prUrl = snapshot.prUrl ?? null;
  const headSha = snapshot.headSha === "" ? null : snapshot.headSha;
  const baseSha = snapshot.baseSha;
  if (
    prNumber === null &&
    prUrl === null &&
    headSha === null &&
    baseSha === null
  ) {
    return;
  }
  try {
    deps.db
      .query(
        `UPDATE tasks
            SET pr_number = COALESCE(?, pr_number),
                pr_url    = COALESCE(?, pr_url),
                head_sha  = COALESCE(?, head_sha),
                base_sha  = COALESCE(?, base_sha)
          WHERE task_id = ?`,
      )
      .run(prNumber, prUrl, headSha, baseSha, taskId);
  } catch {
    // Best-effort: PR-metadata observability never blocks the state
    // machine. A SQL failure here will be retried on the next tick.
  }
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

async function processWaitingHumanTask(
  deps: TickDeps,
  task: WaitingHumanTaskRow,
  linearSyncs: LinearSyncQueue,
): Promise<TickTaskResult[]> {
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
    const fenceTs = await deps.slack.fenceTs(threadRef);
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
    const match = await deps.slack.searchByNonce(threadRef, art.escalation_nonce);
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
    const mentionPrefix = buildMentionPrefix(task.authors_json);
    const composedBody = `${mentionPrefix}${body}\n\n_${art.escalation_nonce}_`;
    let postTs: string;
    try {
      postTs = (await deps.slack.post({ threadRef, body: composedBody })).ts;
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
  const replies = await deps.slack.listReplies(threadRef, lowerBound);
  const lb = Number(lowerBound);
  const firstNonBot = replies.find(
    (r) => !r.authorBot && Number(r.ts) > lb,
  );
  if (!firstNonBot) {
    clearTickError(deps, task.task_id);
    if (results.length === 0) results.push({ task_id: task.task_id, action: "slack_skipped" });
    return results;
  }

  ingestSlackReply(deps, task, art, firstNonBot, linearSyncs);
  results.push({ task_id: task.task_id, action: "slack_reply_ingested" });
  return results;
}

// Bare Slack user-ID format, identical to the parser's check
// (src/core/quay_config_block.ts). Re-validated at the sink: `authors_json`
// is opaque text in the DB, so a tampered or future-malformed payload must
// not reach Slack mrkdwn — `<@!channel>` and similar shapes would render
// as a different control directive than a user mention.
const SLACK_USER_ID = /^U[A-Z0-9]+$/;

// Prepend `<@slack_id>` mentions for every author the adapter recorded on
// enqueue. Returns "" for legacy tasks (`authors_json IS NULL`), an empty
// array, or any malformed payload — the post path falls back to the
// unprefixed body in those cases. IDs that don't match the bare Slack
// user-ID shape are dropped (defense-in-depth against persisted-data
// tampering); if every ID is invalid, the prefix collapses to "".
function buildMentionPrefix(authorsJson: string | null): string {
  if (authorsJson === null) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(authorsJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "";
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const a of parsed) {
    if (
      a === null ||
      typeof a !== "object" ||
      typeof (a as { slack_id?: unknown }).slack_id !== "string"
    ) {
      continue;
    }
    const id = (a as { slack_id: string }).slack_id;
    if (!SLACK_USER_ID.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return "";
  return `${ids.map((id) => `<@${id}>`).join(" ")}\n\n`;
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
  linearSyncs: LinearSyncQueue,
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

  // Reaching this line implies the commit landed: every early-return guard
  // above exits before this point, and the catch block re-throws. Concurrent
  // writers that lose the UPDATE race took the early-return branch and
  // never get here.
  linearSyncs.enqueue(task.external_ref, LINEAR_STATE_IN_PROGRESS);
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
  task: { worktree_path: string },
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
    deps.tmux.logFreshness(
      attempt.tmux_session,
      task.worktree_path,
      attempt.spawned_at,
    ),
  );
  const stalenessSeconds =
    options.stalenessThresholdSeconds ?? DEFAULT_STALENESS_THRESHOLD_SECONDS;
  if (nowMs - freshMs > stalenessSeconds * 1000) return "stale";
  return null;
}

function setKillIntent(
  deps: TickDeps,
  task: RunningTaskRow,
  attempt: CurrentAttemptRow,
  intent: "wall_clock" | "stale",
): void {
  const now = deps.clock.nowISO();
  // Spawned-at is non-null on every running attempt (promotion sets it
  // before tmux_session); fall back to `now` defensively to keep the
  // event_data fields populated even if invariants slip in the future.
  const spawnedAt = attempt.spawned_at ?? now;
  const spawnedSecondsAgo = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(spawnedAt)) / 1000),
  );
  // For stale, the operator's diagnostic question is "what was the most
  // recent log byte mtime when we decided?" — captured here so the event
  // row is self-sufficient without a separate journal lookup.
  const lastLogAt =
    intent === "stale" && attempt.tmux_session !== null
      ? safeLogFreshness(deps, attempt.tmux_session, task.worktree_path, spawnedAt)
      : null;
  const eventData = JSON.stringify({
    intent,
    spawned_seconds_ago: spawnedSecondsAgo,
    ...(lastLogAt !== null ? { last_log_at: lastLogAt } : {}),
  });
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts SET kill_intent = ? WHERE attempt_id = ? AND kill_intent IS NULL`,
      )
      .run(intent, attempt.attempt_id);
    deps.db
      .query(
        `INSERT INTO events (task_id, attempt_id, event_type, occurred_at, event_data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        intent === "wall_clock" ? "wall_clock_exceeded" : "stale_detected",
        now,
        eventData,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function safeLogFreshness(
  deps: TickDeps,
  sessionName: string,
  worktreePath: string,
  spawnedAt: string,
): string | null {
  try {
    return deps.tmux.logFreshness(sessionName, worktreePath, spawnedAt);
  } catch {
    return null;
  }
}

function finalizeKillIntent(
  deps: TickDeps,
  task: RunningTaskRow,
  attempt: CurrentAttemptRow,
  reason: "wall_clock" | "stale",
  exitInfo: PaneExitInfo,
): void {
  if (attempt.tmux_session) {
    try {
      const log = deps.tmux.collectLog(
        attempt.tmux_session,
        task.worktree_path,
      );
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
  // Best-effort usage + tool-trace capture. A wall-clock kill mid-run
  // typically truncates `--output-format json` output (malformed
  // envelope, dropped), but the streaming `--debug-file` log already
  // has whatever events landed before the kill — so even killed
  // attempts usually produce a useful tool_trace. Clean exits racing
  // with a kill window produce a complete envelope and trace.
  collectUsageArtifact(deps, task.task_id, attempt.attempt_id, task.worktree_path);
  collectToolTraceArtifact(deps, task.task_id, attempt.attempt_id, task.worktree_path);

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = ?,
                ended_at = ?,
                kill_intent = NULL,
                exit_code = ?,
                exit_signal = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        reason === "wall_clock" ? "killed_wall_clock" : "killed_stale",
        now,
        exitInfo.exitCode,
        exitInfo.exitSignal,
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

function countRunningReviewers(db: DB): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE reason = 'review_only'
          AND spawned_at IS NOT NULL
          AND ended_at IS NULL`,
    )
    .get();
  return row?.n ?? 0;
}

// Closes the crash window between enterReview's COMMIT (which marks the
// attempt ended + kill_intent='superseded') and its tmux.kill call. After
// COMMIT the row falls out of every active-attempt view, so without this
// sweep the worker would keep running and could still post a review for the
// stale head SHA. We scan every tick for review-only attempts that have a
// recorded tmux session, a non-null kill_intent, and ended_at IS NOT NULL,
// then kill any session that's still alive. Idempotent: a dead session is a
// no-op, and once killed the row stays ended.
function reapAbandonedReviewers(deps: TickDeps): void {
  const rows = deps.db
    .query<{ tmux_session: string }, []>(
      `SELECT tmux_session FROM attempts
        WHERE reason = 'review_only'
          AND tmux_session IS NOT NULL
          AND kill_intent IS NOT NULL
          AND ended_at IS NOT NULL`,
    )
    .all();
  for (const row of rows) {
    if (!deps.tmux.isAlive(row.tmux_session)) continue;
    try {
      deps.tmux.kill(row.tmux_session);
    } catch {}
  }
}

function loadPendingAttempt(db: DB, taskId: string): PendingAttemptRow | null {
  return (
    db
      .query<PendingAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, consumed_budget, preamble_id
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NULL AND ended_at IS NULL`,
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
  agentResolver: AgentResolver,
  linearSyncs: LinearSyncQueue,
): TickTaskResult {
  const { agent: agentName, invocation: agentInvocation } = agentResolver.resolve(
    task.repo_id,
    "worker",
  );
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
  //
  // For a brand-new task the worker has not pushed `quay/<slug>` yet, so the
  // remote ref legitimately doesn't exist. `fetchBranchIfExists` tolerates
  // that case and lets `remoteHeadSha` return null — the spec records
  // `remote_sha_at_spawn = null` for the first attempt, so a missing remote
  // is the *expected* state, not a tick error.
  deps.git.fetchBranchIfExists(task.repo_id, task.branch_name);
  const remoteSha = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  const prExisted = deps.github.prExistsForBranch(task.repo_id, task.branch_name)
    ? 1
    : 0;
  const now = deps.clock.nowISO();

  // Probe agent identity and compute the canonical session name BEFORE the
  // promotion transaction so the `spawned` event can carry both in
  // `event_data`. The probe is documented as in-process and never throws;
  // computing the session name from `tmux_id` + `attempt_number` is pure.
  // Persisting `attempts.agent_identity` still happens AFTER spawn succeeds
  // (paired with `tmux_session`) — this earlier probe is event-only.
  const sessionName = `quay-task-${task.tmux_id}-${pending.attempt_number}`;
  const agentIdentity = probeAgentIdentity(agentInvocation);

  const promoted = runPromotionTransaction(deps.db, {
    taskId: task.task_id,
    attemptId: pending.attempt_id,
    attemptNumber: pending.attempt_number,
    branchName: task.branch_name,
    worktreePath: task.worktree_path,
    plannedSession: sessionName,
    agentIdentity,
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
  //
  // agent_identity is paired with tmux_session — both columns reflect what
  // the substrate actually accepted, so they're written together. The
  // earlier probe at promotion time only feeds the `spawned` event_data;
  // a spawn-failure leaves the column NULL.
  deps.db
    .query(
      `UPDATE attempts
          SET tmux_session = ?, agent_identity = ?, agent_name = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, agentIdentity, agentName, pending.attempt_id);
  deps.db
    .query(`UPDATE tasks SET spawn_failures_consecutive = 0 WHERE task_id = ?`)
    .run(task.task_id);

  linearSyncs.enqueue(task.external_ref, LINEAR_STATE_IN_PROGRESS);

  return { task_id: task.task_id, action: "spawned" };
}

function promoteAndSpawnReviewer(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  agentResolver: AgentResolver,
  options: TickOptions,
): TickTaskResult {
  const { agent: agentName, invocation: agentInvocation } = agentResolver.resolve(
    task.repo_id,
    "reviewer",
  );
  if (task.cancel_requested_at !== null) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }
  if (task.pr_number === null) {
    return markReviewInfraFailure(
      deps,
      task,
      "review task has no pr_number",
      EXIT_INFO_NONE,
      options,
    );
  }

  if (isSyntheticTaskId(task.task_id)) {
    try {
      deps.git.checkoutPullRequest(
        task.repo_id,
        task.worktree_path,
        task.pr_number,
        task.head_sha,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return markReviewInfraFailure(deps, task, message, EXIT_INFO_NONE, options);
    }
  }

  const promptContent = loadFinalPrompt(deps.db, task.task_id, task.attempt_id);
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    // For code workers `remote_sha_at_spawn` records what the remote looked
    // like when we spawned; for reviewer attempts the SHA we promised to
    // review is the only meaningful "remote SHA at spawn," so we reuse the
    // column to point at `attempts.head_sha`. `pr_existed_at_spawn` is 1 by
    // definition: there's nothing to review until a PR exists.
    const upd = deps.db
      .query(
        `UPDATE attempts
            SET spawned_at = ?,
                remote_sha_at_spawn = ?,
                pr_existed_at_spawn = 1
          WHERE attempt_id = ?
            AND spawned_at IS NULL
            AND ended_at IS NULL`,
      )
      .run(now, task.head_sha, task.attempt_id);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { task_id: task.task_id, action: "skipped_predicate" };
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, 'review_spawned', 'pr-review', 'pr-review', ?)`,
      )
      .run(task.task_id, task.attempt_id, now);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  const sessionName = `quay-review-${task.tmux_id}-${task.attempt_number}`;
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

  fireFailpoint("after_tmux_session_created");
  const agentIdentity = probeAgentIdentity(agentInvocation);
  deps.db
    .query(
      `UPDATE attempts
          SET tmux_session = ?, agent_identity = ?, agent_name = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, agentIdentity, agentName, task.attempt_id);

  return { task_id: task.task_id, action: "spawned" };
}

// Bridge between the test-friendly `agentInvocation` shorthand and the
// production `agentResolver`. When the caller supplies a full resolver
// we use it directly; otherwise we wrap the single invocation string
// (test default, or the legacy `agent_invocation =` config key) in a
// trivial resolver that ignores repo and role. The wrapped resolver
// reports the registered agent name as "claude" because the legacy key
// is documented as the claude template — the schema migration treats
// it as `[agents.invocations.claude]`.
function resolveTickAgentResolver(options: TickOptions): AgentResolver {
  if (options.agentResolver !== undefined) return options.agentResolver;
  const invocation = options.agentInvocation ?? DEFAULT_CLAUDE_WORKER_INVOCATION;
  const resolved: ResolvedAgent = { agent: DEFAULT_AGENT_NAME, invocation };
  return {
    resolve: (_repoId: string, _role: AgentRole) => resolved,
    registeredAgents: () => [DEFAULT_AGENT_NAME],
  };
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
  attemptNumber: number;
  branchName: string;
  worktreePath: string;
  // Canonical tmux session name we'll attempt to spawn into. Recorded in
  // the `spawned` event_data even when substrate spawn ultimately fails —
  // the event captures intent, the column captures observed reality.
  plannedSession: string;
  agentIdentity: string;
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

    // event_data captures the spawn-time intent: where the worker is going
    // to run (worktree, branch, tmux session), what we expect to invoke
    // (agent_identity), and the spawn-time progress predicate inputs. This
    // lets retro analysis correlate a spawn with later transitions without
    // having to join across multiple rows.
    const eventData = JSON.stringify({
      tmux_session: p.plannedSession,
      worktree_path: p.worktreePath,
      branch_name: p.branchName,
      attempt_number: p.attemptNumber,
      agent_identity: p.agentIdentity,
      remote_sha_at_spawn: p.remoteSha,
      pr_existed_at_spawn: p.prExisted === 1,
    });

    db.query(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state, occurred_at, event_data
       ) VALUES (?, ?, 'spawned', 'queued', 'running', ?, ?)`,
    ).run(p.taskId, p.attemptId, p.spawnedAt, eventData);

    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

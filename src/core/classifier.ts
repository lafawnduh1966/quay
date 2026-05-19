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
import type { GitHubPort, OpenBranchPr } from "../ports/github.ts";
import type { PaneExitInfo, TmuxPort } from "../ports/tmux.ts";
import { EXIT_INFO_NONE } from "./exit_status.ts";
import { fireFailpoint } from "./failpoints.ts";
import { enqueueOrchestratorHandoff } from "./orchestrator_handoffs.ts";
import { collectToolTraceArtifact } from "./tool_trace.ts";
import { collectUsageArtifact, persistResolvedAttemptModel } from "./usage.ts";
import {
  scheduleDeterministicRetry,
  writeBlockerBudgetExhausted,
} from "./retries.ts";
import {
  accountGoalAttempt,
  accountGoalFailureAndMaybeLimit,
  GOAL_CONTINUE_ATTEMPT_REASON,
  goalBudgetIsExhausted,
  loadGoalPromptContext,
  loadTaskGoal,
  NO_PROGRESS_ACTIVE_LIMIT,
  supersedeCurrentGoalHandoff,
} from "./goals.ts";
import {
  GOAL_REPORT_FILENAME,
  probeGoalReport,
  type GoalReport,
  type GoalReportProbe,
} from "./goal_report.ts";
import {
  captureGoalEvidenceArtifacts,
  type CapturedGoalEvidence,
} from "./goal_audit.ts";
import { ensurePreambleIdForAttemptReason, loadPreambleBody } from "./preamble.ts";
import {
  composeWorkerPrompt,
  loadTaskPrBaseBranch,
  loadOriginalTaskObjective,
} from "./worker_prompt.ts";

const BLOCKER_FILENAME = ".quay-blocked.md";
const BLOCKER_MAX_BYTES = 64 * 1024;
const MAX_GOAL_PROTOCOL_REPAIR_ATTEMPTS = 2;

export type ClassifyOutcome =
  | "blocker_written"
  | "goal_continuation_scheduled"
  | "goal_completion_pending"
  | "goal_budget_limited"
  | "goal_report_processed"
  | "malformed_signal"
  | "pr_opened"
  | "existing_pr_attached"
  | "no_progress"
  | "crashed"
  | "spawn_window_no_evidence";

export interface ClassifyContextTask {
  task_id: string;
  repo_id: string;
  branch_name: string;
  pr_number: number | null;
  tmux_id: string;
  worktree_path: string;
  state: string;
  base_branch: string | null;
  worker_execution: "oneshot" | "goal";
}

export interface ClassifyContextAttempt {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  remote_sha_at_spawn: string | null;
  pr_existed_at_spawn: number;
  tmux_session: string | null;
  spawned_at: string | null;
  goal_id: string | null;
  goal_report_processed_at: string | null;
}

export interface ClassifierDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  artifactStore: ArtifactStore;
  referenceReposRoot?: string | undefined;
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
  // OS-level exit observation captured by the caller before the classifier
  // runs (read from the worker shell's `.quay-exit-code` marker file).
  // Stamped alongside `exit_kind` on every terminal SQL update so retro
  // analysis can correlate the classification with the raw substrate
  // signal. EXIT_INFO_NONE on the spawn-window path (no real process
  // ran) and on any path where the marker file was missing or
  // unreadable.
  exitInfo?: PaneExitInfo;
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
  const exitInfo = options.exitInfo ?? EXIT_INFO_NONE;

  // Step 1: best-effort session log capture. Idempotent across re-entry via
  // the recovery-path content_hash unique index.
  collectSessionLog(deps, task, attempt, options.sessionName);

  // Step 1b: best-effort usage envelope capture. The spawn wrapper
  // writes `<worktree>/.quay-usage.json` for any agent invocation that
  // emits a structured stdout (claude `--output-format json`, similar
  // for Codex / Cursor). Idempotent via the same content_hash unique
  // index that protects session_log.
  const usageResult = collectUsageArtifact(
    deps,
    task.task_id,
    attempt.attempt_id,
    task.worktree_path,
  );
  persistResolvedAttemptModel(deps.db, attempt.attempt_id, usageResult.resolvedModel);

  // Step 1c: best-effort tool-trace capture (claude
  // `--debug --debug-file .quay-tool-trace.log`, equivalent for other
  // runtimes). Tail-read past 4 MiB. Idempotent via content_hash.
  collectToolTraceArtifact(deps, task.task_id, attempt.attempt_id, task.worktree_path);

  // Goal-mode workers report progress through .quay-goal-report.json. A valid
  // report wins over the legacy blocker file. A malformed report is preserved
  // and only falls back to .quay-blocked.md when that legacy blocker is valid.
  const goalReport =
    task.worker_execution === "goal"
      ? probeGoalReport(task.worktree_path)
      : null;
  if (goalReport?.kind === "valid") {
    const result = ingestValidGoalReport(
      deps,
      task,
      attempt,
      goalReport,
      exitInfo,
    );
    if (result !== null) return result;
  }
  if (goalReport?.kind === "malformed") {
    const malformedArtifactId = persistMalformedGoalReport(
      deps,
      task,
      attempt,
      goalReport,
    );
    const blockerPath = join(task.worktree_path, BLOCKER_FILENAME);
    const blockerProbe = probeBlockerFile(blockerPath);
    if (blockerProbe.kind === "valid") {
      return ingestBlocker(
        deps,
        task,
        attempt,
        blockerPath,
        blockerProbe.content,
        exitInfo,
        { malformedGoalReportArtifactId: malformedArtifactId },
      );
    }
    return scheduleMalformedGoalReportRetry(
      deps,
      task,
      attempt,
      goalReport,
      malformedArtifactId,
      exitInfo,
    );
  }

  // Step 2: blocker file (valid → ingest; malformed → persist + retry).
  const blockerPath = join(task.worktree_path, BLOCKER_FILENAME);
  const probe = probeBlockerFile(blockerPath);
  if (probe.kind === "valid") {
    return ingestBlocker(deps, task, attempt, blockerPath, probe.content, exitInfo);
  }
  if (probe.kind === "malformed") {
    return ingestMalformed(deps, task, attempt, blockerPath, probe.bytes, exitInfo);
  }

  // Step 3: fresh remote/PR snapshot for the progress predicate. Use the
  // tolerant fetch: a worker that died before pushing (spawn-window crash,
  // immediate exit) leaves `quay/<slug>` absent on origin, which is exactly
  // the "no remote progress" evidence the predicate below feeds on. A hard
  // fetch failure here would mask that as a tick_error instead.
  deps.git.fetchBranchIfExists(task.repo_id, task.branch_name);
  const remoteShaAtExit = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  const prDelivery =
    task.worker_execution === "goal"
      ? inspectGoalPrDelivery(deps, task)
      : {
          prExistsAtExit: deps.github.prExistsForBranch(
            task.repo_id,
            task.branch_name,
          ),
          reviewablePrExists: null,
          deliveredPrExists: false,
          terminalPrState: null,
          prNumber: null,
        };
  const prExistsAtExit = prDelivery.prExistsAtExit;
  const prExistedAtSpawn = attempt.pr_existed_at_spawn === 1;

  const remoteUnchanged =
    remoteShaAtExit === attempt.remote_sha_at_spawn || remoteShaAtExit === null;
  const prCreatedDuringAttempt = prExistsAtExit && !prExistedAtSpawn;
  const noProgress = remoteUnchanged && !prCreatedDuringAttempt;

  const predicate: PredicateState = {
    remoteUnchanged,
    prExistedAtSpawn,
    prExistsAtExit,
  };

  if (
    task.worker_execution === "goal" &&
    !prDelivery.deliveredPrExists
  ) {
    if (options.spawnWindow) {
      return { outcome: "spawn_window_no_evidence" };
    }
    return scheduleCrashRetry(
      deps,
      task,
      attempt,
      remoteShaAtExit,
      exitInfo,
      predicate,
      `Goal-mode worker exited without ${GOAL_REPORT_FILENAME}, a non-draft PR, or a valid blocker signal.`,
    );
  }

  if (prExistsAtExit && !noProgress) {
    return transitionPrOpened(deps, task, attempt, remoteShaAtExit, exitInfo);
  }
  if (prExistsAtExit && noProgress) {
    if (task.pr_number === null) {
      const attached = reconcileExistingOpenPr(
        deps,
        task,
        attempt,
        remoteShaAtExit,
        exitInfo,
        predicate,
      );
      if (attached !== null) return attached;
    }
    return scheduleNoProgressRetry(
      deps,
      task,
      attempt,
      remoteShaAtExit,
      exitInfo,
      predicate,
    );
  }
  if (options.spawnWindow) {
    // No evidence on the spawn-window path: the genuine spawn-failed default
    // (budget rollback + spawn_failures_consecutive) is owned by a later
    // slice. Leave the row untouched so that recovery converges later.
    return { outcome: "spawn_window_no_evidence" };
  }
  return scheduleCrashRetry(
    deps,
    task,
    attempt,
    remoteShaAtExit,
    exitInfo,
    predicate,
  );
}

interface PredicateState {
  remoteUnchanged: boolean;
  prExistedAtSpawn: boolean;
  prExistsAtExit: boolean;
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

interface GoalPrDelivery {
  prExistsAtExit: boolean;
  reviewablePrExists: boolean | null;
  deliveredPrExists: boolean;
  terminalPrState: "merged" | "closed_unmerged" | null;
  prNumber: number | null;
}

function inspectGoalPrDelivery(
  deps: ClassifierDeps,
  task: Pick<ClassifyContextTask, "repo_id" | "branch_name">,
): GoalPrDelivery {
  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot !== null) {
    const terminalPrState =
      snapshot.state === "merged" || snapshot.state === "closed_unmerged"
        ? snapshot.state
        : null;
    const reviewablePrExists =
      snapshot.state === "open" && snapshot.isDraft !== true;
    return {
      prExistsAtExit: true,
      reviewablePrExists,
      deliveredPrExists: reviewablePrExists || terminalPrState !== null,
      terminalPrState,
      prNumber: snapshot.prNumber ?? null,
    };
  }
  return {
    prExistsAtExit: deps.github.prExistsForBranch(task.repo_id, task.branch_name),
    reviewablePrExists: false,
    deliveredPrExists: false,
    terminalPrState: null,
    prNumber: null,
  };
}

function goalReportCanMutate(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
): boolean {
  if (attempt.goal_report_processed_at !== null) return false;
  if (attempt.goal_id === null) return false;
  const row = deps.db
    .query<{ n: number }, [string, string]>(
      `SELECT 1 AS n
         FROM task_goals
        WHERE task_id = ?
          AND goal_id = ?
          AND status = 'active'`,
    )
    .get(task.task_id, attempt.goal_id);
  return row !== null && row !== undefined;
}

function ingestValidGoalReport(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  probe: Extract<GoalReportProbe, { kind: "valid" }>,
  exitInfo: PaneExitInfo,
): ClassifyResult | null {
  const contentHash = sha256(probe.raw);
  const artifactId = upsertRecoveryArtifact(deps, {
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "goal_report",
    contentHash,
    content: probe.raw,
    extension: "json",
  });
  if (!goalReportCanMutate(deps, task, attempt)) {
    return null;
  }
  const evidence = captureGoalEvidenceArtifacts(deps, {
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    worktreePath: task.worktree_path,
    report: probe.report,
  });
  const delivery = inspectGoalPrDelivery(deps, task);
  deps.git.fetchBranchIfExists(task.repo_id, task.branch_name);
  const remoteShaAtExit = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  if (probe.report.status === "active") {
    return ingestActiveGoalReport(
      deps,
      task,
      attempt,
      probe.report,
      artifactId,
      remoteShaAtExit,
      delivery,
      exitInfo,
      probe.warnings,
      evidence,
    );
  }
  if (probe.report.status === "blocked") {
    return ingestBlockedGoalReport(
      deps,
      task,
      attempt,
      probe.report,
      artifactId,
      remoteShaAtExit,
      exitInfo,
      evidence,
    );
  }
  return ingestCompleteGoalReport(
    deps,
    task,
    attempt,
    probe.report,
    artifactId,
    remoteShaAtExit,
    delivery,
    exitInfo,
    evidence,
  );
}

function persistMalformedGoalReport(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  probe: Extract<GoalReportProbe, { kind: "malformed" }>,
): number {
  const contentHash = sha256Bytes(probe.raw);
  return upsertRecoveryArtifact(deps, {
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "malformed_goal_report",
    contentHash,
    content: probe.raw,
    extension: "bin",
  });
}

function scheduleMalformedGoalReportRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  probe: Extract<GoalReportProbe, { kind: "malformed" }>,
  artifactId: number,
  exitInfo: PaneExitInfo,
): ClassifyResult {
  if (!goalReportCanMutate(deps, task, attempt)) {
    return { outcome: "goal_report_processed" };
  }
  const now = deps.clock.nowISO();
  const diagnostics = `Worker wrote a malformed ${GOAL_REPORT_FILENAME}: ${probe.diagnostics}. The raw malformed bytes were persisted as malformed_goal_report artifact #${artifactId}.`;
  const repairsUsed = countGoalProtocolRepairAttempts(deps.db, task.task_id);
  deps.db.exec("BEGIN");
  try {
    const taskUpd = deps.db
      .query(
        `UPDATE tasks
            SET spawn_failures_consecutive = 0,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'running'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changes = (taskUpd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { outcome: "malformed_signal" };
    }
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'malformed_goal_report',
                ended_at = ?,
                exit_code = ?,
                exit_signal = ?,
                goal_report_processed_at = ?
          WHERE attempt_id = ?
            AND goal_report_processed_at IS NULL`,
      )
      .run(
        now,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        now,
        attempt.attempt_id,
      );

    if (repairsUsed >= MAX_GOAL_PROTOCOL_REPAIR_ATTEMPTS) {
      transitionGoalProtocolRepairExhaustedInOpenTxn(
        deps,
        task,
        attempt,
        diagnostics,
        artifactId,
        now,
        repairsUsed,
      );
      deps.db.exec("COMMIT");
      try {
        rmSync(probe.path, { force: true });
      } catch {}
      return { outcome: "blocker_written" };
    }

    const nextAttemptId = scheduleGoalProtocolRepairInOpenTxn(
      deps,
      task,
      attempt,
      diagnostics,
      now,
    );
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type,
           from_state, to_state, payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'malformed_goal_report_ingested', 'running', 'queued', ?, ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        artifactId,
        now,
        JSON.stringify({
          diagnostics: probe.diagnostics,
          next_attempt_id: nextAttemptId,
          repairs_used: repairsUsed + 1,
          max_repairs: MAX_GOAL_PROTOCOL_REPAIR_ATTEMPTS,
        }),
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  try {
    rmSync(probe.path, { force: true });
  } catch {}
  return { outcome: "malformed_signal" };
}

function countGoalProtocolRepairAttempts(db: DB, taskId: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ? AND reason = 'malformed_goal_report'`,
    )
    .get(taskId);
  return row?.n ?? 0;
}

function scheduleGoalProtocolRepairInOpenTxn(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  diagnostics: string,
  now: string,
): number {
  const preambleId = ensurePreambleIdForAttemptReason(
    deps.db,
    deps.clock,
    "malformed_goal_report",
  );
  const objective = loadOriginalTaskObjective(deps.db, task.task_id);
  const goalContext = loadGoalPromptContext(deps.db, task.task_id);
  const prBaseBranch = loadTaskPrBaseBranch(deps.db, task.task_id);
  const preambleBody = loadPreambleBody(deps.db, preambleId);
  const guidance = [
    "The previous goal-mode worker wrote an invalid .quay-goal-report.json.",
    "Repair the protocol error before continuing normal work.",
    "",
    "Required actions:",
    "- Inspect the malformed_goal_report artifact named in diagnostics.",
    "- Write a valid .quay-goal-report.json before exiting.",
    "- Do not open a duplicate PR.",
  ].join("\n");
  const composed = composeWorkerPrompt({
    preambleBody,
    taskObjective: objective,
    prBaseBranch,
    goalContext,
    referenceReposRoot: deps.referenceReposRoot,
    attemptGuidance: {
      reason: "malformed_goal_report",
      body: guidance,
    },
    diagnostics: {
      kind: "malformed_goal_report_details",
      body: diagnostics,
    },
  });

  const attemptRow = deps.db
    .query<
      { attempt_id: number },
      [string, number, number, string | null]
    >(
      `INSERT INTO attempts (
         task_id, attempt_number, preamble_id, reason, consumed_budget, goal_id
       ) VALUES (?, ?, ?, 'malformed_goal_report', 0, ?)
       RETURNING attempt_id`,
    )
    .get(
      task.task_id,
      attempt.attempt_number + 1,
      preambleId,
      attempt.goal_id,
    );
  if (!attemptRow) throw new Error("goal protocol repair attempt insert returned no row");
  deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: attemptRow.attempt_id,
    kind: "brief",
    content: composed.brief,
    extension: "md",
  });
  deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: attemptRow.attempt_id,
    kind: "final_prompt",
    content: composed.finalPrompt,
    extension: "md",
  });
  deps.db
    .query(
      `UPDATE task_goals
          SET status = 'active',
              last_attempt_id = ?,
              updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
  deps.db
    .query(
      `UPDATE tasks
          SET state = 'queued',
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND state = 'running'
          AND cancel_requested_at IS NULL`,
    )
    .run(now, task.task_id);
  return attemptRow.attempt_id;
}

function transitionGoalProtocolRepairExhaustedInOpenTxn(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  diagnostics: string,
  artifactId: number,
  now: string,
  repairsUsed: number,
): void {
  supersedeCurrentGoalHandoff(deps, task.task_id);
  const blocker = [
    "Goal worker repeatedly wrote malformed .quay-goal-report.json.",
    "",
    `Protocol repair attempts used: ${repairsUsed}`,
    "",
    diagnostics,
  ].join("\n");
  const blockerArtifact = deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "blocker",
    content: blocker,
    extension: "md",
  });
  deps.db
    .query(
      `UPDATE task_goals
          SET status = 'blocked',
              last_attempt_id = ?,
              current_handoff_id = NULL,
              updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
  deps.db
    .query(
      `UPDATE tasks
          SET state = 'awaiting-next-brief',
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND state = 'running'
          AND cancel_requested_at IS NULL`,
    )
    .run(now, task.task_id);
  const eventRow = deps.db
    .query<{ event_id: number }, [string, number, number, string, string]>(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at, event_data
       ) VALUES (?, ?, 'malformed_goal_report_repair_exhausted', 'running', 'awaiting-next-brief', ?, ?, ?)
       RETURNING event_id`,
    )
    .get(
      task.task_id,
      attempt.attempt_id,
      blockerArtifact.artifactId,
      now,
      JSON.stringify({
        malformed_goal_report_artifact_id: artifactId,
        repairs_used: repairsUsed,
        max_repairs: MAX_GOAL_PROTOCOL_REPAIR_ATTEMPTS,
      }),
    );
  if (!eventRow) {
    throw new Error("malformed_goal_report_repair_exhausted event insert returned no row");
  }
  const handoffId = enqueueOrchestratorHandoff(deps, {
    taskId: task.task_id,
    reason: "worker_blocker",
    stateEventId: eventRow.event_id,
    payload: {
      goal_id: attempt.goal_id,
      attempt_id: attempt.attempt_id,
      artifact_id: blockerArtifact.artifactId,
      malformed_goal_report_artifact_id: artifactId,
      repairs_used: repairsUsed,
      max_repairs: MAX_GOAL_PROTOCOL_REPAIR_ATTEMPTS,
    },
  });
  deps.db
    .query(
      `UPDATE task_goals SET current_handoff_id = ?, updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(handoffId, now, task.task_id, attempt.goal_id);
}

function ingestActiveGoalReport(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  report: GoalReport,
  reportArtifactId: number,
  remoteShaAtExit: string | null,
  delivery: GoalPrDelivery,
  exitInfo: PaneExitInfo,
  warnings: string[],
  evidence: CapturedGoalEvidence,
): ClassifyResult {
  const now = deps.clock.nowISO();
  const prCreatedDuringAttempt =
    delivery.prExistsAtExit && attempt.pr_existed_at_spawn !== 1;
  const remoteProgress =
    remoteShaAtExit !== null && remoteShaAtExit !== attempt.remote_sha_at_spawn;
  const observableProgress = remoteProgress || prCreatedDuringAttempt;

  deps.db.exec("BEGIN");
  try {
    accountGoalAttempt(deps, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      spawnedAt: attempt.spawned_at,
      endedAt: now,
    });
    const freshGoal = loadTaskGoal(deps.db, task.task_id);
    if (freshGoal !== null && goalBudgetIsExhausted(freshGoal)) {
      const outcome = transitionGoalBudgetLimitedInOpenTxn(
        deps,
        task,
        attempt,
        report,
        reportArtifactId,
        remoteShaAtExit,
        delivery,
        exitInfo,
        now,
      );
      deps.db.exec("COMMIT");
      try {
        rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
      } catch {}
      return outcome;
    }

    const nextNoProgress = observableProgress
      ? 0
      : (freshGoal?.no_progress_active_count ?? 0) + 1;
    if (nextNoProgress >= NO_PROGRESS_ACTIVE_LIMIT) {
      const outcome = transitionGoalNoProgressBlockedInOpenTxn(
        deps,
        task,
        attempt,
        report,
        reportArtifactId,
        remoteShaAtExit,
        delivery,
        exitInfo,
        now,
        nextNoProgress,
      );
      deps.db.exec("COMMIT");
      try {
        rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
      } catch {}
      return outcome;
    }

    const preambleId = ensurePreambleIdForAttemptReason(
      deps.db,
      deps.clock,
      GOAL_CONTINUE_ATTEMPT_REASON,
    );
    const objective = loadOriginalTaskObjective(deps.db, task.task_id);
    const goalContext = loadGoalPromptContext(deps.db, task.task_id);
    const prBaseBranch = loadTaskPrBaseBranch(deps.db, task.task_id);
    const preambleBody = loadPreambleBody(deps.db, preambleId);
    const guidance = composeGoalContinuationGuidance(report, warnings);
    const composed = composeWorkerPrompt({
      preambleBody,
      taskObjective: objective,
      prBaseBranch,
      goalContext,
      referenceReposRoot: deps.referenceReposRoot,
      attemptGuidance: {
        reason: GOAL_CONTINUE_ATTEMPT_REASON,
        body: guidance,
      },
      diagnostics: {
        kind: "goal_report",
        body: `Latest goal report artifact #${reportArtifactId}:\n${JSON.stringify(report, null, 2)}`,
      },
    });
    const attemptRow = deps.db
      .query<
        { attempt_id: number },
        [string, number, number, string, string | null]
      >(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, reason, consumed_budget, goal_id
         ) VALUES (?, ?, ?, ?, 0, ?)
         RETURNING attempt_id`,
      )
      .get(
        task.task_id,
        attempt.attempt_number + 1,
        preambleId,
        GOAL_CONTINUE_ATTEMPT_REASON,
        attempt.goal_id,
      );
    if (!attemptRow) throw new Error("goal continuation attempt insert returned no row");
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: attemptRow.attempt_id,
      kind: "brief",
      content: composed.brief,
      extension: "md",
    });
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: attemptRow.attempt_id,
      kind: "final_prompt",
      content: composed.finalPrompt,
      extension: "md",
    });
    deps.db
      .query(
        `UPDATE task_goals
            SET status = 'active',
                last_attempt_id = ?,
                no_progress_active_count = ?,
                updated_at = ?
          WHERE task_id = ? AND goal_id = ? AND status = 'active'`,
      )
      .run(
        attempt.attempt_id,
        nextNoProgress,
        now,
        task.task_id,
        attempt.goal_id,
      );
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'goal_active',
                ended_at = ?,
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?,
                goal_report_processed_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        now,
        attempt.attempt_id,
      );
    deps.db
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
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'goal_continuation_scheduled', 'running', 'queued', ?, ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        reportArtifactId,
        now,
        JSON.stringify({
          next_attempt_id: attemptRow.attempt_id,
          remote_progress: remoteProgress,
          pr_created_during_attempt: prCreatedDuringAttempt,
          no_progress_active_count: nextNoProgress,
          evidence_manifest_artifact_id: evidence.manifestArtifactId,
        }),
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  try {
    rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
  } catch {}
  return { outcome: "goal_continuation_scheduled" };
}

function composeGoalContinuationGuidance(
  report: GoalReport,
  warnings: string[],
): string {
  const lines = [
    "Continue the active goal from the latest worker report.",
    "",
    "Previous attempt summary:",
    report.summary,
  ];
  if (report.next_steps.length > 0) {
    lines.push("", "Next steps from previous worker:");
    for (const step of report.next_steps) lines.push(`- ${step}`);
  }
  if (warnings.length > 0) {
    lines.push("", "Goal-report warnings:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  lines.push(
    "",
    `Before exiting, write a valid ${GOAL_REPORT_FILENAME} with status active, blocked, or complete.`,
  );
  return lines.join("\n");
}

function transitionGoalBudgetLimitedInOpenTxn(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  report: GoalReport,
  reportArtifactId: number,
  remoteShaAtExit: string | null,
  delivery: GoalPrDelivery,
  exitInfo: PaneExitInfo,
  now: string,
): ClassifyResult {
  const goal = loadTaskGoal(deps.db, task.task_id);
  supersedeCurrentGoalHandoff(deps, task.task_id);
  deps.db
    .query(
      `UPDATE task_goals
          SET status = 'budget_limited',
              last_attempt_id = ?,
              no_progress_active_count = 0,
              updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
  deps.db
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
  deps.db
    .query(
      `UPDATE attempts
          SET exit_kind = 'goal_budget_limited',
              ended_at = ?,
              remote_sha_at_exit = ?,
              exit_code = ?,
              exit_signal = ?,
              goal_report_processed_at = ?
        WHERE attempt_id = ?`,
    )
    .run(
      now,
      remoteShaAtExit,
      exitInfo.exitCode,
      exitInfo.exitSignal,
      now,
      attempt.attempt_id,
    );
  const eventRow = deps.db
    .query<{ event_id: number }, [string, number, number, string, string]>(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at, event_data
       ) VALUES (?, ?, 'goal_budget_limited', 'running', 'awaiting-next-brief', ?, ?, ?)
       RETURNING event_id`,
    )
    .get(
      task.task_id,
      attempt.attempt_id,
      reportArtifactId,
      now,
      JSON.stringify({
        tokens_used: goal?.tokens_used ?? null,
        token_budget: goal?.token_budget ?? null,
        report_summary: report.summary,
      }),
    );
  if (!eventRow) throw new Error("goal_budget_limited event insert returned no row");
  const handoffId = enqueueOrchestratorHandoff(deps, {
    taskId: task.task_id,
    reason: "budget_exhausted",
    stateEventId: eventRow.event_id,
    payload: {
      goal_id: attempt.goal_id,
      attempt_id: attempt.attempt_id,
      latest_report_artifact_id: reportArtifactId,
      tokens_used: goal?.tokens_used ?? null,
      token_budget: goal?.token_budget ?? null,
      latest_branch_head: remoteShaAtExit,
      pr_number: delivery.prNumber,
      report,
    },
  });
  deps.db
    .query(
      `UPDATE task_goals SET current_handoff_id = ?, updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(handoffId, now, task.task_id, attempt.goal_id);
  return { outcome: "goal_budget_limited" };
}

function transitionGoalNoProgressBlockedInOpenTxn(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  report: GoalReport,
  reportArtifactId: number,
  remoteShaAtExit: string | null,
  delivery: GoalPrDelivery,
  exitInfo: PaneExitInfo,
  now: string,
  noProgressCount: number,
): ClassifyResult {
  supersedeCurrentGoalHandoff(deps, task.task_id);
  const blocker = [
    "Goal worker reported active without observable remote progress too many times.",
    "",
    `Consecutive no-progress active reports: ${noProgressCount}`,
    "",
    "Latest report summary:",
    report.summary,
  ].join("\n");
  const blockerArtifact = deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "blocker",
    content: blocker,
    extension: "md",
  });
  deps.db
    .query(
      `UPDATE task_goals
          SET status = 'blocked',
              last_attempt_id = ?,
              no_progress_active_count = ?,
              updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(
      attempt.attempt_id,
      noProgressCount,
      now,
      task.task_id,
      attempt.goal_id,
    );
  deps.db
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
  deps.db
    .query(
      `UPDATE attempts
          SET exit_kind = 'goal_no_progress',
              ended_at = ?,
              remote_sha_at_exit = ?,
              exit_code = ?,
              exit_signal = ?,
              goal_report_processed_at = ?
        WHERE attempt_id = ?`,
    )
    .run(
      now,
      remoteShaAtExit,
      exitInfo.exitCode,
      exitInfo.exitSignal,
      now,
      attempt.attempt_id,
    );
  const eventRow = deps.db
    .query<{ event_id: number }, [string, number, number, string, string]>(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at, event_data
       ) VALUES (?, ?, 'goal_no_progress', 'running', 'awaiting-next-brief', ?, ?, ?)
       RETURNING event_id`,
    )
    .get(
      task.task_id,
      attempt.attempt_id,
      blockerArtifact.artifactId,
      now,
      JSON.stringify({
        goal_report_artifact_id: reportArtifactId,
        latest_branch_head: remoteShaAtExit,
        pr_number: delivery.prNumber,
        no_progress_active_count: noProgressCount,
      }),
    );
  if (!eventRow) throw new Error("goal_no_progress event insert returned no row");
  const handoffId = enqueueOrchestratorHandoff(deps, {
    taskId: task.task_id,
    reason: "no_progress",
    stateEventId: eventRow.event_id,
    payload: {
      goal_id: attempt.goal_id,
      attempt_id: attempt.attempt_id,
      blocker_artifact_id: blockerArtifact.artifactId,
      goal_report_artifact_id: reportArtifactId,
      latest_branch_head: remoteShaAtExit,
      pr_number: delivery.prNumber,
      no_progress_active_count: noProgressCount,
    },
  });
  deps.db
    .query(
      `UPDATE task_goals SET current_handoff_id = ?, updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(handoffId, now, task.task_id, attempt.goal_id);
  return { outcome: "blocker_written" };
}

function ingestBlockedGoalReport(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  report: GoalReport,
  reportArtifactId: number,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
  evidence: CapturedGoalEvidence,
): ClassifyResult {
  const blocker = report.blocker ?? "";
  const blockerArtifact = deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    kind: "blocker",
    content: blocker,
    extension: "md",
  });
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    accountGoalAttempt(deps, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      spawnedAt: attempt.spawned_at,
      endedAt: now,
    });
    supersedeCurrentGoalHandoff(deps, task.task_id);
    deps.db
      .query(
        `UPDATE task_goals
            SET status = 'blocked',
                last_attempt_id = ?,
                no_progress_active_count = 0,
                updated_at = ?
          WHERE task_id = ? AND goal_id = ? AND status = 'active'`,
      )
      .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
    deps.db
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
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'blocker_written',
                ended_at = ?,
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?,
                goal_report_processed_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        now,
        attempt.attempt_id,
      );
    const eventRow = deps.db
      .query<{ event_id: number }, [string, number, number, string, string]>(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'blocker_ingested', 'running', 'awaiting-next-brief', ?, ?, ?)
         RETURNING event_id`,
      )
      .get(
        task.task_id,
        attempt.attempt_id,
        blockerArtifact.artifactId,
        now,
        JSON.stringify({
          goal_report_artifact_id: reportArtifactId,
          evidence_manifest_artifact_id: evidence.manifestArtifactId,
        }),
      );
    if (!eventRow) throw new Error("blocker_ingested event insert returned no row");
    const handoffId = enqueueOrchestratorHandoff(deps, {
      taskId: task.task_id,
      reason: "worker_blocker",
      stateEventId: eventRow.event_id,
      payload: {
        goal_id: attempt.goal_id,
        attempt_id: attempt.attempt_id,
        artifact_id: blockerArtifact.artifactId,
        goal_report_artifact_id: reportArtifactId,
        evidence_manifest_artifact_id: evidence.manifestArtifactId,
      },
    });
    deps.db
      .query(
        `UPDATE task_goals SET current_handoff_id = ?, updated_at = ?
          WHERE task_id = ? AND goal_id = ?`,
      )
      .run(handoffId, now, task.task_id, attempt.goal_id);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  try {
    rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
    rmSync(join(task.worktree_path, BLOCKER_FILENAME), { force: true });
  } catch {}
  return { outcome: "blocker_written" };
}

function ingestCompleteGoalReport(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  report: GoalReport,
  reportArtifactId: number,
  remoteShaAtExit: string | null,
  delivery: GoalPrDelivery,
  exitInfo: PaneExitInfo,
  evidence: CapturedGoalEvidence,
): ClassifyResult {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    accountGoalAttempt(deps, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      spawnedAt: attempt.spawned_at,
      endedAt: now,
    });
    deps.db
      .query(
        `UPDATE task_goals
            SET status = 'completion_pending',
                last_attempt_id = ?,
                no_progress_active_count = 0,
                current_handoff_id = NULL,
                completed_at = NULL,
                updated_at = ?
          WHERE task_id = ? AND goal_id = ? AND status = 'active'`,
      )
      .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
    const taskUpd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'goal-completion-pending',
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
      return { outcome: "goal_completion_pending" };
    }
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'goal_completion_pending',
                ended_at = ?,
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?,
                goal_report_processed_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        now,
        attempt.attempt_id,
      );
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'goal_completion_pending', 'running', 'goal-completion-pending', ?, ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        reportArtifactId,
        now,
        JSON.stringify({
          goal_id: attempt.goal_id,
          goal_report_status: report.status,
          evidence_manifest_artifact_id: evidence.manifestArtifactId,
          pr_number: delivery.prNumber,
          pr_exists_at_exit: delivery.prExistsAtExit,
          reviewable_pr_exists: delivery.reviewablePrExists,
          terminal_pr_state: delivery.terminalPrState,
          head_sha: remoteShaAtExit,
        }),
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  captureDiffSummary(deps, task, attempt, remoteShaAtExit);
  try {
    rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
    rmSync(join(task.worktree_path, BLOCKER_FILENAME), { force: true });
  } catch {}
  return { outcome: "goal_completion_pending" };
}

function scheduleCompleteWithoutDeliveryRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  report: GoalReport,
  reportArtifactId: number,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
  delivery: GoalPrDelivery,
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
      return { outcome: "crashed" };
    }
    accountGoalAttempt(deps, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      spawnedAt: attempt.spawned_at,
      endedAt: now,
    });
    const freshGoal = loadTaskGoal(deps.db, task.task_id);
    if (freshGoal !== null && goalBudgetIsExhausted(freshGoal)) {
      const outcome = transitionGoalBudgetLimitedInOpenTxn(
        deps,
        task,
        attempt,
        report,
        reportArtifactId,
        remoteShaAtExit,
        delivery,
        exitInfo,
        now,
      );
      deps.db.exec("COMMIT");
      try {
        rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
      } catch {}
      return outcome;
    }
    deps.db
      .query(
        `UPDATE task_goals
            SET status = 'active',
                last_attempt_id = ?,
                updated_at = ?
          WHERE task_id = ? AND goal_id = ?`,
      )
      .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'crashed',
                ended_at = ?,
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?,
                goal_report_processed_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        now,
        attempt.attempt_id,
      );
    const retry = scheduleDeterministicRetry(deps, {
      taskId: task.task_id,
      prevAttempt: attempt,
      reason: "complete_without_delivery",
      diagnostics:
        "Goal report claimed complete, but Quay did not find a non-draft PR ready for review. Draft PRs and missing PRs do not count as delivery.",
      fromState: "running",
    });
    if (!retry.scheduled) {
      deps.db.exec("COMMIT");
      try {
        rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
      } catch {}
      return { outcome: "crashed" };
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'complete_without_delivery', 'running', (SELECT state FROM tasks WHERE task_id = ?), ?, ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        task.task_id,
        reportArtifactId,
        now,
        JSON.stringify({
          pr_exists_at_exit: delivery.prExistsAtExit,
          reviewable_pr_exists: delivery.reviewablePrExists,
          terminal_pr_state: delivery.terminalPrState,
        }),
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  try {
    rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
  } catch {}
  return { outcome: "crashed" };
}

function ingestBlocker(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  blockerPath: string,
  content: string,
  exitInfo: PaneExitInfo,
  options: { malformedGoalReportArtifactId?: number } = {},
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
        const isGoalBlocker =
          task.worker_execution === "goal" && attempt.goal_id !== null;
        if (isGoalBlocker) {
          accountGoalAttempt(deps, {
            taskId: task.task_id,
            attemptId: attempt.attempt_id,
            spawnedAt: attempt.spawned_at,
            endedAt: now,
          });
          supersedeCurrentGoalHandoff(deps, task.task_id);
          deps.db
            .query(
              `UPDATE task_goals
                  SET status = 'blocked',
                      last_attempt_id = ?,
                      no_progress_active_count = 0,
                      updated_at = ?
                WHERE task_id = ? AND goal_id = ?`,
            )
            .run(attempt.attempt_id, now, task.task_id, attempt.goal_id);
        }
        deps.db
          .query(
            `UPDATE attempts
                SET exit_kind = 'blocker_written',
                    ended_at = ?,
                    exit_code = ?,
                    exit_signal = ?,
                    goal_report_processed_at = COALESCE(goal_report_processed_at, ?)
              WHERE attempt_id = ? AND ended_at IS NULL`,
          )
          .run(
            now,
            exitInfo.exitCode,
            exitInfo.exitSignal,
            options.malformedGoalReportArtifactId !== undefined ? now : null,
            attempt.attempt_id,
          );
        const budgetFailureArtifactId = writeBlockerBudgetExhausted(deps, {
          taskId: task.task_id,
          attempt,
          blockerContent: content,
        });
        const blockerBytes = new TextEncoder().encode(content).byteLength;
        const eventData = JSON.stringify({
          exit_code: exitInfo.exitCode,
          exit_signal: exitInfo.exitSignal,
          blocker_bytes: blockerBytes,
          blocker_content_hash: contentHash,
          ...(isGoalBlocker ? { goal_id: attempt.goal_id } : {}),
          ...(options.malformedGoalReportArtifactId !== undefined
            ? { malformed_goal_report_artifact_id: options.malformedGoalReportArtifactId }
            : {}),
        });
        const eventRow = deps.db
          .query<
            { event_id: number },
            [string, number, number, string, string]
          >(
            `INSERT INTO events (
               task_id, attempt_id, event_type,
               from_state, to_state, payload_artifact_id, occurred_at, event_data
             ) VALUES (?, ?, 'blocker_ingested', 'running', 'awaiting-next-brief', ?, ?, ?)
             RETURNING event_id`,
          )
          .get(task.task_id, attempt.attempt_id, artifactId, now, eventData);
        if (!eventRow) throw new Error("blocker_ingested event insert returned no row");
        const handoffId = enqueueOrchestratorHandoff(deps, {
          taskId: task.task_id,
          reason: "worker_blocker",
          stateEventId: eventRow.event_id,
          payload: {
            ...(isGoalBlocker ? { goal_id: attempt.goal_id } : {}),
            attempt_id: attempt.attempt_id,
            artifact_id: artifactId,
            blocker_content_hash: contentHash,
            blocker_bytes: blockerBytes,
            budget_exhausted_artifact_id: budgetFailureArtifactId,
            ...(options.malformedGoalReportArtifactId !== undefined
              ? { malformed_goal_report_artifact_id: options.malformedGoalReportArtifactId }
              : {}),
          },
        });
        if (isGoalBlocker) {
          deps.db
            .query(
              `UPDATE task_goals SET current_handoff_id = ?, updated_at = ?
                WHERE task_id = ? AND goal_id = ?`,
            )
            .run(handoffId, now, task.task_id, attempt.goal_id);
        }
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
    if (options.malformedGoalReportArtifactId !== undefined) {
      rmSync(join(task.worktree_path, GOAL_REPORT_FILENAME), { force: true });
    }
  } catch {}
  return { outcome: "blocker_written" };
}

function ingestMalformed(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  blockerPath: string,
  bytes: Uint8Array,
  exitInfo: PaneExitInfo,
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
                    ended_at = ?,
                    exit_code = ?,
                    exit_signal = ?
              WHERE attempt_id = ? AND ended_at IS NULL`,
          )
          .run(
            now,
            exitInfo.exitCode,
            exitInfo.exitSignal,
            attempt.attempt_id,
          );
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

function reconcileExistingOpenPr(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
  predicate: PredicateState,
): ClassifyResult | null {
  const baseBranch = task.base_branch?.trim();
  if (baseBranch === undefined || baseBranch.length === 0) return null;

  let matches: OpenBranchPr[];
  try {
    matches = deps.github.openPrsForBranchBase(
      task.repo_id,
      task.branch_name,
      baseBranch,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `existing PR reconciliation lookup failed for ${task.repo_id} ${task.branch_name} -> ${baseBranch}: ${message}`,
    );
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const prList = matches.map((pr) => `#${pr.number}`).join(", ");
    throw new Error(
      `existing PR reconciliation found multiple open PRs for ${task.repo_id} ${task.branch_name} -> ${baseBranch}: ${prList}`,
    );
  }

  return transitionExistingPrAttached(
    deps,
    task,
    attempt,
    remoteShaAtExit,
    exitInfo,
    predicate,
    baseBranch,
    matches[0]!,
  );
}

function transitionExistingPrAttached(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
  predicate: PredicateState,
  baseBranch: string,
  pr: OpenBranchPr,
): ClassifyResult {
  const now = deps.clock.nowISO();
  const headSha = pr.headSha === "" ? null : pr.headSha;
  deps.db.exec("BEGIN");
  try {
    const taskUpd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'pr-open',
                pr_number = ?,
                pr_url = COALESCE(?, pr_url),
                head_sha = COALESCE(?, head_sha),
                base_sha = COALESCE(?, base_sha),
                spawn_failures_consecutive = 0,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'running'
            AND pr_number IS NULL
            AND cancel_requested_at IS NULL`,
      )
      .run(
        pr.number,
        pr.url,
        headSha,
        pr.baseSha,
        now,
        task.task_id,
      );
    const changes = (taskUpd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { outcome: "existing_pr_attached" };
    }
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'pr_opened',
                ended_at = ?,
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?
          WHERE attempt_id = ?`,
      )
      .run(
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        attempt.attempt_id,
      );
    const eventData = JSON.stringify({
      reason: "existing_open_pr_for_task_branch_base",
      pr_number: pr.number,
      pr_url: pr.url,
      head_sha: headSha,
      base_sha: pr.baseSha,
      branch_name: task.branch_name,
      base_branch: baseBranch,
      pr_base_ref: pr.baseRef,
      remote_sha_at_spawn: attempt.remote_sha_at_spawn,
      remote_sha_at_exit: remoteShaAtExit,
      remote_unchanged: predicate.remoteUnchanged,
      pr_existed_at_spawn: predicate.prExistedAtSpawn,
      pr_exists_at_exit: predicate.prExistsAtExit,
      exit_code: exitInfo.exitCode,
      exit_signal: exitInfo.exitSignal,
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type,
           from_state, to_state, occurred_at, event_data
         ) VALUES (?, ?, 'existing_pr_attached', 'running', 'pr-open', ?, ?)`,
      )
      .run(task.task_id, attempt.attempt_id, now, eventData);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  captureDiffSummary(deps, task, attempt, remoteShaAtExit);
  return { outcome: "existing_pr_attached" };
}

function transitionPrOpened(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
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
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?
          WHERE attempt_id = ?`,
      )
      .run(
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        attempt.attempt_id,
      );
    // event_data records what the (event_type, from_state, to_state) triple
    // can't express: what SHA actually landed, the OS-level exit info, and
    // whether the PR existed before this attempt (distinguishes a brand-new
    // PR from a respawn that didn't push but kept the existing PR).
    const eventData = JSON.stringify({
      exit_code: exitInfo.exitCode,
      exit_signal: exitInfo.exitSignal,
      head_sha: remoteShaAtExit,
      remote_sha_at_spawn: attempt.remote_sha_at_spawn,
      pr_existed_at_spawn: attempt.pr_existed_at_spawn === 1,
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type,
           from_state, to_state, occurred_at, event_data
         ) VALUES (?, ?, 'pr_opened', 'running', 'pr-open', ?, ?)`,
      )
      .run(task.task_id, attempt.attempt_id, now, eventData);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  captureDiffSummary(deps, task, attempt, remoteShaAtExit);
  return { outcome: "pr_opened" };
}

// Best-effort lines-changed capture between an attempt's spawn-time base
// and its exit-time head. Runs after the transition has committed so a slow
// or failing git invocation never blocks the state machine. Failure leaves
// `attempts.diff_summary` NULL and emits a `tick_error` event so retro
// analysis can tell "no diff captured (capture failed)" apart from "no
// diff produced (column populated with zero-files JSON)".
//
// Base SHA selection (in order):
//   1. attempt.remote_sha_at_spawn — the natural choice for respawns where
//      `quay/<branch>` already existed on origin and the worker pushed on
//      top.
//   2. The task's effective base_branch tip when the spawn-time SHA is null (first
//      push: the branch was created and pushed for the very first time
//      this attempt). Without this fallback, every successful first-attempt
//      PR loses its diff_summary — exactly the AST-103 regression.
//
// `git.diffSummary` uses three-dot range semantics, so passing the base
// branch tip as `baseSha` produces a clean PR-shaped diff even when the
// base has advanced past the worker's branch point.
function captureDiffSummary(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
): void {
  if (remoteShaAtExit === null) return;
  let baseSha = attempt.remote_sha_at_spawn;
  if (baseSha === null) {
    baseSha = loadBaseBranchSha(deps, task);
  }
  if (baseSha === null || baseSha === remoteShaAtExit) {
    return;
  }
  let summary;
  try {
    summary = deps.git.diffSummary(task.repo_id, baseSha, remoteShaAtExit);
  } catch {
    summary = null;
  }
  if (summary !== null) {
    try {
      deps.db
        .query(`UPDATE attempts SET diff_summary = ? WHERE attempt_id = ?`)
        .run(JSON.stringify(summary), attempt.attempt_id);
    } catch {}
    return;
  }
  try {
    const eventData = JSON.stringify({
      capture: "diff_summary",
      base_sha: baseSha,
      head_sha: remoteShaAtExit,
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, occurred_at, event_data
         ) VALUES (?, ?, 'tick_error', ?, ?)`,
      )
      .run(task.task_id, attempt.attempt_id, deps.clock.nowISO(), eventData);
  } catch {}
}

// Best-effort lookup for the base-branch tip SHA used as the diff_summary
// fallback on first push. We refresh the local cache via the tolerant
// fetch first so the merge-base inside `git.diffSummary` reflects current
// origin state. Any failure (no row, missing remote) returns null and the
// caller leaves diff_summary NULL.
function loadBaseBranchSha(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
): string | null {
  const baseBranch = task.base_branch;
  if (baseBranch === null || baseBranch.trim() === "") return null;
  try {
    deps.git.fetchBranchIfExists(task.repo_id, baseBranch);
  } catch {
    // Best-effort: a transient fetch failure falls through to whatever
    // SHA is already cached locally.
  }
  try {
    return deps.git.remoteHeadSha(task.repo_id, baseBranch);
  } catch {
    return null;
  }
}

function scheduleCrashRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
  predicate: PredicateState,
  diagnostics?: string,
): ClassifyResult {
  return scheduleRetry(
    deps,
    task,
    attempt,
    remoteShaAtExit,
    exitInfo,
    predicate,
    "crashed",
    "crash",
    diagnostics,
  );
}

function scheduleNoProgressRetry(
  deps: ClassifierDeps,
  task: ClassifyContextTask,
  attempt: ClassifyContextAttempt,
  remoteShaAtExit: string | null,
  exitInfo: PaneExitInfo,
  predicate: PredicateState,
): ClassifyResult {
  return scheduleRetry(
    deps,
    task,
    attempt,
    remoteShaAtExit,
    exitInfo,
    predicate,
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
  exitInfo: PaneExitInfo,
  predicate: PredicateState,
  exitKind: DeadExitKind,
  retryReason: "crash" | "malformed_signal",
  diagnosticsOverride?: string,
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
                remote_sha_at_exit = ?,
                exit_code = ?,
                exit_signal = ?
          WHERE attempt_id = ?`,
      )
      .run(
        exitKind,
        now,
        remoteShaAtExit,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        attempt.attempt_id,
      );
    const diagnostics =
      diagnosticsOverride ??
      (exitKind === "no_progress"
        ? "The worker exited with an existing PR but made no trackable remote progress during this attempt."
        : "The worker exited without producing a PR or valid blocker signal.");
    const goalLimit = accountGoalFailureAndMaybeLimit(deps, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      goalId: attempt.goal_id,
      spawnedAt: attempt.spawned_at,
      endedAt: now,
      fromState: "running",
      diagnostics,
      remoteShaAtExit,
    });
    if (goalLimit.budgetLimited) {
      deps.db.exec("COMMIT");
      return { outcome: "goal_budget_limited" };
    }
    scheduleDeterministicRetry(deps, {
      taskId: task.task_id,
      prevAttempt: attempt,
      reason: retryReason,
      diagnostics,
      fromState: "running",
    });
    const eventType = exitKind === "no_progress" ? "no_progress" : "crashed";
    const eventData = JSON.stringify({
      exit_code: exitInfo.exitCode,
      exit_signal: exitInfo.exitSignal,
      remote_unchanged: predicate.remoteUnchanged,
      pr_existed_at_spawn: predicate.prExistedAtSpawn,
      pr_exists_at_exit: predicate.prExistsAtExit,
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type,
           from_state, to_state, occurred_at, event_data
         ) VALUES (?, ?, ?, 'running', (SELECT state FROM tasks WHERE task_id = ?), ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        eventType,
        task.task_id,
        now,
        eventData,
      );
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

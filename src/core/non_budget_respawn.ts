// Non-budget respawn helper (spec §5 "schedule non-budget respawn",
// §7 "Non-budget respawn dedup", §14 "Non-budget respawns are deduplicated").
//
// Used by the `pr-open` and `done` handlers in tick to schedule `review` or
// `conflict` respawns without consuming the retry budget. The spec demands
// **increment-then-compare-then-decide** in a single SQL transaction:
//
//   1. Increment `tasks.non_budget_respawns_consumed` by 1.
//   2. If post-increment > `max_non_budget_respawns`: do NOT schedule, park
//      the task in `non_budget_loop` and write `non_budget_loop_parked`
//      event. The increment is still committed (forensics + race safety).
//   3. Else: insert a pending attempt row with `consumed_budget = 0`, write
//      `brief` + `final_prompt` artifacts, record the dedupe key
//      (`last_review_id_acted_on` / `last_conflict_observation`), and
//      transition the task to `queued`.
//
// Snapshot artifact (`review_comments` / `conflict_slice`) is written before
// the SQL transaction and referenced by `payload_artifact_id` regardless of
// the schedule-vs-park branch.

import { readFileSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { loadPreambleBody } from "./preamble.ts";

export type NonBudgetReason = "review" | "conflict";

export interface NonBudgetRetryDeps {
  db: DB;
  clock: Clock;
  artifactStore: ArtifactStore;
}

export interface NonBudgetAttemptRef {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
}

export interface NonBudgetInput {
  taskId: string;
  prevAttempt: NonBudgetAttemptRef;
  reason: NonBudgetReason;
  diagnostics: string;
  fromState: string;
  // Artifact captured at trigger time and referenced by the scheduling /
  // parking event. `kind` is `review_comments` for review respawns and
  // `conflict_slice` for conflict respawns.
  snapshotKind: "review_comments" | "conflict_slice";
  snapshotContent: string;
  snapshotExtension: "json" | "txt";
  // Dedupe key column + value to record on the task in the same transaction.
  dedupeColumn: "last_review_id_acted_on" | "last_conflict_observation";
  dedupeValue: string;
  maxNonBudgetRespawns: number;
}

export type NonBudgetOutcome = "scheduled" | "parked" | "skipped";

export interface NonBudgetResult {
  outcome: NonBudgetOutcome;
  artifactId?: number;
  nextAttemptId?: number;
  postCount?: number;
}

const DEFAULT_NON_BUDGET_TEMPLATES: Record<NonBudgetReason, string> = {
  review:
    "The pull request has new review feedback marked CHANGES_REQUESTED. Read the snapshotted comments, address each one, push the branch, and update the existing PR.",
  conflict:
    "The pull request can no longer be merged cleanly: GitHub reports a merge conflict against the base branch. Pull the base, resolve the conflict, push the branch, and update the existing PR.",
};

export function scheduleNonBudgetRespawn(
  deps: NonBudgetRetryDeps,
  input: NonBudgetInput,
): NonBudgetResult {
  // Snapshot artifact first so the trigger context is preserved even if the
  // task is parked. The artifact is bound to the *previous* attempt because
  // it was the one that produced the GitHub-side state we're observing.
  const snapshot = deps.artifactStore.writeArtifact({
    taskId: input.taskId,
    attemptId: input.prevAttempt.attempt_id,
    kind: input.snapshotKind,
    content: input.snapshotContent,
    extension: input.snapshotExtension,
  });

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const incremented = deps.db
      .query<{ post_count: number }, [string, string]>(
        `UPDATE tasks
            SET non_budget_respawns_consumed = non_budget_respawns_consumed + 1,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ? AND cancel_requested_at IS NULL
          RETURNING non_budget_respawns_consumed AS post_count`,
      )
      .get(now, input.taskId);
    if (!incremented) {
      // cancel slipped in between read and write, or row missing.
      deps.db.exec("ROLLBACK");
      return { outcome: "skipped", artifactId: snapshot.artifactId };
    }
    const postCount = incremented.post_count;

    if (postCount > input.maxNonBudgetRespawns) {
      // Cap exceeded: park the task. The increment is still committed (per
      // spec §5: "the counter records the rejected attempt for forensics and
      // prevents a tie/race from re-trying"). No `last_failure` artifact:
      // the trigger is external GitHub state, not a failure to retry.
      deps.db
        .query(
          `UPDATE tasks
              SET state = 'non_budget_loop',
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND cancel_requested_at IS NULL`,
        )
        .run(now, input.taskId);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state,
             payload_artifact_id, occurred_at
           ) VALUES (?, ?, 'non_budget_loop_parked', ?, 'non_budget_loop', ?, ?)`,
        )
        .run(
          input.taskId,
          input.prevAttempt.attempt_id,
          input.fromState,
          snapshot.artifactId,
          now,
        );
      deps.db.exec("COMMIT");
      return {
        outcome: "parked",
        artifactId: snapshot.artifactId,
        postCount,
      };
    }

    // Schedule a new attempt with consumed_budget = 0.
    const template = ensureNonBudgetTemplate(deps.db, deps.clock, input.reason);
    const priorBrief = loadMostRecentBrief(deps.db, input.taskId);
    const retryBrief = composeNonBudgetBrief({
      reason: input.reason,
      templateBody: template.body,
      diagnostics: input.diagnostics,
      priorBrief,
    });

    const attempt = deps.db
      .query<
        { attempt_id: number },
        [string, number, number, number, string]
      >(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, template_id, reason, consumed_budget
         ) VALUES (?, ?, ?, ?, ?, 0)
         RETURNING attempt_id`,
      )
      .get(
        input.taskId,
        input.prevAttempt.attempt_number + 1,
        input.prevAttempt.preamble_id,
        template.template_id,
        input.reason,
      );
    if (!attempt) throw new Error("non-budget respawn attempt insert returned no row");

    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: attempt.attempt_id,
      kind: "brief",
      content: retryBrief,
      extension: "md",
    });
    const preamble = loadPreambleBody(deps.db, input.prevAttempt.preamble_id);
    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: attempt.attempt_id,
      kind: "final_prompt",
      content: `${preamble}\n\n${retryBrief}`,
      extension: "md",
    });

    if (input.dedupeColumn === "last_review_id_acted_on") {
      deps.db
        .query(
          `UPDATE tasks
              SET state = 'queued',
                  last_review_id_acted_on = ?,
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND cancel_requested_at IS NULL`,
        )
        .run(input.dedupeValue, now, input.taskId);
    } else {
      deps.db
        .query(
          `UPDATE tasks
              SET state = 'queued',
                  last_conflict_observation = ?,
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND cancel_requested_at IS NULL`,
        )
        .run(input.dedupeValue, now, input.taskId);
    }

    const eventType =
      input.reason === "review" ? "changes_requested" : "conflict";
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.taskId,
        attempt.attempt_id,
        eventType,
        input.fromState,
        snapshot.artifactId,
        now,
      );

    deps.db.exec("COMMIT");
    return {
      outcome: "scheduled",
      artifactId: snapshot.artifactId,
      nextAttemptId: attempt.attempt_id,
      postCount,
    };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function ensureNonBudgetTemplate(
  db: DB,
  clock: Clock,
  reason: NonBudgetReason,
): { template_id: number; body: string } {
  const existing = db
    .query<{ template_id: number; body: string }, [string]>(
      `SELECT template_id, body FROM retry_templates
        WHERE kind = ?
        ORDER BY template_id DESC
        LIMIT 1`,
    )
    .get(reason);
  if (existing) return existing;
  const inserted = db
    .query<
      { template_id: number; body: string },
      [string, string, string]
    >(
      `INSERT INTO retry_templates (kind, body, created_at)
       VALUES (?, ?, ?)
       RETURNING template_id, body`,
    )
    .get(reason, DEFAULT_NON_BUDGET_TEMPLATES[reason], clock.nowISO());
  if (!inserted) throw new Error("retry template insert returned no row");
  return inserted;
}

function loadMostRecentBrief(db: DB, taskId: string): string {
  const row = db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'brief'
        ORDER BY artifact_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  if (!row) return "(No prior brief artifact was recorded.)";
  try {
    return readFileSync(row.file_path, "utf8");
  } catch {
    return "(Prior brief artifact file was missing or unreadable.)";
  }
}

function composeNonBudgetBrief(input: {
  reason: NonBudgetReason;
  templateBody: string;
  diagnostics: string;
  priorBrief: string;
}): string {
  return [
    `# Quay non-budget respawn: ${input.reason}`,
    "",
    input.templateBody,
    "",
    "## Observed context",
    "",
    input.diagnostics,
    "",
    "## Most recent brief",
    "",
    input.priorBrief,
  ].join("\n");
}

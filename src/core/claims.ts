// Claim fencing + claim-scoped writes (spec §5 ownership fence, §10 CLI surface,
// §11 Hermes seam).
//
// Service-level entry points for orchestrator interaction:
//   - claim_task        — atomic awaiting-next-brief → claimed-by-orchestrator,
//                         minting a fresh claim_id (UUID v4).
//   - release_claim     — ownership-fenced release back to awaiting-next-brief.
//   - submit_brief      — claim-scoped brief submission; schedules a pending
//                         attempt + transitions to queued. Never spawns.
//   - escalate_human    — claim-scoped slack_escalation_post artifact + state
//                         transition to waiting_human. Never calls Slack.
//
// Errors flow back as a discriminated union so callers can distinguish
// `claim_lost`, `cancelled`, `wrong_state`, `unknown_task`, and
// `budget_exhausted` without inspecting exception messages.

import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id_generator.ts";
import { taskIdShort } from "./branch_slug.ts";
import { loadPreambleBody } from "./preamble.ts";

export type ClaimErrorCode =
  | "unknown_task"
  | "wrong_state"
  | "claim_lost"
  | "cancelled"
  | "budget_exhausted"
  | "validation_error";

export interface ClaimError {
  code: ClaimErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ClaimError };

export interface ClaimTaskResult {
  task_id: string;
  claim_id: string;
  state: "claimed-by-orchestrator";
}

export interface ReleaseClaimResult {
  task_id: string;
  state: "awaiting-next-brief";
  released: boolean;
}

export type SubmitBriefReason = "blocker_resolved" | "advice_answered";

export interface SubmitBriefResult {
  task_id: string;
  state: "queued";
  attempt_id: number;
}

export interface EscalateHumanResult {
  task_id: string;
  state: "waiting_human";
  artifact_id: number;
  escalation_seq: number;
  escalation_nonce: string;
  thread_ref: string;
}

export interface ClaimDeps {
  db: DB;
  clock: Clock;
}

export interface SubmitBriefDeps extends ClaimDeps {
  artifactStore: ArtifactStore;
}

export interface EscalateHumanDeps extends ClaimDeps {
  artifactStore: ArtifactStore;
  ids: IdGenerator;
}

export interface ClaimTaskInput {
  taskId: string;
}

export interface ReleaseClaimInput {
  taskId: string;
  claimId: string;
}

export interface SubmitBriefInput {
  taskId: string;
  claimId: string;
  brief: string;
  reason: SubmitBriefReason;
}

export interface EscalateHumanInput {
  taskId: string;
  claimId: string;
  questionBody: string;
  threadRef?: string | null;
}

interface TaskRow {
  task_id: string;
  state: string;
  claim_id: string | null;
  cancel_requested_at: string | null;
  budget_exhausted: number;
  slack_thread_ref: string | null;
  next_escalation_seq: number;
}

function fail(
  code: ClaimErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ServiceResult<never> {
  const error: ClaimError = details === undefined
    ? { code, message }
    : { code, message, details };
  return { ok: false, error };
}

function loadTask(db: DB, taskId: string): TaskRow | null {
  return (
    db
      .query<TaskRow, [string]>(
        `SELECT task_id, state, claim_id, cancel_requested_at,
                budget_exhausted, slack_thread_ref, next_escalation_seq
           FROM tasks WHERE task_id = ?`,
      )
      .get(taskId) ?? null
  );
}

export function claim_task(
  deps: ClaimDeps,
  input: ClaimTaskInput,
): ServiceResult<ClaimTaskResult> {
  const taskId = input.taskId;
  const claimId = randomUUID();
  const now = deps.clock.nowISO();

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'claimed-by-orchestrator',
                claimed_at = ?,
                claim_id = ?,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'awaiting-next-brief'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, claimId, now, taskId);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      const row = loadTask(deps.db, taskId);
      deps.db.exec("ROLLBACK");
      if (!row) return fail("unknown_task", `task ${taskId} not found`, { task_id: taskId });
      if (row.cancel_requested_at !== null) {
        return fail("cancelled", `task ${taskId} has cancel_requested_at set`, {
          task_id: taskId,
        });
      }
      return fail("wrong_state", `task ${taskId} is in state ${row.state}`, {
        task_id: taskId,
        state: row.state,
      });
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, 'claimed', 'awaiting-next-brief', 'claimed-by-orchestrator', ?)`,
      )
      .run(taskId, now);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    ok: true,
    value: { task_id: taskId, claim_id: claimId, state: "claimed-by-orchestrator" },
  };
}

export function release_claim(
  deps: ClaimDeps,
  input: ReleaseClaimInput,
): ServiceResult<ReleaseClaimResult> {
  const row = loadTask(deps.db, input.taskId);
  if (!row) {
    return fail("unknown_task", `task ${input.taskId} not found`, {
      task_id: input.taskId,
    });
  }
  if (row.cancel_requested_at !== null) {
    return fail("cancelled", `task ${input.taskId} has cancel_requested_at set`, {
      task_id: input.taskId,
    });
  }
  if (row.state === "awaiting-next-brief") {
    return {
      ok: true,
      value: { task_id: input.taskId, state: "awaiting-next-brief", released: false },
    };
  }
  if (row.state !== "claimed-by-orchestrator") {
    return fail("wrong_state", `task ${input.taskId} is in state ${row.state}`, {
      task_id: input.taskId,
      state: row.state,
    });
  }
  if (row.claim_id !== input.claimId) {
    return fail(
      "claim_lost",
      `claim_id mismatch on release_claim for task ${input.taskId}`,
      { task_id: input.taskId },
    );
  }

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'awaiting-next-brief',
                claimed_at = NULL,
                claim_id = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'claimed-by-orchestrator'
            AND claim_id = ?
            AND cancel_requested_at IS NULL`,
      )
      .run(now, input.taskId, input.claimId);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      const fresh = loadTask(deps.db, input.taskId);
      deps.db.exec("ROLLBACK");
      if (!fresh) {
        return fail("unknown_task", `task ${input.taskId} not found`, {
          task_id: input.taskId,
        });
      }
      if (fresh.cancel_requested_at !== null) {
        return fail("cancelled", `task ${input.taskId} has cancel_requested_at set`, {
          task_id: input.taskId,
        });
      }
      if (fresh.state === "awaiting-next-brief") {
        return {
          ok: true,
          value: {
            task_id: input.taskId,
            state: "awaiting-next-brief",
            released: false,
          },
        };
      }
      if (fresh.state === "claimed-by-orchestrator" && fresh.claim_id !== input.claimId) {
        return fail(
          "claim_lost",
          `claim_id mismatch on release_claim for task ${input.taskId}`,
          { task_id: input.taskId },
        );
      }
      return fail("wrong_state", `task ${input.taskId} is in state ${fresh.state}`, {
        task_id: input.taskId,
        state: fresh.state,
      });
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, 'claim_released', 'claimed-by-orchestrator', 'awaiting-next-brief', ?)`,
      )
      .run(input.taskId, now);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    ok: true,
    value: { task_id: input.taskId, state: "awaiting-next-brief", released: true },
  };
}

interface PriorAttemptRow {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
}

function loadLatestAttempt(db: DB, taskId: string): PriorAttemptRow | null {
  return (
    db
      .query<PriorAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, preamble_id
           FROM attempts
          WHERE task_id = ?
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

export function submit_brief(
  deps: SubmitBriefDeps,
  input: SubmitBriefInput,
): ServiceResult<SubmitBriefResult> {
  const row = loadTask(deps.db, input.taskId);
  if (!row) {
    return fail("unknown_task", `task ${input.taskId} not found`, {
      task_id: input.taskId,
    });
  }
  if (row.cancel_requested_at !== null) {
    return fail("cancelled", `task ${input.taskId} has cancel_requested_at set`, {
      task_id: input.taskId,
    });
  }
  if (row.state !== "claimed-by-orchestrator") {
    return fail("wrong_state", `task ${input.taskId} is in state ${row.state}`, {
      task_id: input.taskId,
      state: row.state,
    });
  }
  if (row.claim_id !== input.claimId) {
    return fail(
      "claim_lost",
      `claim_id mismatch on submit_brief for task ${input.taskId}`,
      { task_id: input.taskId },
    );
  }
  if (input.reason === "blocker_resolved" && row.budget_exhausted === 1) {
    return fail(
      "budget_exhausted",
      `task ${input.taskId} has budget_exhausted; orchestrator must escalate-human or cancel`,
      { task_id: input.taskId },
    );
  }
  const prior = loadLatestAttempt(deps.db, input.taskId);
  if (!prior) {
    return fail(
      "wrong_state",
      `task ${input.taskId} has no prior attempt; cannot schedule a brief`,
      { task_id: input.taskId },
    );
  }

  const now = deps.clock.nowISO();
  const consumedBudget = input.reason === "blocker_resolved" ? 1 : 0;
  const preambleBody = loadPreambleBody(deps.db, prior.preamble_id);

  let attemptId = -1;
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'queued',
                claimed_at = NULL,
                claim_id = NULL,
                claim_expirations_consecutive = 0,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'claimed-by-orchestrator'
            AND claim_id = ?
            AND cancel_requested_at IS NULL`,
      )
      .run(now, input.taskId, input.claimId);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      const fresh = loadTask(deps.db, input.taskId);
      deps.db.exec("ROLLBACK");
      if (!fresh) {
        return fail("unknown_task", `task ${input.taskId} not found`, {
          task_id: input.taskId,
        });
      }
      if (fresh.cancel_requested_at !== null) {
        return fail("cancelled", `task ${input.taskId} has cancel_requested_at set`, {
          task_id: input.taskId,
        });
      }
      if (fresh.state !== "claimed-by-orchestrator" || fresh.claim_id !== input.claimId) {
        return fail(
          "claim_lost",
          `claim_id mismatch on submit_brief for task ${input.taskId}`,
          { task_id: input.taskId },
        );
      }
      return fail("wrong_state", `task ${input.taskId} is in state ${fresh.state}`, {
        task_id: input.taskId,
        state: fresh.state,
      });
    }

    const attemptRow = deps.db
      .query<{ attempt_id: number }, [string, number, number, string, number]>(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, reason, consumed_budget
         ) VALUES (?, ?, ?, ?, ?)
         RETURNING attempt_id`,
      )
      .get(
        input.taskId,
        prior.attempt_number + 1,
        prior.preamble_id,
        input.reason,
        consumedBudget,
      );
    if (!attemptRow) throw new Error("attempt insert returned no row");
    attemptId = attemptRow.attempt_id;

    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId,
      kind: "brief",
      content: input.brief,
      extension: "md",
    });
    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId,
      kind: "final_prompt",
      content: `${preambleBody}\n\n${input.brief}`,
      extension: "md",
    });

    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, 'brief_submitted', 'claimed-by-orchestrator', 'queued', ?)`,
      )
      .run(input.taskId, attemptId, now);

    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    ok: true,
    value: { task_id: input.taskId, state: "queued", attempt_id: attemptId },
  };
}

export function escalate_human(
  deps: EscalateHumanDeps,
  input: EscalateHumanInput,
): ServiceResult<EscalateHumanResult> {
  const row = loadTask(deps.db, input.taskId);
  if (!row) {
    return fail("unknown_task", `task ${input.taskId} not found`, {
      task_id: input.taskId,
    });
  }
  if (row.cancel_requested_at !== null) {
    return fail("cancelled", `task ${input.taskId} has cancel_requested_at set`, {
      task_id: input.taskId,
    });
  }
  if (row.state !== "claimed-by-orchestrator") {
    return fail("wrong_state", `task ${input.taskId} is in state ${row.state}`, {
      task_id: input.taskId,
      state: row.state,
    });
  }
  if (row.claim_id !== input.claimId) {
    return fail(
      "claim_lost",
      `claim_id mismatch on escalate_human for task ${input.taskId}`,
      { task_id: input.taskId },
    );
  }

  const threadRef =
    input.threadRef !== undefined && input.threadRef !== null
      ? input.threadRef
      : row.slack_thread_ref;
  if (threadRef === null) {
    return fail(
      "validation_error",
      `task ${input.taskId} has no slack thread; pass threadRef or set on enqueue`,
      { task_id: input.taskId },
    );
  }

  const prior = loadLatestAttempt(deps.db, input.taskId);
  if (!prior) {
    return fail(
      "wrong_state",
      `task ${input.taskId} has no attempt to escalate against`,
      { task_id: input.taskId },
    );
  }

  const seq = row.next_escalation_seq;
  // Spec §5: nonce is `quay-esc-<task_id_short>-<seq>-<random8>` (8-char
  // hex from 4 random bytes; deps.ids supplies the suffix so tests stay
  // deterministic).
  const random8 = deps.ids.next().replace(/-/g, "").slice(0, 8).padEnd(8, "0");
  const nonce = `quay-esc-${taskIdShort(input.taskId)}-${seq}-${random8}`;
  // Spec §5: content_hash is computed over `question_body || seq || nonce`,
  // so every escalation gets a distinct row even when the body repeats.
  const escalationContentHash = createHash("sha256")
    .update(input.questionBody)
    .update(String(seq))
    .update(nonce)
    .digest("hex");
  const now = deps.clock.nowISO();

  // The artifact write (file + row) is done inside the SQL transaction so a
  // fence-failure ROLLBACK does not leak an artifact row. The on-disk file
  // may linger after rollback; that's tolerated because subsequent retries
  // mint a fresh nonce, so neither the file path nor the unique index ever
  // collides with the abandoned write.
  let artifactId = -1;
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const artifact = deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: prior.attempt_id,
      kind: "slack_escalation_post",
      content: input.questionBody,
      extension: "txt",
    });
    artifactId = artifact.artifactId;
    deps.db
      .query(
        `UPDATE artifacts
            SET escalation_seq = ?, escalation_nonce = ?, content_hash = ?
          WHERE artifact_id = ?`,
      )
      .run(seq, nonce, escalationContentHash, artifact.artifactId);

    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'waiting_human',
                claimed_at = NULL,
                claim_id = NULL,
                claim_expirations_consecutive = 0,
                next_escalation_seq = next_escalation_seq + 1,
                slack_thread_ref = ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'claimed-by-orchestrator'
            AND claim_id = ?
            AND cancel_requested_at IS NULL
            AND next_escalation_seq = ?`,
      )
      .run(threadRef, now, input.taskId, input.claimId, seq);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      const fresh = loadTask(deps.db, input.taskId);
      deps.db.exec("ROLLBACK");
      if (!fresh) {
        return fail("unknown_task", `task ${input.taskId} not found`, {
          task_id: input.taskId,
        });
      }
      if (fresh.cancel_requested_at !== null) {
        return fail("cancelled", `task ${input.taskId} has cancel_requested_at set`, {
          task_id: input.taskId,
        });
      }
      if (fresh.state !== "claimed-by-orchestrator" || fresh.claim_id !== input.claimId) {
        return fail(
          "claim_lost",
          `claim_id mismatch on escalate_human for task ${input.taskId}`,
          { task_id: input.taskId },
        );
      }
      return fail("wrong_state", `task ${input.taskId} is in state ${fresh.state}`, {
        task_id: input.taskId,
        state: fresh.state,
      });
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, 'human_escalated', 'claimed-by-orchestrator', 'waiting_human', ?, ?)`,
      )
      .run(input.taskId, prior.attempt_id, artifact.artifactId, now);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    ok: true,
    value: {
      task_id: input.taskId,
      state: "waiting_human",
      artifact_id: artifactId,
      escalation_seq: seq,
      escalation_nonce: nonce,
      thread_ref: threadRef,
    },
  };
}

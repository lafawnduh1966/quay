// Cancel from `waiting_human` (spec §15 case 29e). The pending Slack
// escalation artifact is preserved — Quay does not "un-post" the question to
// Slack, and the artifact is the human-readable record of what was asked.

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import { claim_task, escalate_human } from "../../src/core/claims.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";
import { FakeSlack } from "../support/fakes/slack.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_029e_cancel_waiting_human_preserves_slack_artifact", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-029e");
  const taskId = insertTask(h.db, {
    taskId: "task-029e",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });
  // Make sure the worktree path is real so cancel cleanup can sweep it.
  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run("C123:0.42", taskId);

  // Drive the task into waiting_human via the slice-6 escalate-human path.
  const built = buildTickDeps(h);
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("e2902902"); // deterministic nonce suffix
  const esc = escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "is this approach OK?",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  const stateBefore = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(stateBefore!.state).toBe("waiting_human");

  // Confirm the artifact exists on disk before cancel.
  const artBefore = h.db
    .query<
      {
        file_path: string;
        escalation_seq: number | null;
        escalation_nonce: string | null;
        content_hash: string | null;
      },
      [number]
    >(
      `SELECT file_path, escalation_seq, escalation_nonce, content_hash
         FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(artBefore).not.toBeNull();
  expect(existsSync(artBefore!.file_path)).toBe(true);

  // Cancel from waiting_human. No Slack API call — Slack writer is tick-only,
  // and cancel doesn't unpost.
  const slack = new FakeSlack();
  const result = cancel_task(built.deps, { taskId });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok");
  expect(result.value.outcome).toBe("cancelled");

  // Task is now cancelled.
  const finalTask = h.db
    .query<
      { state: string; cancel_requested_at: string | null; claim_id: string | null },
      [string]
    >(
      `SELECT state, cancel_requested_at, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(finalTask!.state).toBe("cancelled");
  expect(finalTask!.cancel_requested_at).not.toBeNull();
  expect(finalTask!.claim_id).toBeNull();

  // The slack_escalation_post artifact row still exists, untouched.
  const artAfter = h.db
    .query<
      {
        file_path: string;
        escalation_seq: number | null;
        escalation_nonce: string | null;
        content_hash: string | null;
      },
      [number]
    >(
      `SELECT file_path, escalation_seq, escalation_nonce, content_hash
         FROM artifacts WHERE artifact_id = ?`,
    )
    .get(esc.value.artifact_id);
  expect(artAfter).toEqual(artBefore);
  expect(existsSync(artAfter!.file_path)).toBe(true);

  // No Slack API call ever happened (cancel does not "unpost").
  expect(slack.totalCalls()).toBe(0);

  // Cancel cleanup ran — local branch / worktree deleted. We didn't seed any
  // remote PR, so no closePr / deleteRemoteBranch decisions to assert on
  // beyond their absence:
  expect(built.github.closePrCalls).toHaveLength(0);
});

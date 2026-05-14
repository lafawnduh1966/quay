import { afterEach, expect, test } from "bun:test";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import {
  claim_task,
  escalate_human,
  release_claim,
} from "../../src/core/claims.ts";
import { enqueueOrchestratorHandoff } from "../../src/core/orchestrator_handoffs.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_020d_release_claim_mismatch_is_claim_lost", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-release-mismatch");
  const taskId = insertTask(h.db, {
    taskId: "task-release-mismatch",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  const claimA = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claimA.ok) throw new Error("expected A to claim");
  const claimIdA = claimA.value.claim_id;

  // Tick auto-releases A's claim after timeout.
  h.clock.set("2026-04-28T11:00:00.000Z");
  const built = buildTickDeps(h);
  await tick_once(built.deps);

  // B claims and gets a fresh claim_id.
  const claimB = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claimB.ok) throw new Error("expected B to claim");
  const claimIdB = claimB.value.claim_id;

  // A tries to release with the stale claim_id — this is `claim_lost`,
  // distinguishable from the canonical no-op success on
  // already-released tasks.
  const release = release_claim({ db: h.db, clock: h.clock }, {
    taskId,
    claimId: claimIdA,
  });
  expect(release.ok).toBe(false);
  if (release.ok) throw new Error("expected release to fail");
  expect(release.error.code).toBe("claim_lost");

  const task = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("claimed-by-orchestrator");
  expect(task!.claim_id).toBe(claimIdB);
});

test("release_claim from waiting_human reopens the claimed handoff", async () => {
  h = createHarness();
  h.clock.set("2026-05-14T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-release-waiting");
  const taskId = insertTask(h.db, {
    taskId: "task-release-waiting",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-14T08:00:00.000Z",
  });
  const eventId = insertAwaitingEvent(taskId, "blocker_ingested");
  enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId, reason: "worker_blocker", stateEventId: eventId },
  );

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const claimId = claim.value.claim_id;
  expect(singleHandoff(taskId)).toMatchObject({
    status: "claimed",
    claim_id: claimId,
  });

  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  h.ids.push("waitrel1");
  const escalation = await escalate_human(
    { db: h.db, clock: h.clock, artifactStore: store, ids: h.ids },
    {
      taskId,
      claimId,
      questionBody: "Need human advice before continuing.",
    },
  );
  if (!escalation.ok) throw new Error("expected escalation");

  const release = release_claim(
    { db: h.db, clock: h.clock },
    { taskId, claimId },
  );
  if (!release.ok) throw new Error("expected release");
  expect(release.value).toEqual({
    task_id: taskId,
    state: "awaiting-next-brief",
    released: true,
  });

  const task = h.db
    .query<
      { state: string; claim_id: string | null; claimed_at: string | null },
      [string]
    >(
      `SELECT state, claim_id, claimed_at
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "awaiting-next-brief",
    claim_id: null,
    claimed_at: null,
  });
  expect(singleHandoff(taskId)).toMatchObject({
    status: "pending",
    claim_id: null,
  });

  const releaseEvent = h.db
    .query<{ from_state: string | null; to_state: string | null }, [string]>(
      `SELECT from_state, to_state
         FROM events
        WHERE task_id = ? AND event_type = 'claim_released'
        ORDER BY event_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  expect(releaseEvent).toEqual({
    from_state: "waiting_human",
    to_state: "awaiting-next-brief",
  });
});

function insertAwaitingEvent(taskId: string, eventType: string): number {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ event_id: number }, [string, string, string]>(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, ?, 'running', 'awaiting-next-brief', ?)
       RETURNING event_id`,
    )
    .get(taskId, eventType, h.clock.nowISO());
  if (!row) throw new Error("event insert returned no row");
  return row.event_id;
}

function singleHandoff(taskId: string) {
  if (!h) throw new Error("missing harness");
  const rows = h.db
    .query<{ status: string; claim_id: string | null }, [string]>(
      `SELECT status, claim_id
         FROM orchestrator_handoffs
        WHERE task_id = ?
        ORDER BY handoff_id`,
    )
    .all(taskId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

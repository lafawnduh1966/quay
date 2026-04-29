// §5 "schedule non-budget respawn" + §15 case 52: with cap N, the first N
// review/conflict respawns are scheduled normally (post-increment 1..N);
// the (N+1)th trigger parks the task in `non_budget_loop` and writes
// `non_budget_loop_parked`. The increment is still committed (forensics).
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_052_non_budget_cap_parks_on_n_plus_one", () => {
  h = createHarness();
  h.clock.set("2026-04-29T17:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-cap");
  const taskId = insertTask(h.db, {
    taskId: "task-cap",
    repoId,
    state: "pr-open",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T16:00:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "initial brief",
    extension: "md",
  });

  // Cap = 3. Trigger four distinct conflict observations across four ticks.
  // The first three should schedule normally; the fourth must park.
  const observations = ["h1:b1", "h2:b2", "h3:b3", "h4:b4"];

  for (let i = 0; i < observations.length; i++) {
    const [head, base] = observations[i]!.split(":");
    built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
      state: "open",
      headSha: head!,
      baseSha: base!,
      mergeable: "conflicting",
      latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
      checks: {
        checkSha: head!,
        items: [
          { name: "build", workflow: null, bucket: "pending", required: true },
        ],
      },
    });

    const results = tick_once(built.deps, { maxNonBudgetRespawns: 3 });

    if (i < 3) {
      // Scheduled. Task moved to `queued`. Reset to pr-open + clear pending
      // attempt so we can simulate the next observation cleanly without
      // tick promoting the queued attempt (we want repeated triggers from
      // the SAME state).
      expect(results).toEqual([
        { task_id: taskId, action: "conflict_respawn_scheduled" },
      ]);
      const task = h.db
        .query<{ non_budget_respawns_consumed: number; state: string }, [string]>(
          `SELECT non_budget_respawns_consumed, state FROM tasks WHERE task_id = ?`,
        )
        .get(taskId);
      expect(task?.non_budget_respawns_consumed).toBe(i + 1);
      expect(task?.state).toBe("queued");
      // Drop the pending attempt + dependents and restore pr-open so the
      // next iteration re-enters the conflict branch from pr-open.
      const pending = h.db
        .query<{ attempt_id: number }, [string]>(
          `SELECT attempt_id FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
        )
        .get(taskId);
      if (pending) {
        h.db
          .query(`DELETE FROM events WHERE attempt_id = ?`)
          .run(pending.attempt_id);
        h.db
          .query(`DELETE FROM artifacts WHERE attempt_id = ?`)
          .run(pending.attempt_id);
        h.db
          .query(`DELETE FROM attempts WHERE attempt_id = ?`)
          .run(pending.attempt_id);
      }
      h.db
        .query(`UPDATE tasks SET state = 'pr-open' WHERE task_id = ?`)
        .run(taskId);
    } else {
      // Cap exceeded: parked.
      expect(results).toEqual([
        { task_id: taskId, action: "non_budget_loop_parked" },
      ]);
      const task = h.db
        .query<
          {
            state: string;
            non_budget_respawns_consumed: number;
            attempts_consumed: number;
          },
          [string]
        >(
          `SELECT state, non_budget_respawns_consumed, attempts_consumed
             FROM tasks WHERE task_id = ?`,
        )
        .get(taskId);
      expect(task).toEqual({
        state: "non_budget_loop",
        non_budget_respawns_consumed: 4, // post-increment recorded
        attempts_consumed: 1,
      });

      // No new pending attempt scheduled on the parking trigger.
      const pending = h.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
        )
        .get(taskId);
      expect(pending?.n).toBe(0);

      const parked = h.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM events
            WHERE task_id = ? AND event_type = 'non_budget_loop_parked'`,
        )
        .get(taskId);
      expect(parked?.n).toBe(1);
    }
  }
});

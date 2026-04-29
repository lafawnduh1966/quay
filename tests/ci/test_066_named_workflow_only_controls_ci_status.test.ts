// §5 "CI status rules" — when `repos.ci_workflow_name` is set, only checks
// whose `workflow` matches that name participate in the pass/fail/pending
// decision. Failures on unrelated workflows must NOT prevent the
// `pr-open → done` transition (and a passing other workflow must NOT cover
// for a failing named workflow on a separate test).
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function insertRepoWithWorkflow(
  db: Harness["db"],
  repoId: string,
  workflowName: string,
): string {
  db.query(
    `INSERT INTO repos (
       repo_id, repo_url, base_branch, package_manager, install_cmd,
       ci_workflow_name, created_at
     ) VALUES (?, ?, 'main', 'bun', 'bun install', ?, ?)`,
  ).run(repoId, "git@example:r.git", workflowName, "2026-01-01T00:00:00.000Z");
  return repoId;
}

test("test_066_named_workflow_only_controls_ci_status", () => {
  h = createHarness();
  h.clock.set("2026-04-29T08:00:00.000Z");

  const repoId = insertRepoWithWorkflow(h.db, "repo-named-wf", "ci.yml");
  const taskId = insertTask(h.db, {
    taskId: "task-named-wf",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-29T07:30:00.000Z" });

  const built = buildTickDeps(h);
  // Named workflow passes; an unrelated workflow fails. Spec requires the
  // named workflow to be the sole authority — task should transition to
  // `done`, NOT trigger a `ci_fail` retry.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "sha-head",
    baseSha: "sha-base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-head",
      items: [
        { name: "build", workflow: "ci.yml", bucket: "pass", required: true },
        { name: "lint", workflow: "ci.yml", bucket: "pass", required: true },
        { name: "preview", workflow: "ci.yml", bucket: "cancelled", required: false },
        // Unrelated workflow fails — should be ignored.
        { name: "deploy", workflow: "deploy.yml", bucket: "fail", required: false },
        { name: "preview", workflow: "preview.yml", bucket: "fail", required: false },
      ],
    },
  });

  const results = tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "ci_passed" }]);

  const task = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "done", attempts_consumed: 0 });

  // Symmetry: named workflow failing while another passes must produce
  // `ci_fail`, not be masked by the passing unrelated workflow.
  h.clock.set("2026-04-29T09:00:00.000Z");
  const repoId2 = insertRepoWithWorkflow(h.db, "repo-named-wf-fail", "ci.yml");
  const taskId2 = insertTask(h.db, {
    taskId: "task-named-wf-fail",
    repoId: repoId2,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId: taskId2,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T08:00:00.000Z",
  });
  built.github.setPrSnapshot(repoId2, `quay/${taskId2}`, {
    state: "open",
    headSha: "sha-h2",
    baseSha: "sha-b2",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-h2",
      items: [
        { name: "build", workflow: "ci.yml", bucket: "fail", required: true },
        { name: "deploy", workflow: "deploy.yml", bucket: "pass", required: false },
      ],
    },
  });

  const results2 = tick_once(built.deps);
  // The first task is now in `done`; its done handler runs but produces
  // nothing actionable (no merged/closed/conflict/review). So results only
  // include the second task's CI fail.
  expect(results2).toEqual([{ task_id: taskId2, action: "ci_failed" }]);
});

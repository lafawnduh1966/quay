import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { GitPort } from "../ports/git.ts";
import type { IdGenerator } from "../ports/id_generator.ts";
import {
  computeBranchSlug,
  computeTmuxId,
  taskIdShort,
} from "./branch_slug.ts";
import { QuayError } from "./errors.ts";
import { ensurePreambleId, loadPreambleBody } from "./preamble.ts";

export const DEFAULT_RETRY_BUDGET = 5;

export interface EnqueuePaths {
  reposRoot: string;
  worktreesRoot: string;
  artifactsRoot: string;
}

export interface EnqueueDeps {
  db: DB;
  clock: Clock;
  ids: IdGenerator;
  git: GitPort;
  commandRunner: CommandRunner;
  artifactStore: ArtifactStore;
  paths: EnqueuePaths;
  retryBudget?: number;
}

export const enqueueInputSchema = z
  .object({
    repo_id: z.string().min(1),
    brief: z.string().min(1),
    external_ref: z.string().nullable().optional(),
    ticket_snapshot: z.string().nullable().optional(),
    slack_thread_ref: z.string().nullable().optional(),
  })
  .strict();

export type EnqueueInput = z.infer<typeof enqueueInputSchema>;

export interface EnqueueResult {
  task_id: string;
  state: "queued";
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  attempt_id: number;
}

interface RepoRow {
  repo_id: string;
  repo_url: string;
  base_branch: string;
  install_cmd: string;
  archived_at: string | null;
}

export function enqueue(deps: EnqueueDeps, rawInput: unknown): EnqueueResult {
  const input = parseInput(rawInput);

  const repo = lookupRepo(deps.db, input.repo_id);
  if (!repo) {
    throw new QuayError("unknown_repo", `repo "${input.repo_id}" not found`, {
      repo_id: input.repo_id,
    });
  }
  if (repo.archived_at !== null) {
    throw new QuayError(
      "repo_archived",
      `repo "${input.repo_id}" is archived; new tasks are rejected`,
      { repo_id: input.repo_id },
    );
  }

  const taskId = deps.ids.next();
  const shortId = taskIdShort(taskId);
  const tmuxId = computeTmuxId(input.external_ref, shortId);
  const worktreePath = join(deps.paths.worktreesRoot, taskId);
  const retryBudget = deps.retryBudget ?? DEFAULT_RETRY_BUDGET;

  // Track substrate side effects so rollback knows what to undo.
  const cloneExistedBeforeCall = deps.git.bareCloneExists(repo.repo_id);
  let cloneAttemptedThisCall = false;
  let worktreeCreated = false;
  let branchCreated = false;
  let fullBranchName: string | null = null;
  const writtenArtifactPaths: string[] = [];

  const rollback = () => {
    if (worktreeCreated) {
      try {
        deps.git.worktreeRemove(worktreePath);
      } catch {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {}
      }
    }
    if (branchCreated && fullBranchName !== null) {
      try {
        deps.git.branchDelete(repo.repo_id, fullBranchName);
      } catch {}
    }
    // Per §12 enqueue rollback table: only clean up the bare clone if THIS
    // enqueue created it. A pre-existing bare clone from a prior task stays.
    if (cloneAttemptedThisCall && !cloneExistedBeforeCall) {
      try {
        deps.git.removeBareClone(repo.repo_id);
      } catch {}
    }
    // Best-effort artifact file cleanup. SQL rollback removes the rows.
    try {
      rmSync(join(deps.paths.artifactsRoot, taskId), {
        recursive: true,
        force: true,
      });
    } catch {}
    for (const p of writtenArtifactPaths) {
      try {
        rmSync(p, { force: true });
      } catch {}
    }
  };

  try {
    // Step 1: bare clone (first task per repo only).
    if (!cloneExistedBeforeCall) {
      cloneAttemptedThisCall = true;
      deps.git.cloneBare(repo.repo_id, repo.repo_url);
    }

    // Step 2: fetch base branch.
    deps.git.fetch(repo.repo_id, repo.base_branch);

    // Step 3: branch resolution + collision check. Returns the bare slug;
    // the local/remote branch is `quay/<slug>` per spec §13. We carry the
    // full `quay/<slug>` form everywhere downstream — worktree-add, SQL,
    // rollback — so tick.ts (fetch / remoteHeadSha / PR check) and the
    // worker's eventual push all agree on the same ref.
    const resolvedSlug = resolveBranchName(
      deps.git,
      repo.repo_id,
      input.external_ref ?? null,
      shortId,
    );
    fullBranchName = `quay/${resolvedSlug}`;

    // Step 4: worktree add. This both creates the directory and registers the local branch.
    deps.git.worktreeAdd(
      repo.repo_id,
      worktreePath,
      fullBranchName,
      `origin/${repo.base_branch}`,
    );
    worktreeCreated = true;
    branchCreated = true;

    // Step 5: install_cmd.
    const installResult = deps.commandRunner.run(repo.install_cmd, {
      cwd: worktreePath,
    });
    if (installResult.exitCode !== 0) {
      throw new QuayError(
        "bootstrap_failed",
        `install_cmd failed (exit ${installResult.exitCode}): ${installResult.stderr.trim()}`,
        {
          step: "install",
          exit_code: installResult.exitCode,
          stderr: installResult.stderr,
        },
      );
    }

    // Step 6: SQL transaction + artifact writes.
    const preambleId = ensurePreambleId(deps.db, deps.clock);
    const preambleBody = loadPreambleBody(deps.db, preambleId);
    const finalPrompt = `${preambleBody}\n\n${input.brief}`;
    const now = deps.clock.nowISO();

    deps.db.exec("BEGIN");
    let attemptId = -1;
    try {
      deps.db
        .query(
          `INSERT INTO tasks (
             task_id, repo_id, external_ref, state, branch_name, tmux_id, worktree_path,
             retry_budget, slack_thread_ref, created_at, updated_at
           ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          repo.repo_id,
          input.external_ref ?? null,
          fullBranchName,
          tmuxId,
          worktreePath,
          retryBudget,
          input.slack_thread_ref ?? null,
          now,
          now,
        );

      const attemptRow = deps.db
        .query<{ attempt_id: number }, [string, number, number, string, number]>(
          `INSERT INTO attempts (
             task_id, attempt_number, preamble_id, reason, consumed_budget
           ) VALUES (?, ?, ?, ?, ?)
           RETURNING attempt_id`,
        )
        .get(taskId, 1, preambleId, "initial", 1);
      if (!attemptRow) throw new Error("attempt insert returned no row");
      attemptId = attemptRow.attempt_id;

      if (input.ticket_snapshot !== undefined && input.ticket_snapshot !== null) {
        const t = deps.artifactStore.writeArtifact({
          taskId,
          attemptId: null,
          kind: "ticket_snapshot",
          content: input.ticket_snapshot,
          extension: "md",
        });
        writtenArtifactPaths.push(t.filePath);
      }

      const briefArtifact = deps.artifactStore.writeArtifact({
        taskId,
        attemptId,
        kind: "brief",
        content: input.brief,
        extension: "md",
      });
      writtenArtifactPaths.push(briefArtifact.filePath);

      const finalArtifact = deps.artifactStore.writeArtifact({
        taskId,
        attemptId,
        kind: "final_prompt",
        content: finalPrompt,
        extension: "md",
      });
      writtenArtifactPaths.push(finalArtifact.filePath);

      deps.db.exec("COMMIT");
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }

    // The branch_name column carries the full `quay/<slug>` form.
    return {
      task_id: taskId,
      state: "queued",
      branch_name: fullBranchName,
      tmux_id: tmuxId,
      worktree_path: worktreePath,
      attempt_id: attemptId,
    };
  } catch (err) {
    rollback();
    throw err;
  }
}

function parseInput(raw: unknown): EnqueueInput {
  const result = enqueueInputSchema.safeParse(raw);
  if (result.success) return result.data;
  const summary = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new QuayError("validation_error", `enqueue input invalid: ${summary}`, {
    issues: result.error.issues,
  });
}

function lookupRepo(db: DB, repoId: string): RepoRow | null {
  return (
    db
      .query<RepoRow, [string]>(
        `SELECT repo_id, repo_url, base_branch, install_cmd, archived_at
           FROM repos WHERE repo_id = ?`,
      )
      .get(repoId) ?? null
  );
}

function isBranchTaken(git: GitPort, repoId: string, slug: string): boolean {
  const branch = `quay/${slug}`;
  if (git.hasLocalBranch(repoId, branch)) return true;
  if (git.hasRemoteBranch(repoId, branch)) return true;
  if (git.hasOpenPullRequestForBranch(repoId, branch)) return true;
  return false;
}

function resolveBranchName(
  git: GitPort,
  repoId: string,
  externalRef: string | null,
  shortId: string,
): string {
  // Step 1: JS-side normalization per spec §13. Already covers most cases,
  // but the spec's step 7 requires the real `git check-ref-format` gate as
  // defense-in-depth in case the rules above and git's own grammar drift.
  const preferred = git.safeBranchSlug(
    computeBranchSlug(externalRef, shortId),
    shortId,
  );
  if (!isBranchTaken(git, repoId, preferred)) return preferred;
  // Step 2: collision suffix. Re-validate via the same gate — appending
  // `-<shortId>` cannot introduce ref-illegal chars (shortId is hex), but the
  // overall length might trip a check; safeBranchSlug is the single arbiter.
  const disambiguated = git.safeBranchSlug(`${preferred}-${shortId}`, shortId);
  if (!isBranchTaken(git, repoId, disambiguated)) return disambiguated;
  throw new QuayError(
    "branch_collision_unresolvable",
    `branch quay/${disambiguated} is already taken`,
    { branch: `quay/${disambiguated}` },
  );
}

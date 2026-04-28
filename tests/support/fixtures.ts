import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../../src/db/connection.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import type { Clock } from "../../src/ports/clock.ts";

const NOW = "2026-01-01T00:00:00.000Z";

export function insertRepo(db: DB, repoId = "repo-1"): string {
  db.query(
    `INSERT INTO repos (repo_id, repo_url, base_branch, package_manager, install_cmd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(repoId, "git@example:r.git", "main", "bun", "bun install", NOW);
  return repoId;
}

export function insertPreamble(db: DB): number {
  const row = db
    .query<{ preamble_id: number }, [string, string]>(
      `INSERT INTO preambles (body, created_at) VALUES (?, ?) RETURNING preamble_id`,
    )
    .get("preamble body", NOW);
  if (!row) throw new Error("preamble insert returned no row");
  return row.preamble_id;
}

export interface InsertTaskOptions {
  taskId?: string;
  repoId?: string;
  state?: string;
}

export function insertTask(db: DB, opts: InsertTaskOptions = {}): string {
  const repoId = opts.repoId ?? insertRepo(db);
  const taskId = opts.taskId ?? "task-1";
  const state = opts.state ?? "queued";
  db.query(
    `INSERT INTO tasks (
       task_id, repo_id, state, branch_name, tmux_id, worktree_path,
       retry_budget, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    repoId,
    state,
    `quay/${taskId}`,
    `quay-task-${taskId}`,
    `/tmp/${taskId}`,
    5,
    NOW,
    NOW,
  );
  return taskId;
}

export interface InsertAttemptOptions {
  taskId: string;
  attemptNumber?: number;
  preambleId?: number;
  reason?: string;
  consumedBudget?: 0 | 1;
  spawnedAt?: string | null;
}

export function insertAttempt(db: DB, opts: InsertAttemptOptions): number {
  const preambleId = opts.preambleId ?? insertPreamble(db);
  const row = db
    .query<{ attempt_id: number }, [string, number, number, string, number, string | null]>(
      `INSERT INTO attempts (
         task_id, attempt_number, preamble_id, reason, consumed_budget, spawned_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING attempt_id`,
    )
    .get(
      opts.taskId,
      opts.attemptNumber ?? 1,
      preambleId,
      opts.reason ?? "initial",
      opts.consumedBudget ?? 1,
      opts.spawnedAt ?? null,
    );
  if (!row) throw new Error("attempt insert returned no row");
  return row.attempt_id;
}

export function insertFinalPromptArtifact(
  db: DB,
  artifactRoot: string,
  clock: Clock,
  taskId: string,
  attemptId: number,
  content = "final prompt\n",
): number {
  const store = createArtifactStore({ db, artifactRoot, clock });
  return store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content,
    extension: "md",
  }).artifactId;
}

export interface InsertRunningOptions {
  taskId?: string;
  repoId?: string;
  branchName?: string;
  tmuxId?: string;
  attemptNumber?: number;
  preambleId?: number;
  reason?: string;
  consumedBudget?: 0 | 1;
  spawnedAt?: string;
  remoteShaAtSpawn?: string | null;
  prExistedAtSpawn?: 0 | 1;
  tmuxSession?: string | null;
  attemptsConsumed?: number;
  worktreesRoot: string;
}

export interface RunningTaskFixture {
  taskId: string;
  repoId: string;
  attemptId: number;
  attemptNumber: number;
  branchName: string;
  tmuxId: string;
  worktreePath: string;
  sessionName: string | null;
}

// Inserts a task in `running` state with a fully-promoted attempt and a real
// on-disk worktree directory. Used by classifier tests that exercise the
// dead-worker path against a worktree containing (or not containing) a
// `.quay-blocked.md` file.
export function insertRunningTask(
  db: DB,
  opts: InsertRunningOptions,
): RunningTaskFixture {
  const repoId = opts.repoId ?? insertRepo(db);
  const taskId = opts.taskId ?? "task-running";
  const attemptNumber = opts.attemptNumber ?? 1;
  const branchName = opts.branchName ?? `quay/${taskId}`;
  const tmuxId = opts.tmuxId ?? `tmux-${taskId}`;
  const worktreePath = join(opts.worktreesRoot, taskId);
  mkdirSync(worktreePath, { recursive: true });
  const sessionName =
    opts.tmuxSession === undefined
      ? `quay-task-${tmuxId}-${attemptNumber}`
      : opts.tmuxSession;

  db.query(
    `INSERT INTO tasks (
       task_id, repo_id, state, branch_name, tmux_id, worktree_path,
       attempts_consumed, retry_budget, created_at, updated_at
     ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    repoId,
    branchName,
    tmuxId,
    worktreePath,
    opts.attemptsConsumed ?? 1,
    5,
    NOW,
    NOW,
  );

  const preambleId = opts.preambleId ?? insertPreamble(db);
  const row = db
    .query<
      { attempt_id: number },
      [string, number, number, string, number, string, string | null, number, string | null]
    >(
      `INSERT INTO attempts (
         task_id, attempt_number, preamble_id, reason, consumed_budget,
         spawned_at, remote_sha_at_spawn, pr_existed_at_spawn, tmux_session
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING attempt_id`,
    )
    .get(
      taskId,
      attemptNumber,
      preambleId,
      opts.reason ?? "initial",
      opts.consumedBudget ?? 1,
      opts.spawnedAt ?? NOW,
      opts.remoteShaAtSpawn ?? null,
      opts.prExistedAtSpawn ?? 0,
      sessionName,
    );
  if (!row) throw new Error("attempt insert returned no row");

  return {
    taskId,
    repoId,
    attemptId: row.attempt_id,
    attemptNumber,
    branchName,
    tmuxId,
    worktreePath,
    sessionName,
  };
}

export function writeBlockerFile(worktreePath: string, content: string): string {
  const path = join(worktreePath, ".quay-blocked.md");
  writeFileSync(path, content);
  return path;
}

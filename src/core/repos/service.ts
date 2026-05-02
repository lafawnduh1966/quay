import type { DB } from "../../db/connection.ts";
import type { Clock } from "../../ports/clock.ts";
import { QuayError } from "../errors.ts";
import {
  repoAddInputSchema,
  repoImportInputSchema,
  repoUpdateInputSchema,
  type RepoAddInput,
  type RepoImportInput,
  type RepoUpdateInput,
} from "./schema.ts";

export interface RepoRow {
  repo_id: string;
  repo_url: string;
  base_branch: string;
  package_manager: string;
  install_cmd: string;
  test_cmd: string | null;
  ci_workflow_name: string | null;
  contribution_guide_path: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface RepoServiceDeps {
  db: DB;
  clock: Clock;
}

export interface RepoService {
  add(input: unknown): RepoRow;
  update(repoId: string, patch: unknown): RepoRow;
  remove(repoId: string): RepoRow;
  get(repoId: string): RepoRow | null;
  // Per spec §10 read commands: full registry, archived rows included so
  // operators can see what's been soft-deleted. Stable order by repo_id.
  list(): RepoRow[];
  // Bulk-restore companion to `add`: spec §10 says `quay repo import` upserts.
  // Unlike `add` (which errors on duplicate, non-archived), `upsert` always
  // writes. When the input row carries `archived_at`/`created_at`, those are
  // preserved (full-fidelity backup restore); when omitted on insert,
  // `created_at` defaults to `now()` and `archived_at` to NULL.
  upsert(input: unknown): RepoRow;
}

const SELECT_REPO_COLUMNS = `
  repo_id, repo_url, base_branch, package_manager, install_cmd,
  test_cmd, ci_workflow_name, contribution_guide_path,
  archived_at, created_at
`;

// Mirrors spec §10: repo removal blocks non-terminal, non-parked tasks only.
// Parked and terminal tasks keep their FK for forensics after archival.
const ACTIVE_TASK_STATES = [
  "queued",
  "running",
  "pr-open",
  "done",
  "awaiting-next-brief",
  "claimed-by-orchestrator",
  "waiting_human",
] as const;

export function createRepoService({ db, clock }: RepoServiceDeps): RepoService {
  function get(repoId: string): RepoRow | null {
    return (
      db
        .query<RepoRow, [string]>(
          `SELECT ${SELECT_REPO_COLUMNS} FROM repos WHERE repo_id = ?`,
        )
        .get(repoId) ?? null
    );
  }

  function add(rawInput: unknown): RepoRow {
    const parsed = parseOrThrow(repoAddInputSchema, rawInput, "repo add");
    const existing = get(parsed.repo_id);
    if (existing && existing.archived_at === null) {
      throw new QuayError(
        "duplicate_repo",
        `repo "${parsed.repo_id}" already exists`,
        { repo_id: parsed.repo_id },
      );
    }

    if (existing) {
      // Per spec §10: re-adding an archived repo reactivates (clears archived_at).
      db.query(
        `UPDATE repos
           SET repo_url = ?, base_branch = ?, package_manager = ?, install_cmd = ?,
               test_cmd = ?, ci_workflow_name = ?, contribution_guide_path = ?,
               archived_at = NULL
         WHERE repo_id = ?`,
      ).run(
        parsed.repo_url,
        parsed.base_branch,
        parsed.package_manager,
        parsed.install_cmd,
        parsed.test_cmd ?? null,
        parsed.ci_workflow_name ?? null,
        parsed.contribution_guide_path ?? null,
        parsed.repo_id,
      );
    } else {
      db.query(
        `INSERT INTO repos (
           repo_id, repo_url, base_branch, package_manager, install_cmd,
           test_cmd, ci_workflow_name, contribution_guide_path, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.repo_id,
        parsed.repo_url,
        parsed.base_branch,
        parsed.package_manager,
        parsed.install_cmd,
        parsed.test_cmd ?? null,
        parsed.ci_workflow_name ?? null,
        parsed.contribution_guide_path ?? null,
        clock.nowISO(),
      );
    }
    return get(parsed.repo_id)!;
  }

  function update(repoId: string, rawPatch: unknown): RepoRow {
    const patch = parseOrThrow(repoUpdateInputSchema, rawPatch, "repo update");
    const existing = get(repoId);
    if (!existing) {
      throw new QuayError("unknown_repo", `repo "${repoId}" not found`, {
        repo_id: repoId,
      });
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return existing;
    values.push(repoId);
    db.query(`UPDATE repos SET ${sets.join(", ")} WHERE repo_id = ?`).run(
      ...(values as Parameters<ReturnType<typeof db.query>["run"]>),
    );
    return get(repoId)!;
  }

  function remove(repoId: string): RepoRow {
    const existing = get(repoId);
    if (!existing) {
      throw new QuayError("unknown_repo", `repo "${repoId}" not found`, {
        repo_id: repoId,
      });
    }
    if (existing.archived_at !== null) return existing;
    const placeholders = ACTIVE_TASK_STATES.map(() => "?").join(", ");
    const active = db
      .query<{ n: number }, [string, ...string[]]>(
        `SELECT COUNT(*) AS n
           FROM tasks
          WHERE repo_id = ?
            AND state IN (${placeholders})`,
      )
      .get(repoId, ...ACTIVE_TASK_STATES);
    if ((active?.n ?? 0) > 0) {
      throw new QuayError(
        "repo_has_active_tasks",
        `repo "${repoId}" has active tasks and cannot be archived`,
        { repo_id: repoId, active_tasks: active!.n },
      );
    }
    db.query(`UPDATE repos SET archived_at = ? WHERE repo_id = ?`).run(
      clock.nowISO(),
      repoId,
    );
    return get(repoId)!;
  }

  function list(): RepoRow[] {
    return db
      .query<RepoRow, []>(
        `SELECT ${SELECT_REPO_COLUMNS} FROM repos ORDER BY repo_id ASC`,
      )
      .all();
  }

  function upsert(rawInput: unknown): RepoRow {
    const parsed = parseOrThrow(repoImportInputSchema, rawInput, "repo import");
    const existing = get(parsed.repo_id);
    // Carry archived_at/created_at through whenever the dump includes them
    // so a roundtrip export → wipe → import faithfully restores the same
    // rows. When omitted (hand-written dumps, fresh imports of a single
    // row), preserve the existing values for an existing row, else default.
    const archivedAt =
      parsed.archived_at !== undefined
        ? parsed.archived_at
        : (existing?.archived_at ?? null);
    const createdAt =
      parsed.created_at !== undefined
        ? parsed.created_at
        : (existing?.created_at ?? clock.nowISO());
    if (existing) {
      db.query(
        `UPDATE repos
           SET repo_url = ?, base_branch = ?, package_manager = ?, install_cmd = ?,
               test_cmd = ?, ci_workflow_name = ?, contribution_guide_path = ?,
               archived_at = ?, created_at = ?
         WHERE repo_id = ?`,
      ).run(
        parsed.repo_url,
        parsed.base_branch,
        parsed.package_manager,
        parsed.install_cmd,
        parsed.test_cmd ?? null,
        parsed.ci_workflow_name ?? null,
        parsed.contribution_guide_path ?? null,
        archivedAt,
        createdAt,
        parsed.repo_id,
      );
    } else {
      db.query(
        `INSERT INTO repos (
           repo_id, repo_url, base_branch, package_manager, install_cmd,
           test_cmd, ci_workflow_name, contribution_guide_path,
           archived_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.repo_id,
        parsed.repo_url,
        parsed.base_branch,
        parsed.package_manager,
        parsed.install_cmd,
        parsed.test_cmd ?? null,
        parsed.ci_workflow_name ?? null,
        parsed.contribution_guide_path ?? null,
        archivedAt,
        createdAt,
      );
    }
    return get(parsed.repo_id)!;
  }

  return { add, update, remove, get, list, upsert };
}

function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  raw: unknown,
  label: string,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const summary = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new QuayError("validation_error", `${label} input invalid: ${summary}`, {
    issues: result.error.issues,
  });
}

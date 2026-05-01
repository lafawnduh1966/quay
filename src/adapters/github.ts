// Real GitHub adapter. Shells out to the `gh` CLI from inside the bare clone
// for `<repoId>`, so `gh` infers the upstream repo from `origin` rather than
// requiring an explicit owner/name pair on every call. The GitHubCliAdapter
// throws on any unexpected `gh` failure; tick wraps these in the per-task
// `tick_error` path (spec §5).
//
// Schema mapping (see ports/github.ts for the type definitions):
//   - PR existence:       `gh pr list --head <branch> --state all --json number`
//   - PR open?:           `gh pr list --head <branch> --state open --json number`
//   - PR snapshot fields: `gh pr view <branch> --json state,headRefOid,baseRefOid,
//                                                mergeable,reviewDecision,latestReviews,
//                                                reviews,comments`
//   - Required-check set: `gh pr checks <branch> --json bucket,workflow,name,state`
//   - Closing the PR:     `gh pr close <branch>`  (idempotent: tolerates "already closed"
//                                                  and "no PR" by inspecting stderr)
import { join, resolve } from "node:path";
import type {
  GitHubPort,
  PrCheck,
  PrCheckBucket,
  PrCheckStatus,
  PrChecksReport,
  PrLatestReview,
  PrMergeableState,
  PrReviewDecision,
  PrSnapshot,
  PrTerminalState,
} from "../ports/github.ts";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitHubCliAdapter implements GitHubPort {
  constructor(private readonly reposRoot: string) {}

  prExistsForBranch(repoId: string, branch: string): boolean {
    const list = this.listPrs(repoId, branch, "all");
    return list.length > 0;
  }

  prCheckStatus(repoId: string, branch: string): PrCheckStatus {
    const checks = this.fetchChecks(repoId, branch);
    if (checks.items.length === 0) return { state: "pending" };
    const anyFail = checks.items.some((c) => c.bucket === "fail");
    if (anyFail) {
      return checks.failureExcerpt !== undefined
        ? { state: "fail", excerpt: checks.failureExcerpt }
        : { state: "fail" };
    }
    const anyPending = checks.items.some((c) => c.bucket === "pending");
    if (anyPending) return { state: "pending" };
    return { state: "pass" };
  }

  prIsOpen(repoId: string, branch: string): boolean {
    return this.listPrs(repoId, branch, "open").length > 0;
  }

  closePr(repoId: string, branch: string): void {
    // Idempotent per spec §5: a closed/merged PR or a missing PR is a no-op.
    const result = this.run(repoId, ["gh", "pr", "close", branch]);
    if (result.exitCode === 0) return;
    const msg = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (
      msg.includes("already closed") ||
      msg.includes("no pull request") ||
      msg.includes("not found")
    ) {
      return;
    }
    throw new Error(`gh pr close ${branch} failed: ${result.stderr.trim()}`);
  }

  prSnapshot(repoId: string, branch: string): PrSnapshot | null {
    const view = this.fetchPrView(repoId, branch);
    if (view === null) return null;
    const checks = this.fetchChecks(repoId, branch);
    return {
      state: view.state,
      headSha: view.headSha,
      baseSha: view.baseSha,
      mergeable: view.mergeable,
      latestReview: view.latestReview,
      checks,
    };
  }

  // -- helpers ------------------------------------------------------------

  private listPrs(
    repoId: string,
    branch: string,
    state: "open" | "closed" | "all",
  ): Array<{ number: number }> {
    const result = this.run(repoId, [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      state,
      "--json",
      "number",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh pr list --head ${branch} --state ${state} failed: ${result.stderr.trim()}`,
      );
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      throw new Error(
        `gh pr list returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
  }

  private fetchPrView(
    repoId: string,
    branch: string,
  ):
    | (Omit<PrSnapshot, "checks">)
    | null {
    const fields = [
      "state",
      "headRefOid",
      "baseRefOid",
      "mergeable",
      "reviewDecision",
      "latestReviews",
    ].join(",");
    const result = this.run(repoId, [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      fields,
    ]);
    if (result.exitCode !== 0) {
      // `gh pr view` exits non-zero with "no pull requests found" when no PR
      // exists for the branch — that's the spec-defined "no PR" case, not an
      // error condition.
      if (
        result.stderr.toLowerCase().includes("no pull request") ||
        result.stderr.toLowerCase().includes("not found")
      ) {
        return null;
      }
      throw new Error(
        `gh pr view ${branch} failed: ${result.stderr.trim()}`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `gh pr view returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    return {
      state: mapPrState(parsed.state),
      headSha: String(parsed.headRefOid ?? ""),
      baseSha:
        parsed.baseRefOid !== null && parsed.baseRefOid !== undefined
          ? String(parsed.baseRefOid)
          : null,
      mergeable: mapMergeable(parsed.mergeable),
      latestReview: extractLatestReview(parsed),
    };
  }

  private fetchChecks(repoId: string, branch: string): PrChecksReport {
    const fields = ["bucket", "workflow", "name", "state"].join(",");
    const result = this.run(repoId, [
      "gh",
      "pr",
      "checks",
      branch,
      "--json",
      fields,
    ]);
    if (result.exitCode !== 0) {
      // No checks on this PR yet → empty set, treated as pending by §5.
      const msg = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (msg.includes("no checks") || msg.includes("not found")) {
        return { checkSha: null, items: [] };
      }
      throw new Error(
        `gh pr checks ${branch} failed: ${result.stderr.trim()}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `gh pr checks returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) return { checkSha: null, items: [] };
    const items: PrCheck[] = parsed.map((row) => mapCheckRow(row));
    return {
      // `gh pr checks` doesn't expose the SHA the runs were against, so we
      // pass null. The stale-SHA detector in tick uses `headRefOid` from
      // `gh pr view` plus a separate read; the adapter exposes what `gh`
      // gives us directly. Future refinement: shell out to `gh api` for the
      // commit SHA per check run when stale-SHA detection needs it.
      checkSha: null,
      items,
    };
  }

  private run(repoId: string, cmd: string[]): RunResult {
    const cwd = this.bareDir(repoId);
    const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode ?? 0,
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
    };
  }

  private bareDir(repoId: string): string {
    // Mirrors LocalGitAdapter.bareDir's containment check so a bypassed
    // schema can't smuggle a `repo_id` like `../escape` into a `gh` cwd.
    if (
      !/^[A-Za-z0-9._-]+$/.test(repoId) ||
      repoId === "." ||
      repoId === ".."
    ) {
      throw new Error(`repo_id "${repoId}" is not a safe identifier`);
    }
    const root = resolve(this.reposRoot);
    const dir = resolve(this.reposRoot, `${repoId}.git`);
    if (!dir.startsWith(`${root}/`) && dir !== root) {
      throw new Error(
        `repo_id "${repoId}" escapes reposRoot (${root}); refusing to operate`,
      );
    }
    return dir;
  }
}

function mapPrState(raw: unknown): PrTerminalState {
  // `gh` returns OPEN / CLOSED / MERGED on `state`. We collapse CLOSED into
  // closed_unmerged here; `merged` is its own state and does not double as
  // closed.
  const s = String(raw ?? "").toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed_unmerged";
  return "open";
}

function mapMergeable(raw: unknown): PrMergeableState {
  const s = String(raw ?? "").toUpperCase();
  if (s === "MERGEABLE") return "mergeable";
  if (s === "CONFLICTING") return "conflicting";
  return "unknown";
}

function mapCheckRow(row: unknown): PrCheck {
  const r = (row ?? {}) as Record<string, unknown>;
  const bucket = mapBucket(r.bucket);
  // `gh` does not expose a `required` boolean per check on every workflow;
  // when invoked without `--required` we get all checks and treat each as
  // non-required by default. The `--required` filtering for the spec's
  // "no ci_workflow_name" path is handled by tick reading the named
  // workflow filter directly. This is consistent with the adapter contract.
  return {
    name: String(r.name ?? ""),
    workflow:
      r.workflow === null || r.workflow === undefined
        ? null
        : String(r.workflow),
    bucket,
    required: false,
  };
}

function mapBucket(raw: unknown): PrCheckBucket {
  const s = String(raw ?? "").toLowerCase();
  if (s === "pass") return "pass";
  if (s === "fail") return "fail";
  if (s === "pending") return "pending";
  if (s === "skipping") return "skipping";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
}

function extractLatestReview(parsed: Record<string, unknown>): PrLatestReview {
  const decision = mapReviewDecision(parsed.reviewDecision);
  const latest = Array.isArray(parsed.latestReviews)
    ? (parsed.latestReviews as Array<Record<string, unknown>>)
    : [];
  let latestReviewId: string | null = null;
  let comments = "";
  if (latest.length > 0) {
    // `gh` returns reviews ordered chronologically; pick the last
    // CHANGES_REQUESTED review when the decision says CHANGES_REQUESTED so
    // the dedupe key (`last_review_id_acted_on`) is stable.
    const wanted =
      decision === "CHANGES_REQUESTED"
        ? latest.filter(
            (r) => String(r.state ?? "").toUpperCase() === "CHANGES_REQUESTED",
          )
        : latest;
    const pick = wanted[wanted.length - 1] ?? null;
    if (pick) {
      latestReviewId = pick.id !== undefined ? String(pick.id) : null;
      comments = pick.body !== undefined ? String(pick.body) : "";
    }
  }
  return { decision, latestReviewId, comments };
}

function mapReviewDecision(raw: unknown): PrReviewDecision {
  const s = String(raw ?? "").toUpperCase();
  if (s === "APPROVED") return "APPROVED";
  if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  if (s === "COMMENTED") return "COMMENTED";
  return "NONE";
}

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

// `join` is exported so adapter contract tests can compute the bare-clone
// path without duplicating the convention.
export const _bareCloneSubpath = (repoId: string): string =>
  join(`${repoId}.git`);

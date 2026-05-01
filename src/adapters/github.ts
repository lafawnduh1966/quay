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
    // `prCheckStatus` is the convenience read that does not flow through the
    // tick-side `classifyCi` (which combines `ci_workflow_name` + required-
    // only filtering). To stay consistent with §5, restrict the decision
    // here to required checks only — same rule as the spec's fallback when
    // no `ci_workflow_name` is set. Callers that need named-workflow
    // semantics use `prSnapshot` + `classifyCi`.
    const checks = this.fetchChecks(repoId, branch);
    const required = checks.items.filter((c) => c.required);
    if (required.length === 0) return { state: "pending" };
    const anyFail = required.some(
      (c) => c.bucket === "fail" || c.bucket === "cancelled",
    );
    if (anyFail) {
      return checks.failureExcerpt !== undefined
        ? { state: "fail", excerpt: checks.failureExcerpt }
        : { state: "fail" };
    }
    const anyPending = required.some((c) => c.bucket === "pending");
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
    // Two passes: the unfiltered set drives the named-workflow rule (which
    // looks at every check matching `ci_workflow_name`), and the
    // `--required` filtered set tells us *which* of those checks count when
    // `ci_workflow_name` is unset and the spec falls back to required-only
    // status. Without this second call, every check would be marked
    // `required: false`, and the §5 rule "no required checks at all → pass"
    // would silently fire on repos with failing required CI.
    const result = this.run(repoId, [
      "gh",
      "pr",
      "checks",
      branch,
      "--json",
      fields,
    ]);
    // `gh pr checks` documents three significant exit codes (see
    // `gh pr checks --help`):
    //   0 — all checks passed.
    //   1 — at least one check failed.
    //   2 — gh CLI / runtime error (auth, network, malformed args, etc.).
    //   8 — checks are still pending.
    // Codes 0, 1, and 8 are *successful reads* — `gh` still wrote the JSON
    // checks array to stdout; the exit code only encodes the overall
    // verdict. We must parse the body in those cases. Anything else
    // (notably 2) is a hard failure and must throw so tick logs
    // `tick_error` rather than transitioning to done.
    const msg = `${result.stdout}\n${result.stderr}`.toLowerCase();
    // The "no checks at all" stderr signature can come back on any exit
    // code depending on `gh` version. Recognise it before the exit-code
    // branching so we don't confuse it with a hard failure.
    const isKnownNoChecks =
      msg.includes("no checks") || msg.includes("not found");
    if (isKnownNoChecks) return { checkSha: null, items: [] };
    const isReadSuccess =
      result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 8;
    if (!isReadSuccess) {
      throw new Error(
        `gh pr checks ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    // Empty stdout handling, by exit code:
    //   exit 0 (no checks at all) — legitimate empty-set; the §5 "no
    //         required checks → pass" rule is what's intended here.
    //   exit 1 (at least one check failed) — anomalous empty body
    //         (rate limit / transient error mapped to exit 1). Fail closed.
    //   exit 8 (checks pending) — empty body means "checks pending but no
    //         rows reported yet." That is NOT the same as "no checks";
    //         routing it to an empty items list would let classifyCi
    //         conclude pass under the spec §5 fallback. Fail closed by
    //         throwing — tick logs tick_error and retries on the next
    //         cycle, by which point gh should emit pending rows.
    if (result.stdout.trim() === "") {
      if (result.exitCode === 1) {
        throw new Error(
          `gh pr checks ${branch} exited 1 with empty body: ${result.stderr.trim() || "<no stderr>"}`,
        );
      }
      if (result.exitCode === 8) {
        throw new Error(
          `gh pr checks ${branch} exited 8 (pending) with empty body; cannot distinguish pending-no-rows from no-checks. Tick will retry next cycle.`,
        );
      }
      return { checkSha: null, items: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `gh pr checks returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) {
      // Fail closed: a non-array response from `gh pr checks` is not a
      // documented "no checks" signal, so we cannot safely conclude the PR
      // has zero checks. Surfacing this as a thrown error lets tick log
      // `tick_error` and skip the transition rather than approving by
      // default.
      throw new Error(
        `gh pr checks returned non-array JSON for ${branch}: ${result.stdout.slice(0, 200)}`,
      );
    }

    // Resolve required-check identity from a second `gh pr checks --required`
    // call. Match by (workflow, name) since `gh` does not expose a stable id.
    const requiredKeys = this.fetchRequiredCheckKeys(repoId, branch);
    const items: PrCheck[] = markRequired(
      parsed.map((row) => mapCheckRow(row)),
      requiredKeys,
    );
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

  private fetchRequiredCheckKeys(repoId: string, branch: string): Set<string> {
    const fields = ["workflow", "name"].join(",");
    const result = this.run(repoId, [
      "gh",
      "pr",
      "checks",
      branch,
      "--required",
      "--json",
      fields,
    ]);
    // Same exit-code semantics as fetchChecks: 0/1/8 are read-success
    // (the JSON body still describes the required-check set, just with a
    // different overall verdict). Anything else is a hard failure — fail
    // closed by throwing, so tick logs `tick_error` rather than letting
    // classifyCi see an empty required set and approve a failing PR.
    const msg = `${result.stdout}\n${result.stderr}`.toLowerCase();
    // Recognise the legitimate "no required checks" stderr signature
    // first — it's emitted on multiple non-zero exit codes across `gh`
    // versions and is the ONE empty-set path classifyCi is allowed to
    // see. Checked before the exit-code branching so it short-circuits
    // both the "unknown exit" and "exit 1 + empty body" fail-closed paths.
    const isKnownNoChecks =
      msg.includes("no checks") ||
      msg.includes("no check runs") ||
      msg.includes("no required checks") ||
      // `gh pr checks --required` with no required checks at all has
      // historically printed "no required checks reported on this branch"
      // / "no required checks reported"; cover the prefix too.
      msg.includes("no required");
    if (isKnownNoChecks) return new Set<string>();
    const isReadSuccess =
      result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 8;
    if (!isReadSuccess) {
      throw new Error(
        `gh pr checks --required ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    // Empty stdout handling, by exit code (mirrors fetchChecks):
    //   exit 0 — legitimate empty required-check set.
    //   exit 1 — anomalous (rate limit / transient mapped to exit 1).
    //            Fail closed; otherwise classifyCi would see "no required
    //            → pass" on a PR with failing required CI we couldn't read.
    //   exit 8 — pending with no rows yet. Cannot tell apart from
    //            "no required checks." Fail closed; tick retries.
    if (result.stdout.trim() === "") {
      if (result.exitCode === 1) {
        throw new Error(
          `gh pr checks --required ${branch} exited 1 with empty body: ${result.stderr.trim() || "<no stderr>"}`,
        );
      }
      if (result.exitCode === 8) {
        throw new Error(
          `gh pr checks --required ${branch} exited 8 (pending) with empty body; cannot distinguish pending-no-rows from no-required-checks. Tick will retry next cycle.`,
        );
      }
      return new Set<string>();
    }
    // Successful read but unparseable JSON is fail-closed: `gh` is supposed
    // to emit a JSON array, and a non-array means we cannot reason about
    // which checks are required.
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `gh pr checks --required returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `gh pr checks --required returned non-array JSON for ${branch}: ${result.stdout.slice(0, 200)}`,
      );
    }
    const keys = new Set<string>();
    for (const row of parsed) {
      const r = (row ?? {}) as Record<string, unknown>;
      const workflow =
        r.workflow === null || r.workflow === undefined
          ? ""
          : String(r.workflow);
      const name = String(r.name ?? "");
      keys.add(requiredKeyOf({ workflow: workflow === "" ? null : workflow, name }));
    }
    return keys;
  }

  private run(repoId: string, cmd: string[]): RunResult {
    const cwd = this.bareDir(repoId);
    // Forward `process.env` explicitly. Bun's `spawnSync` snapshots PATH at
    // process startup unless a caller passes `env`, so without this line a
    // test that stubs `gh` by mutating `process.env.PATH` at runtime would
    // be silently ignored — the real `gh` binary would still resolve.
    const result = Bun.spawnSync({
      cmd,
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
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

// Stable key for matching a check row across the two `gh pr checks` calls
// (unfiltered + `--required`). `gh` does not surface an opaque id, so we
// identify a check by `(workflow, name)`. The `\x1f` separator ensures the
// pair "workflow=foo, name=bar/baz" never collides with "workflow=foo/bar,
// name=baz" — Slack/GitHub display ambiguity that a plain space would
// preserve. Exported so the unit tests can exercise the join directly.
export function requiredKeyOf(c: { workflow: string | null; name: string }): string {
  return `${c.workflow ?? ""}\x1f${c.name}`;
}

// Walk the unfiltered check set and copy `required: true` onto items whose
// `(workflow, name)` matches an entry in `requiredKeys`. Pure and
// deterministic — exported for direct testing without a `gh` binary.
export function markRequired(items: PrCheck[], requiredKeys: Set<string>): PrCheck[] {
  return items.map((c) => ({ ...c, required: requiredKeys.has(requiredKeyOf(c)) }));
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

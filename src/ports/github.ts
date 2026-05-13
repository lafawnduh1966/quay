// GitHub operations used by core services. Real implementation lives under
// src/adapters/.
//
// `prExistsForBranch` is the spawn-time read: `gh pr view <branch>` exit 0 is
// "PR exists" (open or closed/merged). Tick uses this to snapshot
// `pr_existed_at_spawn` per attempt for the progress predicate.
//
// `prSnapshot` is the polling read used by tick for `pr-open` and `done`
// state handling: it returns enough to classify PR terminal state, merge
// conflicts, review feedback, and CI status from a single GitHub-side view.
// Real adapter composes this from `gh pr view --json ...` plus
// `gh pr checks --json ...`.
export interface GitHubPort {
  prExistsForBranch(repoId: string, branch: string): boolean;
  prCheckStatus(repoId: string, branch: string): PrCheckStatus;
  // Returns true iff a PR for the branch is currently open. Used by the cancel
  // finalizer to decide whether to retain the remote branch in the default
  // cleanup matrix.
  prIsOpen(repoId: string, branch: string): boolean;
  // Idempotent `gh pr close` for the named branch. Real adapter tolerates "PR
  // already closed" and "no PR for branch" without erroring.
  closePr(repoId: string, branch: string): void;
  // Polling read for `pr-open` / `done` handlers. Returns null when no PR is
  // associated with the branch (`gh pr view` exits non-zero). On API error,
  // the adapter throws — tick treats that as a transient failure and logs
  // `tick_error` for the task.
  prSnapshot(repoId: string, branch: string): PrSnapshot | null;
  // Same shape as `prSnapshot` but addresses the PR by its numeric id rather
  // than by branch ref. The `pr-review` terminal short-circuit uses this for
  // synthetic review tasks whose `branch_name` is the internal placeholder
  // `quay-review/<num>` — not a real GitHub ref — so a branch-keyed lookup
  // would always return null and miss external merges/closes.
  prSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null;
  prView(repoId: string, prNumber: number): PullRequestView | null;
  // `expectedLogin` overrides the adapter's auto-probed identity when the
  // reviewer worker posts under a different gh login than the tick process.
  // When omitted the adapter falls back to a cached `gh api user --jq .login`.
  fetchPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
    expectedLogin?: string,
  ): PostedReview | null;
}

export type PrCheckState = "pass" | "fail" | "pending";

export interface PrCheckStatus {
  state: PrCheckState;
  excerpt?: string;
}

export type PrTerminalState = "open" | "merged" | "closed_unmerged";

export type PrMergeableState = "mergeable" | "conflicting" | "unknown";

export type PrReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "NONE";

export type PrCheckBucket =
  | "pass"
  | "fail"
  | "pending"
  | "skipping"
  | "cancelled";

export interface PrCheck {
  name: string;
  workflow: string | null;
  bucket: PrCheckBucket;
  required: boolean;
}

export interface PrLatestReview {
  decision: PrReviewDecision;
  latestReviewId: string | null;
  comments: string;
}

export interface PrChecksReport {
  // SHA the checks were run against. May differ from PR's headSha when a
  // force-push happens between the head-ref read and the checks read; tick
  // detects that as stale and skips this cycle. `null` when no checks at all
  // have been recorded for the PR yet.
  checkSha: string | null;
  items: PrCheck[];
  // Optional preformatted excerpt summarising the failure. Real adapter
  // composes this from `gh run view --log-failed` at the moment of detection.
  failureExcerpt?: string;
}

export interface PrSnapshot {
  state: PrTerminalState;
  headSha: string;
  baseSha: string | null;
  // GitHub's numeric PR id and the human-readable PR URL. Optional because
  // many test fixtures predate PR-metadata writeback and a few `gh` failure
  // modes (rate-limit on the metadata fields, gh older than 2.20) can leave
  // them missing — tick treats absent values as "don't update".
  prNumber?: number | null;
  prUrl?: string | null;
  // The base branch name (`gh pr view --json baseRefName`). Captured so
  // callers that need the base ref for diffing can compute against it
  // without re-scraping. Optional for the same reason as prNumber/prUrl.
  baseRef?: string | null;
  // Current tip SHA of `origin/<baseRef>`, distinct from `baseSha` (which is
  // the merge-base — stable across base advances by design). Conflict-respawn
  // dedup keys on the *tip* so a base advance that may have worsened the
  // conflict can re-trigger a respawn even when head is unchanged. Optional:
  // if the local rev-parse fails (unfetched base) the field is absent and
  // the dedup key falls back to baseSha — preserving the prior fallback shape
  // without silently weakening the trigger when the tip is known.
  baseTipSha?: string | null;
  mergeable: PrMergeableState;
  latestReview: PrLatestReview;
  checks: PrChecksReport;
}

export interface PullRequestView {
  number: number;
  title: string;
  body: string;
  url: string | null;
  headRefName: string;
  headSha: string;
}

export interface PostedReview {
  reviewId: string;
  decision: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  comments: string;
}

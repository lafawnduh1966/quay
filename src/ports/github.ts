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
  mergeable: PrMergeableState;
  latestReview: PrLatestReview;
  checks: PrChecksReport;
}

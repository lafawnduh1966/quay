// Slice 3 GitHubPort. Real implementation lives under src/adapters/ in slice 10.
//
// Only the read used at promotion time is exposed here — `gh pr view <branch>`
// to snapshot whether a PR already exists for the branch (open or closed/merged).
// Returns true iff `gh pr view` would exit 0.
export interface GitHubPort {
  prExistsForBranch(repoId: string, branch: string): boolean;
  prCheckStatus(repoId: string, branch: string): PrCheckStatus;
  // Slice 7: returns true iff a PR for the branch is currently open. Used by
  // the cancel finalizer to decide whether to retain the remote branch in the
  // default cleanup matrix.
  prIsOpen(repoId: string, branch: string): boolean;
  // Slice 7: idempotent `gh pr close` for the named branch. Real adapter
  // tolerates "PR already closed" and "no PR for branch" without erroring.
  closePr(repoId: string, branch: string): void;
}

export type PrCheckState = "pass" | "fail" | "pending";

export interface PrCheckStatus {
  state: PrCheckState;
  excerpt?: string;
}

// Git operations used by core services. Real implementation lives under
// src/adapters/.
export interface GitPort {
  bareCloneExists(repoId: string): boolean;
  cloneBare(repoId: string, repoUrl: string): void;
  fetch(repoId: string, ref: string): void;
  // Like `fetch`, but tolerates "remote ref does not exist" — the natural case
  // for newly-enqueued tasks whose `quay/<slug>` branch hasn't been pushed
  // yet, and for spawn-window recoveries where the worker died before push.
  // Other failures (network, permissions, malformed args) still throw so
  // genuine breakage surfaces as a tick error.
  fetchBranchIfExists(repoId: string, branch: string): void;
  hasLocalBranch(repoId: string, branch: string): boolean;
  hasRemoteBranch(repoId: string, branch: string): boolean;
  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean;
  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void;
  worktreeDetach(worktreePath: string): void;
  worktreeRemove(worktreePath: string): void;
  branchDelete(repoId: string, branch: string): void;
  removeBareClone(repoId: string): void;
  // Returns the SHA at origin/<branch> in the bare clone after a fetch, or null
  // if the remote ref does not exist.
  remoteHeadSha(repoId: string, branch: string): string | null;
  // Idempotent `git push origin --delete <branch>`. Real adapter tolerates
  // "remote ref does not exist" and any other non-fatal error.
  deleteRemoteBranch(repoId: string, branch: string): void;
  // Final defense-in-depth gate after the JS slug normalizer (spec §13):
  // returns the input slug if `git check-ref-format refs/heads/quay/<slug>`
  // accepts it, otherwise returns `task-<taskIdShort>`.
  safeBranchSlug(slug: string, taskIdShort: string): string;
}

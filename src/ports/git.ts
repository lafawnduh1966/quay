// GitPort. Real implementation lives under src/adapters/ in slice 10.
export interface GitPort {
  bareCloneExists(repoId: string): boolean;
  cloneBare(repoId: string, repoUrl: string): void;
  fetch(repoId: string, ref: string): void;
  hasLocalBranch(repoId: string, branch: string): boolean;
  hasRemoteBranch(repoId: string, branch: string): boolean;
  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean;
  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void;
  worktreeRemove(worktreePath: string): void;
  branchDelete(repoId: string, branch: string): void;
  removeBareClone(repoId: string): void;
  // Slice 3: returns the SHA at origin/<branch> in the bare clone after a
  // fetch, or null if the remote ref does not exist.
  remoteHeadSha(repoId: string, branch: string): string | null;
  // Slice 7: idempotent `git push origin --delete <branch>`. Real adapter
  // tolerates "remote ref does not exist" and any other non-fatal error.
  deleteRemoteBranch(repoId: string, branch: string): void;
}

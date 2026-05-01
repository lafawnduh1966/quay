// Real Git adapter. Slice 10 step 5. Implements GitPort using local git
// against a configurable bare-clone root. The branch-slug final gate runs
// `git check-ref-format refs/heads/quay/<slug>` and falls back to
// `task-<id>` when the slug fails (spec §13).
import type { GitPort } from "../ports/git.ts";

export class LocalGitAdapter implements GitPort {
  constructor(private readonly _reposRoot: string) {}

  // Defense-in-depth: even though the JS slug normalizer already filters bad
  // characters, the adapter runs `git check-ref-format` as a final gate before
  // any branch op. If the slug fails the gate, fall back to `task-<id>`.
  safeBranchSlug(slug: string, taskIdShort: string): string {
    const fallback = `task-${taskIdShort}`;
    if (slug === "") return fallback;
    const probe = Bun.spawnSync({
      cmd: ["git", "check-ref-format", `refs/heads/quay/${slug}`],
      stdout: "ignore",
      stderr: "ignore",
    });
    return probe.exitCode === 0 ? slug : fallback;
  }

  bareCloneExists(_repoId: string): boolean {
    throw new Error("LocalGitAdapter.bareCloneExists not implemented yet");
  }
  cloneBare(_repoId: string, _repoUrl: string): void {
    throw new Error("LocalGitAdapter.cloneBare not implemented yet");
  }
  fetch(_repoId: string, _ref: string): void {
    throw new Error("LocalGitAdapter.fetch not implemented yet");
  }
  hasLocalBranch(_repoId: string, _branch: string): boolean {
    throw new Error("LocalGitAdapter.hasLocalBranch not implemented yet");
  }
  hasRemoteBranch(_repoId: string, _branch: string): boolean {
    throw new Error("LocalGitAdapter.hasRemoteBranch not implemented yet");
  }
  hasOpenPullRequestForBranch(_repoId: string, _branch: string): boolean {
    throw new Error(
      "LocalGitAdapter.hasOpenPullRequestForBranch not implemented yet",
    );
  }
  worktreeAdd(
    _repoId: string,
    _worktreePath: string,
    _branch: string,
    _baseRef: string,
  ): void {
    throw new Error("LocalGitAdapter.worktreeAdd not implemented yet");
  }
  worktreeDetach(_worktreePath: string): void {
    throw new Error("LocalGitAdapter.worktreeDetach not implemented yet");
  }
  worktreeRemove(_worktreePath: string): void {
    throw new Error("LocalGitAdapter.worktreeRemove not implemented yet");
  }
  branchDelete(_repoId: string, _branch: string): void {
    throw new Error("LocalGitAdapter.branchDelete not implemented yet");
  }
  removeBareClone(_repoId: string): void {
    throw new Error("LocalGitAdapter.removeBareClone not implemented yet");
  }
  remoteHeadSha(_repoId: string, _branch: string): string | null {
    throw new Error("LocalGitAdapter.remoteHeadSha not implemented yet");
  }
  deleteRemoteBranch(_repoId: string, _branch: string): void {
    throw new Error("LocalGitAdapter.deleteRemoteBranch not implemented yet");
  }
}

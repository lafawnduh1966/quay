import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitPort } from "../../../src/ports/git.ts";

export interface FakeGitCall {
  op: string;
  args: Record<string, unknown>;
}

export interface FakeGitFailures {
  cloneBare?: (repoId: string) => boolean;
  fetch?: (repoId: string, ref: string) => boolean;
  worktreeAdd?: (worktreePath: string) => boolean;
  branchDelete?: (branch: string) => boolean;
  worktreeRemove?: (worktreePath: string) => boolean;
}

export class FakeGit implements GitPort {
  readonly calls: FakeGitCall[] = [];
  readonly bareClones = new Set<string>();
  readonly localBranches = new Map<string, Set<string>>();
  readonly remoteBranches = new Map<string, Set<string>>();
  readonly openPrBranches = new Map<string, Set<string>>();
  readonly remoteHeads = new Map<string, string>(); // key = `${repoId}\0${branch}`
  readonly worktrees = new Set<string>();
  readonly reposRoot: string;
  fail: FakeGitFailures = {};

  constructor(reposRoot: string) {
    this.reposRoot = reposRoot;
  }

  private record(op: string, args: Record<string, unknown>): void {
    this.calls.push({ op, args });
  }

  private bareDir(repoId: string): string {
    return join(this.reposRoot, `${repoId}.git`);
  }

  bareCloneExists(repoId: string): boolean {
    return this.bareClones.has(repoId);
  }

  cloneBare(repoId: string, repoUrl: string): void {
    this.record("cloneBare", { repoId, repoUrl });
    if (this.fail.cloneBare?.(repoId)) {
      // Simulate a partial bare clone left on disk before the failure.
      mkdirSync(this.bareDir(repoId), { recursive: true });
      throw new Error(`fake: cloneBare failed for ${repoId}`);
    }
    mkdirSync(this.bareDir(repoId), { recursive: true });
    this.bareClones.add(repoId);
  }

  fetch(repoId: string, ref: string): void {
    this.record("fetch", { repoId, ref });
    if (this.fail.fetch?.(repoId, ref)) {
      throw new Error(`fake: fetch failed for ${repoId} ${ref}`);
    }
  }

  hasLocalBranch(repoId: string, branch: string): boolean {
    this.record("hasLocalBranch", { repoId, branch });
    return this.localBranches.get(repoId)?.has(branch) ?? false;
  }

  hasRemoteBranch(repoId: string, branch: string): boolean {
    this.record("hasRemoteBranch", { repoId, branch });
    return this.remoteBranches.get(repoId)?.has(branch) ?? false;
  }

  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean {
    this.record("hasOpenPullRequestForBranch", { repoId, branch });
    return this.openPrBranches.get(repoId)?.has(branch) ?? false;
  }

  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void {
    this.record("worktreeAdd", { repoId, worktreePath, branch, baseRef });
    if (this.fail.worktreeAdd?.(worktreePath)) {
      throw new Error(`fake: worktreeAdd failed for ${worktreePath}`);
    }
    mkdirSync(worktreePath, { recursive: true });
    this.worktrees.add(worktreePath);
    let set = this.localBranches.get(repoId);
    if (!set) {
      set = new Set<string>();
      this.localBranches.set(repoId, set);
    }
    set.add(branch);
  }

  worktreeRemove(worktreePath: string): void {
    this.record("worktreeRemove", { worktreePath });
    if (this.fail.worktreeRemove?.(worktreePath)) {
      throw new Error(`fake: worktreeRemove failed for ${worktreePath}`);
    }
    rmSync(worktreePath, { recursive: true, force: true });
    this.worktrees.delete(worktreePath);
  }

  branchDelete(repoId: string, branch: string): void {
    this.record("branchDelete", { repoId, branch });
    if (this.fail.branchDelete?.(branch)) {
      throw new Error(`fake: branchDelete failed for ${branch}`);
    }
    this.localBranches.get(repoId)?.delete(branch);
  }

  deleteRemoteBranch(repoId: string, branch: string): void {
    this.record("deleteRemoteBranch", { repoId, branch });
    // Idempotent — missing remote ref is not an error.
    this.remoteBranches.get(repoId)?.delete(branch);
  }

  removeBareClone(repoId: string): void {
    this.record("removeBareClone", { repoId });
    rmSync(this.bareDir(repoId), { recursive: true, force: true });
    this.bareClones.delete(repoId);
  }

  remoteHeadSha(repoId: string, branch: string): string | null {
    this.record("remoteHeadSha", { repoId, branch });
    return this.remoteHeads.get(`${repoId}\0${branch}`) ?? null;
  }

  setRemoteHeadSha(repoId: string, branch: string, sha: string | null): void {
    const key = `${repoId}\0${branch}`;
    if (sha === null) {
      this.remoteHeads.delete(key);
    } else {
      this.remoteHeads.set(key, sha);
    }
  }

  // Helpers for test setup.
  setLocalBranches(repoId: string, branches: string[]): void {
    this.localBranches.set(repoId, new Set(branches));
  }
  setRemoteBranches(repoId: string, branches: string[]): void {
    this.remoteBranches.set(repoId, new Set(branches));
  }
  setOpenPrBranches(repoId: string, branches: string[]): void {
    this.openPrBranches.set(repoId, new Set(branches));
  }
  seedBareClone(repoId: string): void {
    mkdirSync(this.bareDir(repoId), { recursive: true });
    this.bareClones.add(repoId);
  }
  countCalls(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

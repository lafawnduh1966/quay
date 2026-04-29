import type {
  GitHubPort,
  PrCheckStatus,
  PrSnapshot,
} from "../../../src/ports/github.ts";

export class FakeGitHub implements GitHubPort {
  readonly calls: { repoId: string; branch: string }[] = [];
  readonly closePrCalls: { repoId: string; branch: string }[] = [];
  readonly prExisting = new Map<string, boolean>(); // key = `${repoId}\0${branch}`
  readonly prOpen = new Map<string, boolean>();
  readonly checkStatuses = new Map<string, PrCheckStatus>();
  // Explicit per-(repo, branch) PR snapshots take precedence over the legacy
  // `setPrCheckStatus`-derived synthesis.
  readonly snapshots = new Map<string, PrSnapshot | null>();

  prExistsForBranch(repoId: string, branch: string): boolean {
    this.calls.push({ repoId, branch });
    return this.prExisting.get(`${repoId}\0${branch}`) ?? false;
  }

  setPrExists(repoId: string, branch: string, exists: boolean): void {
    this.prExisting.set(`${repoId}\0${branch}`, exists);
  }

  prCheckStatus(repoId: string, branch: string): PrCheckStatus {
    return this.checkStatuses.get(`${repoId}\0${branch}`) ?? { state: "pending" };
  }

  setPrCheckStatus(repoId: string, branch: string, status: PrCheckStatus): void {
    this.checkStatuses.set(`${repoId}\0${branch}`, status);
  }

  prIsOpen(repoId: string, branch: string): boolean {
    return this.prOpen.get(`${repoId}\0${branch}`) ?? false;
  }

  setPrIsOpen(repoId: string, branch: string, open: boolean): void {
    this.prOpen.set(`${repoId}\0${branch}`, open);
  }

  closePr(repoId: string, branch: string): void {
    this.closePrCalls.push({ repoId, branch });
    // Idempotent: closing a non-existent or already-closed PR succeeds.
    this.prOpen.set(`${repoId}\0${branch}`, false);
  }

  prSnapshot(repoId: string, branch: string): PrSnapshot | null {
    const key = `${repoId}\0${branch}`;
    if (this.snapshots.has(key)) return this.snapshots.get(key) ?? null;
    const cs = this.checkStatuses.get(key);
    if (cs !== undefined) return synthesizeSnapshotFromCheckStatus(cs);
    return null;
  }

  setPrSnapshot(repoId: string, branch: string, snapshot: PrSnapshot | null): void {
    this.snapshots.set(`${repoId}\0${branch}`, snapshot);
  }
}

function synthesizeSnapshotFromCheckStatus(s: PrCheckStatus): PrSnapshot {
  const bucket = s.state;
  const checks: PrSnapshot["checks"] = {
    checkSha: "fake-head",
    items: [{ name: "build", workflow: null, bucket, required: true }],
  };
  if (s.excerpt !== undefined) checks.failureExcerpt = s.excerpt;
  return {
    state: "open",
    headSha: "fake-head",
    baseSha: "fake-base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks,
  };
}

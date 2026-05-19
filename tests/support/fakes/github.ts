import type {
  GitHubPort,
  OpenBranchPr,
  PostedReview,
  PrCheckStatus,
  PrSnapshot,
  PullRequestView,
} from "../../../src/ports/github.ts";

export class FakeGitHub implements GitHubPort {
  readonly calls: { repoId: string; branch: string }[] = [];
  readonly closePrCalls: { repoId: string; branch: string }[] = [];
  readonly prExisting = new Map<string, boolean>(); // key = `${repoId}\0${branch}`
  readonly openPrsByBranchBase = new Map<string, OpenBranchPr[]>();
  readonly prOpen = new Map<string, boolean>();
  readonly checkStatuses = new Map<string, PrCheckStatus>();
  // Explicit per-(repo, branch) PR snapshots take precedence over the legacy
  // `setPrCheckStatus`-derived synthesis.
  readonly snapshots = new Map<string, PrSnapshot | null>();
  readonly snapshotsByNumber = new Map<string, PrSnapshot | null>();
  readonly prViews = new Map<string, PullRequestView | null>();
  readonly postedReviews = new Map<string, PostedReview | null>();
  readonly tokenAccessCalls: { repoId: string; token: string }[] = [];
  private tokenAccessHandler: (repoId: string, token: string) => void = () => {};

  prExistsForBranch(repoId: string, branch: string): boolean {
    this.calls.push({ repoId, branch });
    return this.prExisting.get(`${repoId}\0${branch}`) ?? false;
  }

  setPrExists(repoId: string, branch: string, exists: boolean): void {
    this.prExisting.set(`${repoId}\0${branch}`, exists);
  }

  openPrsForBranchBase(
    repoId: string,
    branch: string,
    baseBranch: string,
  ): OpenBranchPr[] {
    return [
      ...(this.openPrsByBranchBase.get(`${repoId}\0${branch}\0${baseBranch}`) ?? []),
    ];
  }

  setOpenPrsForBranchBase(
    repoId: string,
    branch: string,
    baseBranch: string,
    prs: OpenBranchPr[],
  ): void {
    this.openPrsByBranchBase.set(`${repoId}\0${branch}\0${baseBranch}`, [...prs]);
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

  prSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null {
    const key = `${repoId}\0${prNumber}`;
    return this.snapshotsByNumber.get(key) ?? null;
  }

  setPrSnapshotByNumber(
    repoId: string,
    prNumber: number,
    snapshot: PrSnapshot | null,
  ): void {
    this.snapshotsByNumber.set(`${repoId}\0${prNumber}`, snapshot);
  }

  prView(repoId: string, prNumber: number): PullRequestView | null {
    return this.prViews.get(`${repoId}\0${prNumber}`) ?? null;
  }

  setPrView(repoId: string, prNumber: number, view: PullRequestView | null): void {
    this.prViews.set(`${repoId}\0${prNumber}`, view);
  }

  fetchPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
  ): PostedReview | null {
    return this.postedReviews.get(`${repoId}\0${prNumber}\0${headSha}`) ?? null;
  }

  setPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
    review: PostedReview | null,
  ): void {
    this.postedReviews.set(`${repoId}\0${prNumber}\0${headSha}`, review);
  }

  probeTokenAccess(repoId: string, token: string): void {
    this.tokenAccessCalls.push({ repoId, token });
    this.tokenAccessHandler(repoId, token);
  }

  setTokenAccessHandler(handler: (repoId: string, token: string) => void): void {
    this.tokenAccessHandler = handler;
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
    prNumber: null,
    state: "open",
    headSha: "fake-head",
    baseSha: "fake-base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks,
  };
}

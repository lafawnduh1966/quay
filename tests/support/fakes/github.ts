import type { GitHubPort, PrCheckStatus } from "../../../src/ports/github.ts";

export class FakeGitHub implements GitHubPort {
  readonly calls: { repoId: string; branch: string }[] = [];
  readonly closePrCalls: { repoId: string; branch: string }[] = [];
  readonly prExisting = new Map<string, boolean>(); // key = `${repoId}\0${branch}`
  readonly prOpen = new Map<string, boolean>();
  readonly checkStatuses = new Map<string, PrCheckStatus>();

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
}

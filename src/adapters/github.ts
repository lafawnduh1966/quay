// Real GitHub adapter (stub). Contract tests for this adapter are gated
// behind QUAY_INTEGRATION_TESTS=1 and skipped by default; real `gh` shell-out
// implementations land alongside the integration suite.
import type {
  GitHubPort,
  PrCheckStatus,
  PrSnapshot,
} from "../ports/github.ts";

export class GitHubCliAdapter implements GitHubPort {
  prExistsForBranch(_repoId: string, _branch: string): boolean {
    throw new Error("GitHubCliAdapter.prExistsForBranch not implemented yet");
  }
  prCheckStatus(_repoId: string, _branch: string): PrCheckStatus {
    throw new Error("GitHubCliAdapter.prCheckStatus not implemented yet");
  }
  prIsOpen(_repoId: string, _branch: string): boolean {
    throw new Error("GitHubCliAdapter.prIsOpen not implemented yet");
  }
  closePr(_repoId: string, _branch: string): void {
    throw new Error("GitHubCliAdapter.closePr not implemented yet");
  }
  prSnapshot(_repoId: string, _branch: string): PrSnapshot | null {
    throw new Error("GitHubCliAdapter.prSnapshot not implemented yet");
  }
}

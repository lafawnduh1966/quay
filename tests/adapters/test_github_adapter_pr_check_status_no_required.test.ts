// Regression: `prCheckStatus` is the convenience read for callers that want
// a single PR's required-only CI verdict without going through the tick-side
// `classifyCi`. Spec §5 says "no required checks at all → pass" — repos with
// no required-check configuration don't gate on CI. The adapter previously
// returned `pending` for an empty required set, which would strand any
// caller polling on `prCheckStatus` for those repos. Pin the §5 behavior.
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { GitHubCliAdapter } from "../../src/adapters/github.ts";

let cleanups: Array<() => void> = [];
let savedPath: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-gh-noreq-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function installGhStub(body: string): void {
  const bin = tempDir();
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function makeBareDir(): { reposRoot: string; repoId: string } {
  const reposRoot = tempDir("quay-gh-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

test("prCheckStatus returns pass when no required checks are configured", () => {
  // Two passing non-required checks in the unfiltered set, an empty
  // `--required` array. The §5 fallback applies: the repo doesn't gate on
  // CI, so prCheckStatus must report pass — not pending.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"pass","workflow":"ci","name":"lint","state":"SUCCESS"},{"bucket":"pass","workflow":"ci","name":"build","state":"SUCCESS"}]'
    exit 0
    ;;
  *"view"*)
    echo '{"state":"OPEN","headRefOid":"abc","baseRefOid":"def","mergeable":"MERGEABLE","reviewDecision":"NONE","latestReviews":[]}'
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const status = adapter.prCheckStatus(repoId, "quay/branch");
  expect(status.state).toBe("pass");
});

test("prCheckStatus returns pass on a repo with no checks at all", () => {
  // The "no checks reported on this PR" branch: gh emits an empty array on
  // the unfiltered call, and a "no checks" hint on the required call. With
  // an empty unfiltered set the required filter is also empty — same §5
  // fallback applies.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo 'no checks reported on this branch' 1>&2
    exit 1
    ;;
  *"checks"*)
    echo 'no checks reported on this branch' 1>&2
    exit 1
    ;;
  *"view"*)
    echo '{"state":"OPEN","headRefOid":"abc","baseRefOid":"def","mergeable":"MERGEABLE","reviewDecision":"NONE","latestReviews":[]}'
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const status = adapter.prCheckStatus(repoId, "quay/branch");
  expect(status.state).toBe("pass");
});

// Regression: `fetchChecks` previously matched any stderr containing the
// substring "not found" as the spec's "no checks configured" signal. That
// swallowed unrelated failures — most importantly GitHub's GraphQL 404
// "Could not resolve to a PullRequest with the number ... Not Found" from
// auth / wrong-repo / discovery problems — and routed them to an empty
// check set. For repos without `ci_workflow_name`, an empty required set
// classifies as `pass`, so a genuine API failure would silently transition
// a PR to `done`.
//
// The new matcher restricts the no-checks path to check-scoped phrasings
// ("no checks", "no check runs", "no required checks"). A bare GraphQL
// "Not Found" must surface as a thrown error → tick_error, not pass.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GitHubCliAdapter } from "../../src/adapters/github.ts";
import { classifyCi } from "../../src/core/ci_status.ts";

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

function tempDir(prefix = "quay-gh-notfound-"): string {
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

test("graphql 'Not Found' from gh pr checks does NOT silently become an empty check set", () => {
  // Stub gh: the PR view succeeds (so prSnapshot proceeds to fetch
  // checks), then `gh pr checks` fails with a generic GraphQL 404 — the
  // exact failure mode that masquerades as a "no checks" signal under a
  // bare "not found" matcher.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo 'GraphQL: Could not resolve to a PullRequest with the number 17. (repository.pullRequest) Not Found' 1>&2
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

  // Must throw — the snapshot path that drives CI decisions has to
  // surface this so tick logs tick_error rather than approving the PR.
  expect(() => adapter.prSnapshot(repoId, "quay/branch")).toThrow(
    /could not resolve|not found|gh pr checks/i,
  );
});

test("legitimate 'no checks reported' stderr still maps to an empty (pass-eligible) check set", () => {
  // The other side of the contract: real "no checks configured" stderr
  // must NOT regress to fail-closed. We pin the legitimate paths with
  // the same shaped fixture used by the existing required-check tests.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo 'no required checks reported on this branch' 1>&2
    exit 1
    ;;
  *"checks"*)
    echo 'no checks reported on the main branch' 1>&2
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
  const snap = adapter.prSnapshot(repoId, "quay/branch");
  expect(snap).not.toBeNull();
  expect(snap!.checks.items).toEqual([]);
  // Spec §5: with no required checks, classifyCi resolves to pass.
  expect(classifyCi(snap!, null)).toBe("pass");
});

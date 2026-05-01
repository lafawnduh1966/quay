// Regression: `gh pr checks --required` failures (auth, CLI version, API
// outage, rate limit, malformed output) must NOT degrade to "no required
// checks". If they did, classifyCi would see an empty required set and
// silently approve a PR while required CI was actually failing.
//
// Setup: shadow the real `gh` binary by putting a stub script on PATH ahead
// of `/usr/local/bin/gh`. The stub branches on argv to simulate each
// failure mode, then we call the real adapter and assert that
// `prSnapshot()` (or `prCheckStatus()`) throws rather than returning a
// pass-flavored result.

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

function tempDir(prefix = "quay-gh-stub-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// Build a stub `gh` script + a stub `git` shim (so `bareDir`-side ops don't
// touch a real bare clone). Returns the directory containing the binaries.
// Body is a POSIX-shell snippet that reads `$@` and writes stdout/exit code.
function installGhStub(body: string): string {
  const bin = tempDir();
  const script = `#!/bin/sh\n${body}\n`;
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  // Prepend to PATH so the stub wins.
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return bin;
}

// A real on-disk bare clone is required because GitHubCliAdapter's `run`
// uses cwd = <reposRoot>/<repoId>.git. We stub-create the directory; `gh`
// is shadowed and never touches git.
function makeBareDir(): { reposRoot: string; repoId: string } {
  const reposRoot = tempDir("quay-gh-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

test("fetchRequiredCheckKeys throws on auth failure (gh exits 4 with 'authentication required')", () => {
  installGhStub(`
case "$*" in
  *"--required"*)
    echo 'gh: authentication required to fetch checks' 1>&2
    exit 4
    ;;
  *"checks"*)
    # First (unfiltered) checks call succeeds with a failing required check.
    echo '[{"bucket":"fail","workflow":"ci","name":"test","state":"FAILURE"}]'
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

  // The whole snapshot path — the one tick uses to drive CI decisions —
  // must throw so tick logs tick_error rather than transitioning to done.
  expect(() => adapter.prSnapshot(repoId, "quay/some-branch")).toThrow(
    /authentication required|--required.*failed/i,
  );
  expect(() => adapter.prCheckStatus(repoId, "quay/some-branch")).toThrow(
    /authentication required|--required.*failed/i,
  );
});

test("fetchRequiredCheckKeys throws on rate limit (gh exits 1 with 'API rate limit exceeded')", () => {
  installGhStub(`
case "$*" in
  *"--required"*)
    echo 'API rate limit exceeded for user ID 1234' 1>&2
    exit 1
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"ci","name":"test","state":"FAILURE"}]'
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
  expect(() => adapter.prSnapshot(repoId, "quay/branch")).toThrow(/rate limit|--required.*failed/i);
});

test("fetchRequiredCheckKeys throws on malformed JSON (gh exits 0 with garbage stdout)", () => {
  installGhStub(`
case "$*" in
  *"--required"*)
    # Successful exit but not a JSON array — could be a CLI version-skew
    # response, an HTML error page, or noise.
    echo 'not-json'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"ci","name":"test","state":"FAILURE"}]'
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
  expect(() => adapter.prSnapshot(repoId, "quay/branch")).toThrow(
    /unparseable JSON|--required/i,
  );
});

test("fetchRequiredCheckKeys throws on non-array JSON (gh exits 0 with an object)", () => {
  installGhStub(`
case "$*" in
  *"--required"*)
    echo '{"unexpected":"object"}'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"ci","name":"test","state":"FAILURE"}]'
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
  expect(() => adapter.prSnapshot(repoId, "quay/branch")).toThrow(
    /non-array JSON|--required/i,
  );
});

test("fetchRequiredCheckKeys returns empty (no throw) when gh reports 'no required checks'", () => {
  // The single legitimate "empty required set" path: gh exits non-zero with
  // a stderr message that explicitly says no required checks. The spec §5
  // rule "no required checks → pass" applies here, and only here.
  installGhStub(`
case "$*" in
  *"--required"*)
    echo 'no required checks reported on this branch' 1>&2
    exit 1
    ;;
  *"checks"*)
    echo '[{"bucket":"pass","workflow":"ci","name":"lint","state":"SUCCESS"}]'
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
  // Should not throw — and the snapshot's checks should carry required:false
  // for every item, matching the "no required checks → pass" intent.
  const snap = adapter.prSnapshot(repoId, "quay/branch");
  expect(snap).not.toBeNull();
  expect(snap!.checks.items.every((c) => !c.required)).toBe(true);
});

test("fetchChecks throws on non-array JSON (regression: was silently empty)", () => {
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    # Unfiltered checks returns a malformed object instead of an array.
    echo '{"unexpected":true}'
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
  expect(() => adapter.prSnapshot(repoId, "quay/branch")).toThrow(
    /non-array JSON|gh pr checks/i,
  );
});

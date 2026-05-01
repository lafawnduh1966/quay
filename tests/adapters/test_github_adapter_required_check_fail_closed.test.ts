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

test("fetchChecks throws on gh exit 8 with empty body (cannot distinguish pending from no-checks)", () => {
  // Regression: an exit-8 response with no JSON rows is gh saying "checks
  // are pending but none have reported yet". Returning {items: []} would
  // let classifyCi's §5 fallback ("no required checks → pass") approve
  // a task whose CI is still running. Must fail closed so tick retries.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    # Empty body, exit 8.
    exit 8
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
    /exited 8 \(pending\) with empty body|gh pr checks/i,
  );
});

test("fetchRequiredCheckKeys throws on gh exit 8 with empty body", () => {
  // Same regression for the required-check pass: an empty body on exit 8
  // would otherwise return an empty required set, which classifyCi reads
  // as pass — silently approving a PR with pending CI.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    exit 8
    ;;
  *"checks"*)
    echo '[{"bucket":"pending","workflow":"ci","name":"test","state":"IN_PROGRESS"}]'
    exit 8
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
    /exited 8 \(pending\) with empty body|gh pr checks --required/i,
  );
});

test("fetchChecks treats gh exit 8 (checks pending) as a successful read, not a hard error", () => {
  // Regression: previously any non-zero exit from `gh pr checks` was
  // treated as fatal (or as "no checks" only if stderr happened to say
  // so). But `gh pr checks --help` documents exit 8 as "Checks pending"
  // — a normal pending CI run. Logging `tick_error` for every pending PR
  // would defeat the §5 polling loop, which is built around classifying
  // pending rows. The adapter must parse the body and return the rows.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"pending","workflow":"ci","name":"test","state":"IN_PROGRESS"}]'
    exit 8
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
  expect(snap!.checks.items).toHaveLength(1);
  expect(snap!.checks.items[0]!.bucket).toBe("pending");
});

test("fetchChecks treats gh exit 1 (some check failed) as a successful read", () => {
  // Same rationale as exit 8: exit 1 means "at least one check failed";
  // `gh` still emits the JSON body. Without parsing it, tick can't tell a
  // failing check from a hard error.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    # Required-checks call returns the failing required check.
    echo '[{"workflow":"ci","name":"test"}]'
    exit 1
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"ci","name":"test","state":"FAILURE"}]'
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
  expect(snap!.checks.items).toHaveLength(1);
  expect(snap!.checks.items[0]!.bucket).toBe("fail");
  // The required-check pass was also exit 1, but its body was a real JSON
  // array. The adapter must have parsed it and marked the matching item.
  expect(snap!.checks.items[0]!.required).toBe(true);
});

test("fetchChecks throws on gh exit 2 (CLI/runtime error)", () => {
  // Exit 2 is the documented "gh CLI / runtime error" code — auth, network,
  // malformed args. There is no JSON body to trust; throw so tick logs
  // tick_error.
  installGhStub(`
case "$*" in
  *"checks"*)
    echo 'gh: could not connect to github.com' 1>&2
    exit 2
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
    /could not connect|gh pr checks/i,
  );
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

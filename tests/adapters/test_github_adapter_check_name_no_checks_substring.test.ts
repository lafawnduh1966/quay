// Regression: `fetchChecks` and `fetchRequiredCheckKeys` used to short-
// circuit to an empty check set whenever the *combined* stdout+stderr
// contained "no checks" / "no check runs" / "no required checks". A
// valid JSON checks array with a workflow or check name like
// "No checks required" would therefore false-match — and with
// `ci_workflow_name` unset, `classifyCi` treats an empty required set
// as `pass`, so a failing required check could silently transition the
// task to done.
//
// The fix parses non-empty stdout as JSON FIRST. The "no checks"
// matcher only fires against stderr (or against stdout when stdout
// failed to parse as JSON). A successfully-parsed JSON array always
// drives the outcome, regardless of any substring inside it.

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

function tempDir(prefix = "quay-gh-checkname-"): string {
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

test("a check whose name contains 'no checks' does NOT bypass the JSON parse", () => {
  // Failing required check whose name literally embeds "no checks
  // required". The combined-stdout+stderr matcher would have fired and
  // returned an empty set, then classifyCi → pass; the JSON-first path
  // must use the parsed array and propagate `bucket: fail` instead.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[{"workflow":"ci","name":"No checks required (legacy gate)"}]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"ci","name":"No checks required (legacy gate)","state":"FAILURE"}]'
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
  // Parsed body wins: the failing required check is preserved.
  expect(snap!.checks.items).toHaveLength(1);
  expect(snap!.checks.items[0]!.bucket).toBe("fail");
  expect(snap!.checks.items[0]!.required).toBe(true);
  expect(snap!.checks.items[0]!.name).toBe("No checks required (legacy gate)");
  // classifyCi must return fail — without the fix this is silently pass.
  expect(classifyCi(snap!, null)).toBe("fail");
});

test("a workflow named 'no check runs' does NOT bypass the JSON parse", () => {
  // Same regression for the other phrase variants.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[{"workflow":"no check runs","name":"verify"}]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"no check runs","name":"verify","state":"FAILURE"}]'
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
  expect(snap!.checks.items[0]!.bucket).toBe("fail");
  expect(snap!.checks.items[0]!.required).toBe(true);
  expect(classifyCi(snap!, null)).toBe("fail");
});

test("legitimate stderr 'no checks reported' message still maps to an empty set", () => {
  // The other side of the contract: real "no checks configured" must
  // not regress to fail-closed when stderr carries the canonical message.
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
  expect(classifyCi(snap!, null)).toBe("pass");
});

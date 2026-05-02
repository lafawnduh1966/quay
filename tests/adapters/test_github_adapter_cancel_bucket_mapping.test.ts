// Regression: `gh pr checks --json bucket` reports cancelled checks with the
// literal value "cancel" (its own bucket vocabulary) — not "cancelled" or
// "canceled". The adapter previously only recognised the latter two and
// silently fell through to `pending` for the first, leaving any task whose
// CI was actually cancelled stuck as `ci_pending` forever instead of
// scheduling the CI-fail retry.
//
// We pin the regression by feeding the bucket strings through `mapCheckRow`
// (the row mapper that wraps `mapBucket`), then driving the result through
// the same `classifySet` that tick uses — a cancelled REQUIRED check must
// resolve to "fail".
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
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

function tempDir(prefix = "quay-gh-cancel-"): string {
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

test("cancelled bucket as gh's literal 'cancel' is mapped to cancelled (not pending)", () => {
  // gh emits "cancel" as the bucket on a cancelled check. The unfiltered
  // call returns one cancelled required check; the --required pass marks
  // it required so classifyCi must treat it as fail.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[{"workflow":"ci","name":"test"}]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"cancel","workflow":"ci","name":"test","state":"COMPLETED"}]'
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
  // The mapping must turn "cancel" into the typed "cancelled" bucket so
  // ci_status / classifySet treats a cancelled required check as fail.
  expect(snap!.checks.items[0]!.bucket).toBe("cancelled");
  expect(snap!.checks.items[0]!.required).toBe(true);
  expect(classifyCi(snap!, null)).toBe("fail");
});

test("convenience prCheckStatus also fails on cancelled required check", () => {
  // The shorthand path (`prCheckStatus`) was the original site flagged in
  // review — same regression must hold there.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[{"workflow":"ci","name":"test"}]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"cancel","workflow":"ci","name":"test","state":"COMPLETED"}]'
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
  expect(status.state).toBe("fail");
});

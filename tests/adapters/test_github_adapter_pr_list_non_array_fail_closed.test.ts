// Regression: `gh pr list --json number` is contractually an array. If gh
// ever emits a non-array body on exit 0 (CLI version skew, server error
// surfaced via stdout, malformed shim), the adapter must NOT silently
// coerce that to "no PR." Doing so would:
//
//   - make `prExistsForBranch()` return false → cancel deletes a remote
//     branch that should be retained for an open PR (spec §12);
//   - make `prIsOpen()` return false → enqueue skips the open-PR
//     collision check on retry.
//
// `prCheckStatus` (gh pr checks) already fails closed on the same shape;
// this test pins the same posture for the pr-list helpers.

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

function tempDir(prefix = "quay-gh-prlist-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// Stub `gh` so any `pr list` invocation returns the configured body.
// `gh` is shadowed by prepending the stub directory to PATH.
function installGhStub(body: string): { reposRoot: string; repoId: string } {
  const bin = tempDir();
  const script = `#!/bin/sh\n${body}\n`;
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  const reposRoot = tempDir("quay-gh-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

test("prExistsForBranch throws on exit-0 non-array body (e.g. {})", () => {
  const { reposRoot, repoId } = installGhStub(`
echo '{}'
exit 0
`);
  const adapter = new GitHubCliAdapter(reposRoot);

  let caught: unknown = null;
  try {
    adapter.prExistsForBranch(repoId, "quay/feat");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/non-array JSON/);
  expect((caught as Error).message).toMatch(/quay\/feat/);
});

test("prIsOpen throws on exit-0 non-array body (e.g. null)", () => {
  const { reposRoot, repoId } = installGhStub(`
echo 'null'
exit 0
`);
  const adapter = new GitHubCliAdapter(reposRoot);

  let caught: unknown = null;
  try {
    adapter.prIsOpen(repoId, "quay/feat");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/non-array JSON/);
});

test("prExistsForBranch still accepts a valid empty array (false)", () => {
  // Sanity guard: the new strict check must not break the legitimate
  // "no PRs at all" gh response. Exit 0 with `[]` continues to mean
  // "no PR found for this branch."
  const { reposRoot, repoId } = installGhStub(`
echo '[]'
exit 0
`);
  const adapter = new GitHubCliAdapter(reposRoot);

  expect(adapter.prExistsForBranch(repoId, "quay/feat")).toBe(false);
});

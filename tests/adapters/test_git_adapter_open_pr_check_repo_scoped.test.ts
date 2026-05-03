// Spec §12 collision check, third leg: `gh pr list --head <branch> --state
// open` must run against the right repo. Two regressions this test guards:
//
//   1. The previous adapter ran `gh` without a `cwd`, so it inspected
//      whatever repo the operator's shell happened to be in (or none). An
//      enqueue could then reuse a branch that has an open PR on the actual
//      target — the local + remote checks would not catch the
//      remote-deleted-on-merge case.
//
//   2. The previous adapter swallowed every gh failure into "no open PR." A
//      transient API error or auth misconfig silently bypassed the spec's
//      collision check.
//
// We exercise the real adapter by shimming `gh` on PATH with a small shell
// script that records its working directory and then exits with a
// configurable code. No real `gh` binary or network is involved.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { LocalGitAdapter } from "../../src/adapters/git.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
  if (originalPath !== null) {
    process.env.PATH = originalPath;
    originalPath = null;
  }
});

let originalPath: string | null = null;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-gh-shim-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface ShimSetup {
  reposRoot: string;
  bareDir: string;
  pwdFile: string;
  argsFile: string;
}

// Drop a `gh` shim onto a fresh PATH-front directory. The shim writes its
// cwd and argv to two files we can read back, then exits with the requested
// code and stdout.
function setupGhShim(opts: { exitCode: number; stdout: string; stderr?: string }): ShimSetup {
  const reposRoot = tempDir();
  const repoId = "scoped-repo";
  const bareDir = join(reposRoot, `${repoId}.git`);
  mkdirSync(bareDir, { recursive: true });

  const shimDir = tempDir();
  const ghPath = join(shimDir, "gh");
  const pwdFile = join(shimDir, "shim-pwd.txt");
  const argsFile = join(shimDir, "shim-args.txt");
  const stderrFile = join(shimDir, "shim-stderr.txt");
  writeFileSync(stderrFile, opts.stderr ?? "");
  // Heredoc body avoids shell-quoting hell on the JSON stdout.
  const stdoutFile = join(shimDir, "shim-stdout.txt");
  writeFileSync(stdoutFile, opts.stdout);
  const script = `#!/bin/sh
pwd > "${pwdFile}"
echo "$@" > "${argsFile}"
cat "${stdoutFile}"
cat "${stderrFile}" 1>&2
exit ${opts.exitCode}
`;
  writeFileSync(ghPath, script);
  chmodSync(ghPath, 0o755);

  if (originalPath === null) originalPath = process.env.PATH ?? "";
  process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
  return { reposRoot, bareDir, pwdFile, argsFile };
}

test("hasOpenPullRequestForBranch runs gh from inside the bare clone for the named repo", () => {
  // gh exits 0 with [] (no open PRs). The shim records its cwd; we assert
  // the cwd is the bare clone for `scoped-repo`, not the test's cwd.
  const shim = setupGhShim({ exitCode: 0, stdout: "[]\n" });
  const adapter = new LocalGitAdapter(shim.reposRoot);

  const result = adapter.hasOpenPullRequestForBranch("scoped-repo", "quay/feat");

  expect(result).toBe(false);
  const recordedCwd = readFileSync(shim.pwdFile, "utf8").trim();
  // macOS routes /tmp through /private/tmp; canonicalize via realpath.
  // We just check that the recorded path ends with the expected suffix.
  expect(recordedCwd.endsWith("scoped-repo.git")).toBe(true);
  // And that it's NOT the test process's cwd (which would mean we ran
  // against the wrong repo).
  expect(recordedCwd).not.toBe(process.cwd());
});

test("hasOpenPullRequestForBranch returns true when gh reports an open PR", () => {
  const shim = setupGhShim({
    exitCode: 0,
    stdout: JSON.stringify([{ number: 12 }]) + "\n",
  });
  const adapter = new LocalGitAdapter(shim.reposRoot);

  expect(adapter.hasOpenPullRequestForBranch("scoped-repo", "quay/feat")).toBe(
    true,
  );
});

test("hasOpenPullRequestForBranch throws on hard gh failures (no silent skip)", () => {
  // Auth failure: gh exits non-zero, stderr describes the problem. The
  // adapter must surface this — failing closed is required so the
  // collision check isn't silently bypassed.
  const shim = setupGhShim({
    exitCode: 4,
    stdout: "",
    stderr: "gh: not authenticated\n",
  });
  const adapter = new LocalGitAdapter(shim.reposRoot);

  let caught: unknown = null;
  try {
    adapter.hasOpenPullRequestForBranch("scoped-repo", "quay/feat");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/gh pr list/);
  expect((caught as Error).message).toMatch(/scoped-repo/);
});

test("hasOpenPullRequestForBranch throws when gh exits 0 with non-array JSON (e.g. {})", () => {
  // `gh pr list --json number` is contractually an array. If a future
  // gh version (or a misconfigured shim, or a server-side error message
  // returned with exit 0) emits an object, coercing it to `[]` would let
  // the spec §12 collision check silently pass on every retry — exactly
  // the regression we already guard against for hard-error gh failures.
  // Fail closed on the schema anomaly the same way.
  const shim = setupGhShim({ exitCode: 0, stdout: "{}\n" });
  const adapter = new LocalGitAdapter(shim.reposRoot);

  let caught: unknown = null;
  try {
    adapter.hasOpenPullRequestForBranch("scoped-repo", "quay/feat");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/non-array JSON/);
  expect((caught as Error).message).toMatch(/scoped-repo/);
});

test("hasOpenPullRequestForBranch degrades to false when gh is not installed", () => {
  // Force PATH to a directory that contains no `gh` shim. Bun.spawnSync
  // throws ENOENT on missing binaries; the adapter normalizes that into
  // exitCode -1 and returns false (operator hasn't wired the third leg of
  // the collision check, but local + remote still gate enqueue).
  if (originalPath === null) originalPath = process.env.PATH ?? "";
  const empty = tempDir();
  process.env.PATH = empty;
  const reposRoot = tempDir();
  mkdirSync(join(reposRoot, "scoped-repo.git"), { recursive: true });
  const adapter = new LocalGitAdapter(reposRoot);

  expect(adapter.hasOpenPullRequestForBranch("scoped-repo", "quay/feat")).toBe(
    false,
  );
});

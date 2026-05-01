// Spec §5 cleanup matrix: `cancel --keep-worktree` must NOT delete the
// worktree directory. The git adapter's `worktreeDetach` is the boundary
// where this contract lives — if detach quietly aliases to remove, every
// keep-worktree cancel silently violates the spec.
//
// Regression test: build a real bare clone + worktree, call worktreeDetach,
// and assert the directory contents survive.

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { LocalGitAdapter } from "../../src/adapters/git.ts";

const gitAvailable = Bun.spawnSync({
  cmd: ["sh", "-c", "command -v git >/dev/null 2>&1"],
  stdout: "ignore",
  stderr: "ignore",
}).exitCode === 0;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-detach-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function shellGit(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`,
    );
  }
}

const t = gitAvailable ? test : test.skip;

t("worktreeDetach preserves the worktree directory and contents", () => {
  // Arrange a tiny upstream repo, then a bare clone, then a worktree.
  const upstream = tempDir("quay-upstream-");
  shellGit(upstream, "init", "-q", "--initial-branch=main");
  // Configure identity locally so commit succeeds inside CI without a global
  // git config.
  shellGit(upstream, "config", "user.email", "t@e");
  shellGit(upstream, "config", "user.name", "t");
  writeFileSync(join(upstream, "README.md"), "hi\n");
  shellGit(upstream, "add", "README.md");
  shellGit(upstream, "commit", "-q", "-m", "init");

  const reposRoot = tempDir("quay-repos-");
  const adapter = new LocalGitAdapter(reposRoot);

  adapter.cloneBare("test-repo", upstream);
  adapter.fetch("test-repo", "main");

  const worktreesRoot = tempDir("quay-worktrees-");
  const worktreePath = join(worktreesRoot, "task-keep");
  adapter.worktreeAdd(
    "test-repo",
    worktreePath,
    "quay/keep-worktree-task",
    "origin/main",
  );

  // The fresh worktree carries the README we created in the upstream.
  expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  // Drop a marker file so we can prove detach didn't wipe contents.
  writeFileSync(join(worktreePath, "QUAY_KEEP_MARKER"), "preserve me");

  // Act: detach. After this call, the worktree directory must still hold
  // the marker file — `--keep-worktree` is the operator's request to
  // preserve the workspace for inspection.
  adapter.worktreeDetach(worktreePath);

  expect(existsSync(worktreePath)).toBe(true);
  expect(existsSync(join(worktreePath, "QUAY_KEEP_MARKER"))).toBe(true);
  expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  // The .git pointer should be gone — that's what severs the bare-clone
  // tracking so a subsequent `git branch -D` works without complaining the
  // branch is checked out.
  expect(existsSync(join(worktreePath, ".git"))).toBe(false);

  // The directory itself is still a regular directory, not somehow replaced.
  expect(statSync(worktreePath).isDirectory()).toBe(true);

  // Now branchDelete must succeed since the bare clone no longer thinks
  // anything is checked out for that branch.
  adapter.branchDelete("test-repo", "quay/keep-worktree-task");
});

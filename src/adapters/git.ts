// Real Git adapter. Implements GitPort using local git against a configurable
// bare-clone root (`<reposRoot>/<repo_id>.git`). All shell-out calls go
// through `Bun.spawnSync`; none of them invoke a shell, so repo ids and branch
// names cannot smuggle metacharacters into the command line.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitPort } from "../ports/git.ts";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class LocalGitAdapter implements GitPort {
  constructor(private readonly reposRoot: string) {}

  // Defense-in-depth: even though the JS slug normalizer already filters bad
  // characters, the adapter runs `git check-ref-format` as a final gate before
  // any branch op. If the slug fails the gate, fall back to `task-<id>`.
  safeBranchSlug(slug: string, taskIdShort: string): string {
    const fallback = `task-${taskIdShort}`;
    if (slug === "") return fallback;
    const probe = run(["git", "check-ref-format", `refs/heads/quay/${slug}`]);
    return probe.exitCode === 0 ? slug : fallback;
  }

  bareCloneExists(repoId: string): boolean {
    return existsSync(this.bareDir(repoId));
  }

  cloneBare(repoId: string, repoUrl: string): void {
    const result = run([
      "git",
      "clone",
      "--bare",
      repoUrl,
      this.bareDir(repoId),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `git clone --bare failed for ${repoId}: ${result.stderr.trim()}`,
      );
    }
    // Bare clones don't get a fetch refspec by default, so subsequent
    // `git fetch origin <ref>` would only update FETCH_HEAD and the
    // `origin/<base_branch>` ref worktree-add resolves against would never
    // exist. Configure the standard `+refs/heads/*:refs/remotes/origin/*`
    // refspec so fetches populate remote-tracking refs.
    const cfg = runIn(this.bareDir(repoId), [
      "git",
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    if (cfg.exitCode !== 0) {
      throw new Error(
        `git config remote.origin.fetch failed for ${repoId}: ${cfg.stderr.trim()}`,
      );
    }
  }

  fetch(repoId: string, ref: string): void {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "fetch",
      "origin",
      ref,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `git fetch origin ${ref} failed for ${repoId}: ${result.stderr.trim()}`,
      );
    }
  }

  hasLocalBranch(repoId: string, branch: string): boolean {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return result.exitCode === 0;
  }

  hasRemoteBranch(repoId: string, branch: string): boolean {
    // `git ls-remote --exit-code origin refs/heads/<branch>` returns 0 if the
    // ref exists on origin, 2 if it doesn't, anything else is a real error.
    const result = runIn(this.bareDir(repoId), [
      "git",
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${branch}`,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 2) return false;
    throw new Error(
      `git ls-remote failed for ${repoId} ${branch}: ${result.stderr.trim()}`,
    );
  }

  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean {
    // The third leg of the spec §12 collision check uses `gh pr list`; the
    // GitHub adapter is the right home for that, so this method delegates by
    // shelling out to `gh`. If `gh` is unavailable or unauthenticated, treat
    // it as "no open PR" — the operator already accepted the JS-side slug
    // collision rules and the local + remote checks will catch the common
    // cases. Failing closed here would block enqueues on machines without
    // `gh` configured for an unrelated reason.
    const result = run([
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
    ]);
    if (result.exitCode !== 0) return false;
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }

  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      baseRef,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add ${branch} ${worktreePath} failed: ${result.stderr.trim()}`,
      );
    }
  }

  worktreeDetach(worktreePath: string): void {
    // Severs the bare clone's tracking of this worktree WITHOUT deleting the
    // directory contents — this is what `quay cancel --keep-worktree`
    // relies on. `git worktree remove --force` always deletes; the manual
    // recipe is to drop the gitfile (`<worktree>/.git`) and the matching
    // admin directory inside the bare clone (`<bare>/worktrees/<name>`).
    // Once both are gone, the bare clone no longer thinks the branch is
    // checked out, so `git branch -D` succeeds; the worktree directory is
    // left as a pile of plain files for the operator.
    if (!existsSync(worktreePath)) return;
    const gitfile = join(worktreePath, ".git");
    let adminDir: string | null = null;
    try {
      const contents = readFileSync(gitfile, "utf8");
      const m = contents.match(/^gitdir:\s*(.+)$/m);
      if (m && m[1]) adminDir = m[1].trim();
    } catch {
      // No .git pointer — already detached, treat as a no-op.
    }
    try {
      rmSync(gitfile, { force: true });
    } catch {}
    if (adminDir !== null) {
      try {
        rmSync(adminDir, { recursive: true, force: true });
      } catch {}
    }
  }

  worktreeRemove(worktreePath: string): void {
    if (!existsSync(worktreePath)) return;
    // `git worktree remove --force` requires running from inside the
    // bare-clone (or any repo with a worktree list); we don't always know the
    // repoId here, so we use `--force` and rely on the worktree list inside
    // the path's parent .git/worktrees pointer. The simpler portable form is
    // `git -C <worktreePath> worktree remove --force <worktreePath>` which
    // works because `-C` chooses cwd and the worktree's own .git points at
    // the bare clone.
    const removed = runIn(worktreePath, [
      "git",
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    if (removed.exitCode !== 0) {
      // Best-effort: if `git worktree remove` failed (e.g., already
      // detached), drop the directory directly. Spec §5 explicitly tolerates
      // worktree cleanup failures during terminal transitions.
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }
  }

  branchDelete(repoId: string, branch: string): void {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "branch",
      "-D",
      branch,
    ]);
    // `git branch -D` against a non-existent branch returns non-zero; that's
    // not a programmer error in our cleanup paths, so swallow it. Real
    // failures (permissions, FS error) only surface as logged tick errors.
    if (result.exitCode !== 0) {
      const msg = result.stderr.toLowerCase();
      if (!msg.includes("not found") && !msg.includes("no such")) {
        // Surfacing other errors helps debug worktree corruption per spec §5.
        throw new Error(
          `git branch -D ${branch} failed for ${repoId}: ${result.stderr.trim()}`,
        );
      }
    }
  }

  removeBareClone(repoId: string): void {
    const dir = this.bareDir(repoId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  remoteHeadSha(repoId: string, branch: string): string | null {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  deleteRemoteBranch(repoId: string, branch: string): void {
    // Idempotent: tolerate "remote ref does not exist" and any other
    // non-fatal failure per spec §5.
    runIn(this.bareDir(repoId), [
      "git",
      "push",
      "origin",
      "--delete",
      branch,
    ]);
  }

  private bareDir(repoId: string): string {
    // Defense-in-depth: the schema (`src/core/repos/schema.ts`) already
    // restricts `repo_id` to a safe identifier charset, but the adapter is
    // the last hop before a real `rm`/`git clone` runs against the path, so
    // it re-checks here. Any `repo_id` containing path separators or
    // resolving outside `reposRoot` is refused — making traversal a hard
    // error rather than a silent escape if a future code path skips the
    // schema.
    if (!/^[A-Za-z0-9._-]+$/.test(repoId) || repoId === "." || repoId === "..") {
      throw new Error(`repo_id "${repoId}" is not a safe identifier`);
    }
    const root = resolve(this.reposRoot);
    const dir = resolve(this.reposRoot, `${repoId}.git`);
    if (!dir.startsWith(`${root}/`) && dir !== root) {
      throw new Error(
        `repo_id "${repoId}" escapes reposRoot (${root}); refusing to operate`,
      );
    }
    return dir;
  }
}

function run(cmd: string[]): RunResult {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function runIn(cwd: string, cmd: string[]): RunResult {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

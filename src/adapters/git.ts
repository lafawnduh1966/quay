// Real Git adapter. Implements GitPort using local git against a configurable
// bare-clone root (`<reposRoot>/<repo_id>.git`). All shell-out calls go
// through `Bun.spawnSync`; none of them invoke a shell, so repo ids and branch
// names cannot smuggle metacharacters into the command line.
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
    // Spec §12 collision check, third leg: `gh pr list --head <branch>
    // --state open` returns non-empty iff the branch already has an open PR
    // attached. This catches the "remote branch deleted on merge but PR
    // closed_unmerged" cases — local + remote checks alone would miss it.
    //
    // Two correctness invariants:
    //   1. `gh` must be invoked from inside the bare clone for THIS repo so
    //      it infers the upstream from `origin`. Without `cwd`, `gh` runs
    //      against whatever repo the operator's shell happens to be in (or
    //      none), and the collision check silently inspects the wrong
    //      project — letting enqueue reuse a branch that has an open PR on
    //      the actual target repo.
    //   2. Hard `gh` failures must surface, not get swallowed into "no open
    //      PR." Failing open here defeats the whole point of the collision
    //      check: a transient API error or auth misconfig would let enqueue
    //      reuse an open-PR branch on every retry. The exception is the
    //      legitimate "no PRs at all" gh response (exit 0 with empty array)
    //      and the spawn-not-found case (operator has not installed gh —
    //      caught by the ENOENT branch below; treated as "skip the third
    //      leg" since the spec's collision check is impossible without gh).
    const dir = this.bareDir(repoId);
    const result = runIn(dir, [
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
    if (result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        return Array.isArray(parsed) && parsed.length > 0;
      } catch (err) {
        throw new Error(
          `gh pr list returned unparseable JSON for ${branch}: ${(err as Error).message}`,
        );
      }
    }
    // `Bun.spawnSync` reports a missing executable either by throwing
    // ENOENT (caught in `runIn` and forwarded as exitCode -1) or, on some
    // platforms, by returning exit code 127. Both indicate "gh isn't on
    // PATH" — operator hasn't wired the GitHub CLI, the spec's third leg
    // is structurally unavailable, and we degrade gracefully to "no open
    // PR" so the local + remote legs still gate the enqueue.
    const stderrLower = result.stderr.toLowerCase();
    const ghMissing =
      result.exitCode === -1 ||
      result.exitCode === 127 ||
      stderrLower.includes("command not found") ||
      stderrLower.includes("no such file or directory");
    if (ghMissing) return false;
    // Anything else (auth failure, rate limit, network blip, malformed
    // args, repo-not-recognized) is a hard failure. Fail closed so the
    // collision check isn't silently skipped.
    throw new Error(
      `gh pr list --head ${branch} failed for ${repoId} (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
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
    //
    // Security: the gitfile is *inside the worker's worktree*, so a worker
    // can rewrite it to point anywhere on disk. We therefore refuse to
    // recursively delete an admin path that does not resolve to the
    // canonical `<reposRoot>/<repo_id>.git/worktrees/<name>` shape — without
    // this check, a malicious worker could turn `cancel --keep-worktree`
    // into a primitive that deletes any directory the Quay process can
    // reach.
    if (!existsSync(worktreePath)) return;
    const gitfile = join(worktreePath, ".git");
    let adminDirRaw: string | null = null;
    try {
      const contents = readFileSync(gitfile, "utf8");
      const m = contents.match(/^gitdir:\s*(.+)$/m);
      if (m && m[1]) adminDirRaw = m[1].trim();
    } catch {
      // No .git pointer — already detached, treat as a no-op.
    }
    try {
      rmSync(gitfile, { force: true });
    } catch {}
    if (adminDirRaw !== null) {
      // Resolve symlinks on both sides before comparison: macOS routes
      // `/var/folders/...` → `/private/var/folders/...`, and git's gitfile
      // emits the resolved path. A literal-prefix check on unresolved paths
      // would reject every legitimate temp-dir layout.
      const root = canonical(this.reposRoot);
      const adminAbs = canonical(adminDirRaw);
      // Allowed shape: `<reposRoot>/<repo_id>.git/worktrees/<name>`. The
      // first segment under reposRoot must end in `.git`, the second must
      // be exactly `worktrees`, and there must be a non-empty third
      // segment. Anything else (a bare-root delete, an escape via `..`, a
      // symlink target outside reposRoot) is refused. We also re-check
      // `<repo_id>.git`'s charset against the same identifier rules
      // bareDir() enforces.
      if (adminAbs.startsWith(`${root}/`)) {
        const rel = adminAbs.slice(root.length + 1);
        const segs = rel.split("/");
        const repoSeg = segs[0] ?? "";
        if (
          segs.length >= 3 &&
          segs[1] === "worktrees" &&
          segs[2] !== "" &&
          segs[2] !== "." &&
          segs[2] !== ".." &&
          repoSeg.endsWith(".git") &&
          /^[A-Za-z0-9._-]+\.git$/.test(repoSeg)
        ) {
          try {
            rmSync(adminAbs, { recursive: true, force: true });
          } catch {}
        }
        // else: outside the canonical layout — leave alone. The next bare-
        // clone op will lazily prune dangling admin entries.
      }
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
  // Mirror runIn's spawn-error handling so callers can distinguish
  // "missing binary" from "binary returned non-zero" by checking for
  // exitCode === -1. `env: process.env` for the same PATH-snapshot reason
  // documented on `runIn`.
  let result;
  try {
    result = Bun.spawnSync({
      cmd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: (err as Error).message ?? String(err),
    };
  }
  return {
    exitCode: result.exitCode ?? 0,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function runIn(cwd: string, cmd: string[]): RunResult {
  // If the executable is missing, `Bun.spawnSync` throws `ENOENT` rather
  // than returning a non-zero exit. Adapter code that needs to distinguish
  // "gh not installed" from "gh ran and returned non-zero" relies on
  // `exitCode === -1`, so map any spawn error into that sentinel.
  //
  // `env: process.env` is forwarded explicitly because Bun snapshots PATH
  // at process startup unless a caller passes `env`. Without it, a test
  // that prepends a shim directory to `process.env.PATH` would be silently
  // ignored — the real binary on the original PATH would still resolve.
  let result;
  try {
    result = Bun.spawnSync({
      cmd,
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: (err as Error).message ?? String(err),
    };
  }
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

// Resolve symlinks where they exist; otherwise fall back to the literal
// resolved path. We accept the no-such-path case because the containment
// check is also called against admin dirs that may already have been
// pruned. A non-existent path simply fails the prefix check.
function canonical(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

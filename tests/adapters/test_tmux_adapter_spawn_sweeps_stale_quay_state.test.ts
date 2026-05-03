// Regression: TmuxAdapter.spawn used to write the new prompt and start
// pipe-pane without sweeping prior `.quay-*` state. Two failure modes
// followed:
//
//   1. A leftover `.quay-blocked.md` from a failed delete or manual
//      operator intervention would be ingested as the next attempt's
//      blocker on the classifier's first read — the worker would be
//      "blocked" before it even started.
//   2. `.quay-session.log` was opened by pipe-pane via `cat >>`, so
//      bytes from the previous attempt persisted into the new attempt's
//      log. That breaks (a) the classifier's log scan (old output bleeds
//      through) and (b) the freshness mtime check (the file's mtime
//      advances on every previous-attempt byte, so a brand-new worker
//      that hasn't printed yet looks "fresh" against a window that
//      should start from spawn).
//
// The fix is a spawn preflight that removes every direct child whose
// name starts with `.quay-` before writing the new prompt or starting
// pipe-pane. We verify (a) stale blocker is gone, (b) old session-log
// bytes are not present in the new attempt's log, (c) the freshly
// written prompt is what we asked for.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { TmuxAdapter } from "../../src/adapters/tmux.ts";

const tmuxAvailable = (() => {
  const have =
    Bun.spawnSync({
      cmd: ["sh", "-c", "command -v tmux >/dev/null 2>&1"],
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  if (!have) return false;
  const probeSession = `quay-tmux-probe-${Math.random().toString(36).slice(2, 10)}`;
  const created = Bun.spawnSync({
    cmd: ["tmux", "new-session", "-d", "-s", probeSession, "true"],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (created.exitCode !== 0) return false;
  Bun.spawnSync({
    cmd: ["tmux", "kill-session", "-t", probeSession],
    stdout: "ignore",
    stderr: "ignore",
  });
  return true;
})();

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-tmux-sweep-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uniqueSession(suffix: string): string {
  const r = Math.random().toString(36).slice(2, 10);
  const session = `quay-test-${suffix}-${r}`;
  cleanups.push(() => {
    Bun.spawnSync({
      cmd: ["tmux", "kill-session", "-t", session],
      stdout: "ignore",
      stderr: "ignore",
    });
  });
  return session;
}

async function waitFor<T>(
  predicate: () => T | null | false,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value as T;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const t = tmuxAvailable ? test : test.skip;

t("spawn removes a stale .quay-blocked.md from a previous attempt", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("sweep-blocked");
  const stalePath = join(worktreePath, ".quay-blocked.md");
  writeFileSync(stalePath, "STALE BLOCKER FROM PREVIOUS ATTEMPT");
  expect(existsSync(stalePath)).toBe(true);

  // Quick exit; we only care about the preflight, not the agent's output.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "fresh prompt",
    agentInvocation: "true",
  });

  // Sweep happens synchronously inside spawn before pipe-pane is wired,
  // so by the time spawn returns the stale file must be gone.
  expect(existsSync(stalePath)).toBe(false);
});

t("spawn truncates a stale .quay-session.log so old bytes do not bleed into the new attempt", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("sweep-log");
  const logPath = join(worktreePath, ".quay-session.log");

  // Pre-existing log from "the previous attempt". Without the spawn
  // sweep, pipe-pane opens this in append mode and the new attempt's log
  // begins with these bytes.
  writeFileSync(logPath, "OLD-ATTEMPT-OUTPUT-DO-NOT-CARRY-FORWARD\n");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "printf 'NEW-ATTEMPT-MARKER\\n'; sleep 1",
  });

  // Wait for the new attempt's first byte to land.
  const wrote = await waitFor(
    () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("NEW-ATTEMPT-MARKER"),
    3000,
  );
  expect(wrote).toBe(true);

  const log = readFileSync(logPath, "utf8");
  // The new attempt's marker is present...
  expect(log).toContain("NEW-ATTEMPT-MARKER");
  // ...and the previous attempt's bytes are NOT carried forward.
  expect(log.includes("OLD-ATTEMPT-OUTPUT-DO-NOT-CARRY-FORWARD")).toBe(false);
});

t("spawn rewrites .quay-prompt.md with the new prompt even if a stale one exists", () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("sweep-prompt");
  const promptPath = join(worktreePath, ".quay-prompt.md");
  writeFileSync(promptPath, "PREVIOUS PROMPT BODY");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "FRESH PROMPT BODY",
    agentInvocation: "true",
  });

  // The sweep removes the prior file and spawn writes the new prompt
  // immediately after — so the on-disk content is the fresh body, never
  // a hybrid.
  expect(readFileSync(promptPath, "utf8")).toBe("FRESH PROMPT BODY");
});

// Fail-closed regression: if `.quay-session.log` (or `.quay-blocked.md`)
// exists from a prior attempt and the sweep cannot remove it, spawn must
// abort instead of silently proceeding — proceeding would reintroduce the
// exact stale-state bug the sweep exists to fix (old log bytes bleeding
// into the new attempt's log, skewed mtime freshness, etc.). Other
// `.quay-*` files remain best-effort; only these two are gated.
//
// This test does NOT require tmux: the abort happens during the spawn
// preflight, before tmux is ever invoked.
test("spawn aborts when a stale .quay-session.log cannot be swept", () => {
  // chmod-based unremovability does not apply when running as root
  // (root bypasses the parent-dir write-permission check). CI sometimes
  // runs as root; skip there to avoid a false negative.
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    return;
  }
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const stalePath = join(worktreePath, ".quay-session.log");
  writeFileSync(stalePath, "stale bytes from previous attempt");

  // Strip write permission on the parent so unlinking the entry fails
  // with EACCES. Restore in cleanup BEFORE the temp-dir rmSync runs so
  // afterEach can clean up; cleanups run LIFO and `tempWorktree` already
  // pushed the rm — we unshift here so this perm-restore fires first.
  chmodSync(worktreePath, 0o555);
  cleanups.unshift(() => {
    try {
      chmodSync(worktreePath, 0o755);
    } catch {}
  });

  expect(() =>
    adapter.spawn({
      sessionName: `quay-test-sweep-fail-${Math.random().toString(36).slice(2, 10)}`,
      worktreePath,
      promptContent: "ignored",
      agentInvocation: "true",
    }),
  ).toThrow(/quay-session\.log/);

  // The stale file is still on disk (the rm failed) — proves we aborted
  // BEFORE clobbering anything else and BEFORE spawning tmux. If spawn
  // had silently proceeded past the failed rm, this file might still be
  // there too, but pipe-pane would have been wired against it; the
  // operator-visible failure mode of "fail closed" is the throw, which
  // we asserted above.
  expect(existsSync(stalePath)).toBe(true);
});

test("spawn aborts when a stale .quay-blocked.md cannot be swept", () => {
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    return;
  }
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const stalePath = join(worktreePath, ".quay-blocked.md");
  writeFileSync(stalePath, "STALE BLOCKER");
  chmodSync(worktreePath, 0o555);
  cleanups.unshift(() => {
    try {
      chmodSync(worktreePath, 0o755);
    } catch {}
  });

  expect(() =>
    adapter.spawn({
      sessionName: `quay-test-sweep-fail-blocker-${Math.random().toString(36).slice(2, 10)}`,
      worktreePath,
      promptContent: "ignored",
      agentInvocation: "true",
    }),
  ).toThrow(/quay-blocked\.md/);
});

t("spawn does not touch unrelated files in the worktree root", () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("sweep-scope");

  // Worker-owned files at the worktree root must survive. The sweep is
  // intentionally scoped to the `.quay-` prefix; if it widens, the worker
  // loses commits / staging.
  const workerFile = join(worktreePath, "package.json");
  writeFileSync(workerFile, '{"name": "worker-output"}');
  // A stale Quay file alongside, so we know the sweep DID run.
  const stale = join(worktreePath, ".quay-stale-marker");
  writeFileSync(stale, "x");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "true",
  });

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(workerFile)).toBe(true);
  expect(readFileSync(workerFile, "utf8")).toBe('{"name": "worker-output"}');
});

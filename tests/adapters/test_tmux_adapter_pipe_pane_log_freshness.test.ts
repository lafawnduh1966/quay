// Regression: real-tmux workers used to be falsely marked stale because
// the adapter never configured pipe-pane and `logFreshness` always
// returned `spawnedAt`. Tick's stale-kill check would then fire on any
// worker older than `staleness_threshold_seconds` even when actively
// producing output. Spec §12 mandates piping the pane to
// `<worktree>/.quay-session.log`, and the adapter must read that file's
// mtime as the freshness signal.
//
// We verify (a) the log file is created and populated when the agent
// prints output, (b) `collectLog` reads its contents back, (c)
// `logFreshness` returns the file's mtime (not spawned_at) once output
// has landed.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "quay-tmux-pipe-"));
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

t("pipe-pane writes agent output to <worktree>/.quay-session.log", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("pipe");
  const logPath = join(worktreePath, ".quay-session.log");

  // The agent prints a marker, sleeps so the session stays alive long
  // enough for us to inspect, then exits.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "printf 'hello-from-agent\\n'; sleep 1",
  });

  // The log file appears as soon as pipe-pane is configured and the
  // agent's first byte lands. With pipe-pane wired correctly this is
  // sub-second; without it, the file never appears.
  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  // collectLog returns the captured bytes — the agent's stdout marker is
  // present in the buffered log.
  const log = adapter.collectLog(sessionName, worktreePath);
  expect(log).not.toBeNull();
  expect(log!).toContain("hello-from-agent");
});

t("logFreshness returns the log file's mtime once output has landed", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("fresh");
  const logPath = join(worktreePath, ".quay-session.log");

  // A spawn timestamp deliberately set far in the past — if the adapter
  // ever falls back to `spawnedAt` for a session that has actually
  // produced output, tick's stale check would fire. We assert the
  // freshness read advances PAST this floor as soon as the log is
  // written.
  const oldSpawnedAt = "2020-01-01T00:00:00.000Z";

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "printf 'tick\\n'; sleep 1",
  });

  // Wait for the agent's output to land.
  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const fresh = adapter.logFreshness(sessionName, worktreePath, oldSpawnedAt);
  // The returned timestamp must be the log mtime, parseable as a recent
  // ISO date — anything close to "now", definitely not the 2020 floor.
  expect(fresh).not.toBe(oldSpawnedAt);
  const freshMs = Date.parse(fresh);
  expect(Number.isFinite(freshMs)).toBe(true);
  // Clock skew tolerance is wide; the only thing that matters is that
  // the timestamp is *more recent* than spawned_at. Tick's stale check
  // uses (now - freshMs) so any sane current-decade timestamp fixes the
  // bug.
  expect(freshMs).toBeGreaterThan(Date.parse(oldSpawnedAt));
});

t("logFreshness falls back to spawnedAt before any output has landed", async () => {
  // Spec contract: a freshly-spawned worker that has NOT yet written
  // anything to its log should report spawnedAt as freshness, so the
  // staleness window starts from spawn (not from epoch / not from a
  // pre-spawn artifact). Here we directly call `logFreshness` against a
  // worktree with no log file at all.
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const spawnedAt = "2026-04-26T10:00:00.000Z";
  expect(existsSync(join(worktreePath, ".quay-session.log"))).toBe(false);
  const fresh = adapter.logFreshness("any-session", worktreePath, spawnedAt);
  expect(fresh).toBe(spawnedAt);
});

t("collectLog returns null when the log file does not exist", () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  expect(adapter.collectLog("never-existed", worktreePath)).toBeNull();
});

// Regression: the tail-read path (file > MAX_LOG_BYTES = 4 MiB) used to
// call `Bun.file(...).slice().arrayBuffer()` synchronously, but that
// returns a Promise. Decoding the Promise as a Uint8Array yielded an
// empty string, so every >4 MiB session log silently came back as "" —
// exactly the case where operators most want the recent context. The
// fix uses Node's `readSync` with a positional offset, which is truly
// blocking. We verify by writing a >4 MiB file directly (no tmux
// needed) and asserting the tail bytes round-trip through `collectLog`.
test("collectLog tails files larger than the cap synchronously (no Bun.file Promise leak)", () => {
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const logPath = join(worktreePath, ".quay-session.log");

  // 5 MiB = 1 MiB above the 4 MiB cap. Distinct head/tail markers so we
  // can verify the tail bias rather than just non-emptiness.
  const HEAD = "HEAD-MARKER\n";
  const TAIL = "\nTAIL-MARKER\n";
  const filler = "x".repeat(5 * 1024 * 1024 - HEAD.length - TAIL.length);
  writeFileSync(logPath, HEAD + filler + TAIL, { encoding: "utf8" });

  const log = adapter.collectLog("any-session", worktreePath);
  expect(log).not.toBeNull();
  // The tail marker MUST be present — that's the whole point of
  // tail-reading. If the Promise leak comes back, log === "" and this
  // assertion fails.
  expect(log!).toContain("TAIL-MARKER");
  // The capped read drops the head; that's the expected tail-bias
  // behaviour. (If the cap is ever raised above the file size, this
  // assertion would need to relax.)
  expect(log!.length).toBeGreaterThan(0);
  expect(log!.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(log!.includes("HEAD-MARKER")).toBe(false);
});

// Spec §12: the real tmux adapter wraps the agent invocation in
// `exec sh -c "..."` so the tmux session disappears when the agent process
// exits. This is what makes `tmux has-session -t <name>` a reliable liveness
// probe — without `exec`, the shell would persist after the agent terminates
// and break the dead-worker classifier.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { TmuxAdapter } from "../../src/adapters/tmux.ts";

// `command -v tmux` is necessary but not sufficient: in sandboxed
// environments the binary exists but cannot create the per-uid socket dir
// under `/private/tmp/tmux-<uid>` (EPERM). Probe an actual session
// creation+teardown so the suite skips gracefully when the daemon can't
// stand up. Without this, the default `bun test` run fails with
// "error connecting to /private/tmp/tmux-501/default (Operation not
// permitted)" on hosts where tmux is installed but blocked.
const tmuxAvailable = (() => {
  const have = Bun.spawnSync({
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
  // Teardown is best-effort; the session should self-exit because `true`
  // returns immediately, but kill it explicitly in case tmux held it open
  // for any reason (e.g. remain-on-exit option set globally).
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
  const dir = mkdtempSync(join(tmpdir(), "quay-tmux-"));
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

t("test_tmux_adapter_session_exits_when_agent_exits", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit");

  // Use a `sleep` long enough that we can observe the session alive before
  // killing it. A `true` invocation can race past the alive check on slow
  // hosts; we pin the alive state instead, then prove the session goes away
  // once the agent exits.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sleep 0.3",
  });

  // Real liveness probe: the tmux session must be observable before we can
  // claim anything about its disappearance. `true` here would mask a broken
  // adapter; we want the assertion to fail if isAlive never returns true.
  const becameAlive = await waitFor(() => adapter.isAlive(sessionName), 1000);
  expect(becameAlive).toBe(true);

  // Once the agent exited, exec semantics tear down the tmux pane and the
  // session goes away. This is the core liveness contract.
  const becameDead = await waitFor(() => !adapter.isAlive(sessionName), 3000);
  expect(becameDead).toBe(true);
});

t("test_tmux_adapter_long_running_agent_stays_alive_until_killed", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("alive");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sleep 30",
  });

  const alive = await waitFor(() => adapter.isAlive(sessionName), 1000);
  expect(alive).toBe(true);

  adapter.kill(sessionName);
  const dead = await waitFor(() => !adapter.isAlive(sessionName), 1000);
  expect(dead).toBe(true);
});

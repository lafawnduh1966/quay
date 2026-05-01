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

const tmuxAvailable = Bun.spawnSync({
  cmd: ["sh", "-c", "command -v tmux >/dev/null 2>&1"],
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

  // Agent invocation that exits immediately. The {prompt_file} token must be
  // accepted (it's not used here) since real callers always pass it.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "true",
  });

  // Wait for the session to appear (spawn is async-ish), then for it to exit.
  const becameAlive = await waitFor(
    () => adapter.isAlive(sessionName) || true,
    500,
  );
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

// Real Tmux adapter. Wraps `tmux new-session -d -s <session> 'exec sh -c
// "<agent_invocation>"'` so the tmux session disappears the moment the agent
// process exits, preserving liveness detection (spec §12).
//
// Prompt handling: `<worktree>/.quay-prompt.md` is written before spawn. The
// agent invocation is a template; `{prompt_file}` is replaced with the
// absolute path to the prompt file before being passed to the shell.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TmuxPort, TmuxSpawnInput } from "../ports/tmux.ts";

const PROMPT_FILE = ".quay-prompt.md";

export class TmuxAdapter implements TmuxPort {
  spawn(input: TmuxSpawnInput): void {
    const promptFile = join(input.worktreePath, PROMPT_FILE);
    writeFileSync(promptFile, input.promptContent);

    const expanded = input.agentInvocation.replaceAll(
      "{prompt_file}",
      shellQuote(promptFile),
    );
    // `exec sh -c "..."` so the inner agent replaces the shell. When the
    // agent exits, the pane has nothing left to run and tmux drops the
    // session — making `tmux has-session` a reliable liveness probe.
    const tmuxCommand = `exec sh -c ${shellQuote(expanded)}`;

    const result = Bun.spawnSync({
      cmd: [
        "tmux",
        "new-session",
        "-d",
        "-s",
        input.sessionName,
        "-c",
        input.worktreePath,
        tmuxCommand,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(
        `tmux new-session for ${input.sessionName} failed (exit ${result.exitCode}): ${stderr.trim()}`,
      );
    }
  }

  isAlive(sessionName: string): boolean {
    const result = Bun.spawnSync({
      cmd: ["tmux", "has-session", "-t", `=${sessionName}`],
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  }

  kill(sessionName: string): void {
    // Idempotent: kill-session against a non-existent session exits 1; we
    // don't care because the postcondition (session not alive) is met either
    // way.
    Bun.spawnSync({
      cmd: ["tmux", "kill-session", "-t", `=${sessionName}`],
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  collectLog(_sessionName: string): string | null {
    // Pane log capture is best-effort and not needed for liveness. Real
    // operator-side log collection is wired in a later refinement; tests use
    // the FakeTmux log capture path.
    return null;
  }

  logFreshness(_sessionName: string, spawnedAt: string): string {
    // Without a captured log, the freshest signal we have is spawn time.
    return spawnedAt;
  }
}

// POSIX-shell single-quote escaping. Any single-quote in the input is closed,
// escaped with `'\''`, and reopened.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

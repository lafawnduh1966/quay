import type { TmuxPort, TmuxSpawnInput } from "../../../src/ports/tmux.ts";

export interface FakeTmuxSpawnCall {
  sessionName: string;
  worktreePath: string;
  promptContent: string;
  agentInvocation: string;
}

export class FakeTmux implements TmuxPort {
  readonly spawnAttempts: FakeTmuxSpawnCall[] = [];
  readonly spawnCalls: FakeTmuxSpawnCall[] = [];
  readonly killCalls: string[] = [];
  readonly collectLogCalls: string[] = [];
  readonly liveSessions = new Set<string>();
  readonly sessionLogs = new Map<string, string>();
  spawnHandler: ((input: TmuxSpawnInput) => void) | null = null;

  spawn(input: TmuxSpawnInput): void {
    this.spawnAttempts.push({ ...input });
    if (this.spawnHandler) {
      this.spawnHandler(input);
    }
    this.spawnCalls.push({ ...input });
    this.liveSessions.add(input.sessionName);
  }

  isAlive(sessionName: string): boolean {
    return this.liveSessions.has(sessionName);
  }

  kill(sessionName: string): void {
    this.killCalls.push(sessionName);
    this.liveSessions.delete(sessionName);
  }

  collectLog(sessionName: string): string | null {
    this.collectLogCalls.push(sessionName);
    return this.sessionLogs.get(sessionName) ?? null;
  }

  setSessionLog(sessionName: string, content: string): void {
    this.sessionLogs.set(sessionName, content);
  }

  markDead(sessionName: string): void {
    this.liveSessions.delete(sessionName);
  }

  failSpawnNext(message = "fake: tmux spawn failed"): void {
    let fired = false;
    const prior = this.spawnHandler;
    this.spawnHandler = (input) => {
      if (!fired) {
        fired = true;
        throw new Error(message);
      }
      prior?.(input);
    };
  }
}

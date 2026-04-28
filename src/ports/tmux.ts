// TmuxPort. Real implementation lives under src/adapters/ in slice 10.
//
// The real adapter writes <worktree>/.quay-prompt.md, runs tmux new-session,
// configures pane piping, and sends the agent invocation wrapped in
// `exec sh -c '...'` (per spec §12). Slice 4 wires up isAlive/kill/collectLog
// for the dead-worker classifier and spawn-window recovery.
export interface TmuxSpawnInput {
  sessionName: string;
  worktreePath: string;
  promptContent: string;
  agentInvocation: string;
}

export interface TmuxPort {
  spawn(input: TmuxSpawnInput): void;
  isAlive(sessionName: string): boolean;
  kill(sessionName: string): void;
  // Best-effort: returns the buffered tmux pane log for the named session, or
  // null if no log is available (session never logged, log file missing, etc).
  // The classifier persists the returned bytes as a `session_log` artifact.
  collectLog(sessionName: string): string | null;
}

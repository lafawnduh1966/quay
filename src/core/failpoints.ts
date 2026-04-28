// Test-only failpoint registry per spec §"Failpoint Strategy".
//
// Failpoints are no-ops by default. Tests install handlers (typically that
// throw) to simulate process death immediately after a durable boundary.
// Production code calls fireFailpoint at the documented boundaries; if no
// handler is registered the call is a tight no-op.
export type FailpointName =
  | "after_blocker_artifact_write"
  | "after_blocker_state_commit"
  | "after_tmux_session_created";

const handlers = new Map<FailpointName, () => void>();

export function setFailpoint(
  name: FailpointName,
  handler: (() => void) | null,
): void {
  if (handler === null) {
    handlers.delete(name);
  } else {
    handlers.set(name, handler);
  }
}

export function fireFailpoint(name: FailpointName): void {
  const h = handlers.get(name);
  if (h) h();
}

export function clearAllFailpoints(): void {
  handlers.clear();
}

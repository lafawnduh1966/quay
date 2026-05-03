// Real Tmux adapter. Wraps `tmux new-session -d -s <session> 'exec sh -c
// "<agent_invocation>"'` so the tmux session disappears the moment the agent
// process exits, preserving liveness detection (spec §12).
//
// Prompt handling: `<worktree>/.quay-prompt.md` is written before spawn. The
// agent invocation is a template; `{prompt_file}` is replaced with the
// absolute path to the prompt file before being passed to the shell.
//
// Pane log capture: after `new-session`, the adapter runs
// `tmux pipe-pane -o "cat >> <worktree>/.quay-session.log"` (spec §12) so
// every byte the agent prints lands in a file the classifier and tick's
// stale check can read. The log file's mtime is the freshness signal: a
// worker that's actively producing output has a recent mtime; a hung worker
// (or one that died before tmux noticed) has an old mtime. Without this
// pipe, every long-running task gets stale-killed past the staleness
// threshold even when actively producing output.
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TmuxPort, TmuxSpawnInput } from "../ports/tmux.ts";

const PROMPT_FILE = ".quay-prompt.md";
const SESSION_LOG_FILE = ".quay-session.log";
// Marker for direct children of the worktree root that belong to a previous
// Quay attempt. Anything matching this prefix is sweep-eligible at spawn
// time — see the spawn preflight for why.
const QUAY_STATE_PREFIX = ".quay-";
// Cap log artifact reads at a few MB so a runaway agent that never exits
// doesn't push gigabytes through the artifact store. The tail bias matches
// "what is the worker doing right now?" — the most recent output is what
// the classifier and operator care about.
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export class TmuxAdapter implements TmuxPort {
  spawn(input: TmuxSpawnInput): void {
    // Spawn preflight: sweep direct children of the worktree whose names
    // start with `.quay-`. A leftover `.quay-blocked.md` from a previous
    // attempt would otherwise be ingested as the new attempt's blocker on
    // the next classifier read; a leftover `.quay-session.log` would mix
    // old bytes into the new attempt's log (and skew the freshness mtime
    // check, since we open the pipe-pane sink with `cat >>`). Scope is
    // tight — only direct children, only the `.quay-` prefix — so we never
    // touch anything the worker wrote under nested directories.
    sweepQuayState(input.worktreePath);

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

    // Configure pane piping AFTER the session exists. The `-o` flag is the
    // "open" side of the toggle (start piping if not already piping). We
    // build the inner shell command via `shellQuote` for the same reason
    // we quote the agent invocation: the worktree path is Quay-controlled
    // but goes through `sh -c` and we want safe behavior even if a future
    // path scheme introduces metacharacters.
    const logPath = join(input.worktreePath, SESSION_LOG_FILE);
    const pipeCommand = `cat >> ${shellQuote(logPath)}`;
    // Target the session's active pane explicitly. tmux's `=<name>` exact-
    // match prefix is a target-SESSION construct, but pipe-pane wants a
    // target-PANE. The canonical form is `<session>:<window>.<pane>`; for
    // a freshly created `new-session -d` the only pane is the default
    // window's index-0 pane.
    const pipe = Bun.spawnSync({
      cmd: [
        "tmux",
        "pipe-pane",
        "-o",
        "-t",
        `${input.sessionName}:0.0`,
        pipeCommand,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pipe.exitCode !== 0) {
      // If pipe-pane fails the session is still spawned and the agent is
      // running — but we'd silently lose the freshness signal that drives
      // tick's stale-kill check, leading to long-lived workers being
      // killed as stale at the threshold. Surface this as a hard spawn
      // failure so the spawn-substrate-failed path takes over.
      const stderr = new TextDecoder().decode(pipe.stderr);
      // Best-effort: kill the session we just created so we don't leak it.
      try {
        Bun.spawnSync({
          cmd: ["tmux", "kill-session", "-t", `=${input.sessionName}`],
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
      throw new Error(
        `tmux pipe-pane for ${input.sessionName} failed (exit ${pipe.exitCode}): ${stderr.trim()}`,
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

  collectLog(_sessionName: string, worktreePath: string): string | null {
    // The pipe-pane configured at spawn writes every byte the agent prints
    // to <worktreePath>/.quay-session.log. Survives the session's death
    // (the file is independent of tmux state), so post-mortem classifier
    // and cancel-finalizer reads still work.
    const logPath = join(worktreePath, SESSION_LOG_FILE);
    if (!existsSync(logPath)) return null;
    let stat;
    try {
      stat = statSync(logPath);
    } catch {
      return null;
    }
    if (stat.size === 0) return null;
    try {
      if (stat.size <= MAX_LOG_BYTES) {
        return readFileSync(logPath, "utf8");
      }
      // Tail-read: bias toward the most recent output, which is what the
      // classifier and the operator actually want to see for "what was
      // this worker doing when it died?". `Bun.file().slice().arrayBuffer()`
      // returns a Promise, so calling it synchronously decoded as empty —
      // every >4MiB log was silently lost. Use Node's blocking
      // `openSync` + positional `readSync` instead.
      const fd = openSync(logPath, "r");
      try {
        const buf = Buffer.alloc(MAX_LOG_BYTES);
        const offset = stat.size - MAX_LOG_BYTES;
        let total = 0;
        while (total < MAX_LOG_BYTES) {
          const n = readSync(
            fd,
            buf,
            total,
            MAX_LOG_BYTES - total,
            offset + total,
          );
          if (n === 0) break;
          total += n;
        }
        return buf.subarray(0, total).toString("utf8");
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
    } catch {
      return null;
    }
  }

  logFreshness(
    _sessionName: string,
    worktreePath: string,
    spawnedAt: string,
  ): string {
    // The log mtime is the freshness signal: stale-kill fires when the
    // most recent output is older than `staleness_threshold_seconds`. For
    // a freshly spawned worker that hasn't written anything yet, no log
    // file exists; fall back to spawned_at so the freshness window starts
    // from spawn (not from epoch).
    const logPath = join(worktreePath, SESSION_LOG_FILE);
    let stat;
    try {
      stat = statSync(logPath);
    } catch {
      return spawnedAt;
    }
    // Empty log file (pipe-pane created it but nothing has been printed
    // yet): same case as "no log yet" — use spawned_at as the floor.
    if (stat.size === 0) return spawnedAt;
    return new Date(stat.mtimeMs).toISOString();
  }
}

// POSIX-shell single-quote escaping. Any single-quote in the input is closed,
// escaped with `'\''`, and reopened.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Files whose stale presence directly drives the bug the sweep exists to
// fix: `.quay-blocked.md` would be ingested as the new attempt's blocker;
// `.quay-session.log` would mix old bytes into the new attempt's log and
// skew the mtime-based freshness signal. Failing to remove either of
// these is treated as a hard spawn failure so the spawn-substrate-failed
// path takes over (same semantics as a `pipe-pane` failure) — silently
// proceeding would reintroduce the exact bug this sweep prevents.
const SWEEP_FAIL_CLOSED = new Set([".quay-blocked.md", ".quay-session.log"]);

// Remove every direct child of `worktreePath` whose name starts with the
// `.quay-` prefix. The two files in `SWEEP_FAIL_CLOSED` are required
// removals (see comment above); other `.quay-*` entries are best-effort
// — a leftover forensic dump or future marker shouldn't refuse to spawn,
// since proceeding does not reintroduce the original bug for those.
//
// `readdirSync` failure (worktree missing / unreadable) returns early:
// the subsequent `writeFileSync(promptFile, ...)` will fail with the
// same root cause and produce a clearer error than this preflight could.
function sweepQuayState(worktreePath: string): void {
  let entries: string[];
  try {
    entries = readdirSync(worktreePath);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(QUAY_STATE_PREFIX)) continue;
    const path = join(worktreePath, name);
    try {
      // recursive+force in case a future feature drops a `.quay-*`
      // directory. For today's flat files, `force: true` makes us
      // idempotent against entries that were swept by a concurrent
      // process — those produce no error and are not mistaken for the
      // unremovable case below.
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      if (SWEEP_FAIL_CLOSED.has(name)) {
        throw new Error(
          `tmux spawn aborted: failed to sweep stale ${name} from ${worktreePath}: ${(err as Error).message}`,
        );
      }
      // Non-critical leak — continue sweeping siblings.
    }
  }
}

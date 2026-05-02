// Supervisor lock abstraction (per spec §5 "Concurrency policy").
//
// Two implementations:
//
//   - `InProcessSupervisorLock`: a single-process Mutex used by tests and any
//     single-process call sites. Throws on reentrant `run()` so a buggy nested
//     call doesn't silently allow two side-effect paths to interleave.
//
//   - `FileSupervisorLock`: PID-aware lockfile (`tick_lock_path`) used by the
//     production CLI. Two `quay tick` invocations or a `quay tick` racing a
//     `quay cancel` cannot concurrently spawn tmux, post Slack, or run cancel
//     cleanup, because every supervisor-side-effect path acquires this lock.
//
// API:
//   - `run(fn)` — block until the lock is acquired (cancel uses this; spec §5
//     allows it to wait at most ~one tick duration before stale-PID takeover).
//   - `tryRun(fn)` — return `{ acquired: false }` immediately if the lock is
//     held by another live process; otherwise run `fn` under the lock. Tick
//     uses this so a second tick fired while one is in flight exits cleanly
//     without action (spec §5 "the new tick exits immediately without
//     action").
//
// Stale-PID takeover: if the recorded PID is no longer alive AND the lock is
// older than `staleSeconds` (default `supervisor_lock_stale_seconds` = 30),
// the next acquirer reclaims the file. This bounds the worst case of a
// hung-then-killed tick blocking `quay cancel` indefinitely.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface SupervisorLock {
  // Acquire the lock, blocking the calling thread until acquired (or a stale
  // owner is reclaimed). Throws if the same lock instance is already held by
  // this process — that's a programmer error, never expected at runtime.
  run<T>(fn: () => T): T;
  // Try to acquire the lock. If another live owner holds it, do not run `fn`
  // and return `{ acquired: false }`. Otherwise run `fn` under the lock and
  // return `{ acquired: true, value }`.
  tryRun<T>(fn: () => T): TryRunResult<T>;
}

export type TryRunResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

export class InProcessSupervisorLock implements SupervisorLock {
  private held = false;

  run<T>(fn: () => T): T {
    if (this.held) {
      throw new Error("supervisor lock is already held in this process");
    }
    this.held = true;
    try {
      return fn();
    } finally {
      this.held = false;
    }
  }

  tryRun<T>(fn: () => T): TryRunResult<T> {
    if (this.held) return { acquired: false };
    this.held = true;
    try {
      return { acquired: true, value: fn() };
    } finally {
      this.held = false;
    }
  }
}

interface LockfilePayload {
  pid: number;
  taken_at_ms: number;
}

export interface FileSupervisorLockOptions {
  // Path to the lockfile, e.g. `${data_dir}/tick.lock` (spec §11).
  lockfilePath: string;
  // Grace period (seconds) after which a lockfile whose owning PID is no
  // longer alive is considered stale and reclaimable. Default 30 (spec
  // `supervisor_lock_stale_seconds`).
  staleSeconds?: number;
  // Polling interval (ms) for the blocking `run()` mode. Default 100.
  pollIntervalMs?: number;
  // Hooks for tests — never set in production. `now()` controls staleness
  // arithmetic; `isAlive(pid)` controls whether a recorded PID counts as a
  // live owner; `sleep(ms)` controls how `run()` polls between attempts.
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
}

export class FileSupervisorLock implements SupervisorLock {
  private heldBy = false;
  private readonly lockfilePath: string;
  private readonly staleMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => void;

  constructor(opts: FileSupervisorLockOptions) {
    this.lockfilePath = opts.lockfilePath;
    this.staleMs = (opts.staleSeconds ?? 30) * 1000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.now = opts.now ?? (() => Date.now());
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.sleep = opts.sleep ?? defaultBlockingSleep;
  }

  run<T>(fn: () => T): T {
    if (this.heldBy) {
      throw new Error("supervisor lock is already held in this process");
    }
    for (;;) {
      if (this.tryAcquire()) break;
      this.sleep(this.pollIntervalMs);
    }
    this.heldBy = true;
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  tryRun<T>(fn: () => T): TryRunResult<T> {
    if (this.heldBy) return { acquired: false };
    if (!this.tryAcquire()) return { acquired: false };
    this.heldBy = true;
    try {
      return { acquired: true, value: fn() };
    } finally {
      this.release();
    }
  }

  // Atomic file-create-or-takeover. Returns true iff this call now owns the
  // lockfile (i.e. the file's content is our PID + taken_at).
  private tryAcquire(): boolean {
    if (this.createExclusive()) return true;
    // File exists; inspect it.
    const existing = this.readPayload();
    if (existing === null) {
      // Unparseable / missing payload. Can't tell if it's stale; refuse to
      // take over silently — operator action required to clear it.
      return false;
    }
    if (this.isAlive(existing.pid)) {
      // The recorded owner's PID still resolves to a live process. Includes
      // the same-PID case (another lock instance in this process holds it,
      // or after PID reuse). The grace window does not short-circuit a
      // live owner — that's the whole point of the lock.
      return false;
    }
    // Owner is dead. Honor the grace window so a slow operator killing a
    // hung tick can't be raced by an immediate takeover before they finish.
    if (this.now() - existing.taken_at_ms < this.staleMs) return false;
    return this.takeover(existing);
  }

  // Try `O_CREAT | O_EXCL` write. Returns true if we created the file (and
  // thus own the lock). Returns false if the file already exists. Anything
  // else throws.
  private createExclusive(): boolean {
    mkdirSync(dirname(this.lockfilePath), { recursive: true });
    let fd: number;
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY. Atomic against concurrent acquires.
      fd = openSync(this.lockfilePath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writePayload(fd, { pid: process.pid, taken_at_ms: this.now() });
    } finally {
      closeSync(fd);
    }
    return true;
  }

  // Atomic stale-lock takeover.
  //
  // The naive `unlink + create` sequence admits double-acquire under
  // contention: two acquirers each unlink the stale file, each then
  // `createExclusive` succeeds against the empty path, and both believe
  // they own the lock.
  //
  // Instead we use `rename(2)` of the stale lockfile to a per-acquirer
  // tombstone path. POSIX rename is atomic on the source: when N acquirers
  // concurrently rename the same source path to N different destinations,
  // exactly one rename succeeds — the others observe `ENOENT` because the
  // source has already been moved. The rename winner is the unique
  // takeover.
  //
  // We additionally verify that the file we just claimed (now at the
  // tombstone) carries the payload we read before deciding to take over.
  // If it doesn't, a different concurrent takeover slipped between our
  // read and our rename and created a fresh lock that we then captured.
  // We attempt to put it back; if that fails (a third acquirer has now
  // created a lockfile), we leave the tombstone behind and bail. The new
  // legitimate owner is undisturbed.
  private takeover(expected: LockfilePayload): boolean {
    const tombstone = `${this.lockfilePath}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      renameSync(this.lockfilePath, tombstone);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw err;
    }
    const claimed = readPayloadFromPath(tombstone);
    const matches =
      claimed !== null &&
      claimed.pid === expected.pid &&
      claimed.taken_at_ms === expected.taken_at_ms;
    if (!matches) {
      // We captured a fresh lock that was not the stale one we observed.
      // Try to restore it so the legitimate owner's release sees its file
      // intact. If the canonical path is now occupied, leave the tombstone
      // — best-effort cleanup; the new owner is unaffected.
      try {
        renameSync(tombstone, this.lockfilePath);
      } catch {
        // Best effort.
      }
      return false;
    }
    // Drop the (verified-stale) tombstone and create our own lock.
    try {
      unlinkSync(tombstone);
    } catch {}
    return this.createExclusive();
  }

  private readPayload(): LockfilePayload | null {
    return readPayloadFromPath(this.lockfilePath);
  }

  private release(): void {
    this.heldBy = false;
    if (!existsSync(this.lockfilePath)) return;
    // Only delete the file if it's still ours. A stale-takeover by another
    // acquirer between fn() ending and release() running is exceedingly
    // unlikely, but if it happens we must not delete their lock.
    const current = this.readPayload();
    if (current === null) return;
    if (current.pid !== process.pid) return;
    try {
      unlinkSync(this.lockfilePath);
    } catch {
      // best-effort; the next acquirer's stale-PID logic recovers anyway.
    }
  }
}

function writePayload(fd: number, payload: LockfilePayload): void {
  const body = JSON.stringify(payload);
  writeFileSync(fd, body, { encoding: "utf8" });
}

function readPayloadFromPath(path: string): LockfilePayload | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
    const takenAt =
      typeof parsed.taken_at_ms === "number"
        ? parsed.taken_at_ms
        : Number(parsed.taken_at_ms);
    if (!Number.isFinite(pid) || !Number.isFinite(takenAt)) return null;
    return { pid, taken_at_ms: takenAt };
  } catch {
    return null;
  }
}

function defaultIsAlive(pid: number): boolean {
  // `kill(pid, 0)` is the POSIX existence probe — sends no signal, throws
  // ESRCH when the process is gone. EPERM means it exists but we can't
  // signal it; that still counts as "alive."
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function defaultBlockingSleep(ms: number): void {
  // Synchronous sleep so the poll loop matches the synchronous `run(fn)`
  // contract. `Atomics.wait` on a fresh SharedArrayBuffer is the standard
  // cross-runtime synchronous sleep that doesn't pin a CPU.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

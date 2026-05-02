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
  rmdirSync,
  statSync,
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
  // Grace window (ms) after which a takeover-mutex whose owner PID is no
  // longer alive may be reclaimed by a contending acquirer. The mutex
  // directory records the owner PID + acquired-at timestamp inside an
  // `owner.json` file; reclaim is conditioned on `!isAlive(owner.pid)`
  // AND `(now - owner.taken_at_ms) >= staleMutexMs`. Age alone is NOT
  // sufficient — that would allow a paused-but-alive holder (long GC,
  // page fault, debugger) to be stripped of its mutex while it's still
  // about to write to the lockfile. Default 5000 ms.
  staleMutexMs?: number;
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
  private readonly staleMutexMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => void;

  constructor(opts: FileSupervisorLockOptions) {
    this.lockfilePath = opts.lockfilePath;
    this.staleMs = (opts.staleSeconds ?? 30) * 1000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.staleMutexMs = opts.staleMutexMs ?? 5_000;
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

  // Stale-lock takeover, race-free against an arbitrary number of
  // contending acquirers.
  //
  // Earlier protocol attempts moved the canonical lockfile out of the way
  // (rename to a tombstone) so its content could be inspected. That
  // admitted a three-acquirer race: A reads stale; B takes over and
  // starts running with a fresh lock; A then renames B's fresh lock into
  // a tombstone during mismatch handling, exposing the empty canonical
  // path; a third acquirer C `createExclusive`s before A restores. B and
  // C both end up running.
  //
  // The robust solution is to never empty the canonical path during
  // takeover, AND to serialize takeovers so they cannot interleave.
  //
  // Protocol:
  //
  //   1. Acquire a mkdir-based mutex (`${lockfilePath}.takeover-mutex`).
  //      `mkdir(2)` is atomic on POSIX — exactly one of N concurrent
  //      acquirers wins; the others observe EEXIST. Stale mutex
  //      directories (process crashed mid-takeover) are reclaimed via an
  //      mtime age check, bounded by `staleMutexMs`.
  //
  //   2. Under the mutex, re-read the canonical lockfile. If its payload
  //      no longer matches the `expected` stale payload we observed
  //      before deciding to take over, another takeover slipped in just
  //      before we got the mutex. Bail — caller re-polls.
  //
  //   3. Write the new payload to a scratch file in the same directory
  //      (so `rename` stays within one filesystem and is therefore
  //      atomic), then `renameSync(scratch, canonical)`. POSIX rename
  //      atomically replaces the destination. Because we hold the
  //      mutex, no other takeover can be doing the same; because the
  //      canonical path always has a file (we replace, never empty), no
  //      first-acquire `createExclusive` can succeed against it. The
  //      replacement is fully serialized.
  //
  //   4. Release the mutex.
  private takeover(expected: LockfilePayload): boolean {
    const mutexDir = `${this.lockfilePath}.takeover-mutex`;
    if (!this.acquireTakeoverMutex(mutexDir)) return false;
    try {
      const current = readPayloadFromPath(this.lockfilePath);
      if (current === null) return false;
      if (
        current.pid !== expected.pid ||
        current.taken_at_ms !== expected.taken_at_ms
      ) {
        // Another takeover slipped in between our pre-mutex read and our
        // mutex acquire. The new payload may or may not be stale; let the
        // caller re-poll and reassess from scratch.
        return false;
      }
      const scratch = `${this.lockfilePath}.takeover-scratch-${process.pid}-${randomBytes(6).toString("hex")}`;
      writeFileSync(
        scratch,
        JSON.stringify({ pid: process.pid, taken_at_ms: this.now() }),
      );
      try {
        renameSync(scratch, this.lockfilePath);
      } catch (err) {
        try {
          unlinkSync(scratch);
        } catch {}
        throw err;
      }
      // Defense-in-depth: if for any reason another acquirer reclaimed
      // our mutex and ran their own takeover before we resumed, our
      // rename may have clobbered their lock. Re-read the mutex owner
      // — if it's no longer us, log/raise so the caller surfaces the
      // bug rather than silently double-owning. With PID-liveness
      // reclaim this should be unreachable for an alive process; leave
      // the check in place because the cost is one stat.
      const ownerNow = readPayloadFromPath(mutexOwnerPath(mutexDir));
      if (ownerNow === null || ownerNow.pid !== process.pid) {
        throw new Error(
          `supervisor lock takeover detected mutex theft (mutex owner is ${ownerNow?.pid ?? "missing"}, expected ${process.pid}); manual recovery required`,
        );
      }
      return true;
    } finally {
      // Cleanup: drop owner file then mutex dir. Best-effort; another
      // acquirer's stale-mutex recovery may have removed them already.
      try {
        unlinkSync(mutexOwnerPath(mutexDir));
      } catch {}
      try {
        rmdirSync(mutexDir);
      } catch {}
    }
  }

  // mkdir-based mutex acquire with PID-liveness stale recovery.
  //
  // Returns true iff this call now owns the mutex. The mutex directory
  // contains an `owner.json` file written immediately after the mkdir;
  // contending acquirers read that file to decide whether the mutex is
  // legitimately held or reclaimable.
  //
  // Reclaim is conditioned on:
  //   `!isAlive(owner.pid) && (now - owner.taken_at_ms) >= staleMutexMs`.
  //
  // Age alone is NOT sufficient — a paused-but-alive holder (long GC,
  // page fault, debugger pause) is still going to resume and finish its
  // takeover; reclaiming under it would let the resumed holder clobber
  // a fresh post-reclaim lock. The PID liveness check pins recovery to
  // the case the mutex was actually intended for: the holder process is
  // gone.
  //
  // The grace window is a transient-error guard: a one-shot blip in
  // `isAlive` (e.g. EPERM during process namespace transitions) does
  // not immediately strip the mutex.
  private acquireTakeoverMutex(mutexDir: string): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(mutexDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (this.tryReclaimMutex(mutexDir)) continue;
        return false;
      }
      // We won the mkdir. Stamp ownership immediately so any contending
      // acquirer can identify us. There's a small window between mkdir
      // and this write where the directory exists but owner.json is
      // missing; contending acquirers handle that case by treating it
      // as "not yet stale, bail and re-poll." No race loss because the
      // outer caller polls.
      try {
        writeFileSync(
          mutexOwnerPath(mutexDir),
          JSON.stringify({
            pid: process.pid,
            taken_at_ms: this.now(),
          }),
        );
      } catch (err) {
        // If we can't stamp ownership, drop the mutex so we don't strand
        // it (no one can read our PID, so no one can reclaim it via the
        // dead-PID path).
        try {
          rmdirSync(mutexDir);
        } catch {}
        throw err;
      }
      return true;
    }
    return false;
  }

  // Examine an existing mutex; if its owner is dead beyond the grace
  // window, force-remove it. Returns true iff cleanup happened (caller
  // should retry mkdir); false iff the mutex is still held by a live
  // owner or within the grace window.
  private tryReclaimMutex(mutexDir: string): boolean {
    const owner = readPayloadFromPath(mutexOwnerPath(mutexDir));
    if (owner === null) {
      // The owner file may not have been written yet (winner is between
      // mkdir and writeFileSync). Use mtime as a loose upper bound on
      // how long that gap can last: if the mutex dir itself is older
      // than the grace window, the writer crashed mid-init.
      let stat;
      try {
        stat = statSync(mutexDir);
      } catch {
        // Directory disappeared between EEXIST and stat — caller should
        // retry mkdir.
        return true;
      }
      if (this.now() - stat.mtimeMs < this.staleMutexMs) return false;
      try {
        rmdirSync(mutexDir);
      } catch {}
      return true;
    }
    // Owner is recorded. Reclaim ONLY if the owner process is gone AND
    // we're past the grace window. A paused-but-alive holder is left
    // alone — they'll resume and finish.
    if (this.isAlive(owner.pid)) return false;
    if (this.now() - owner.taken_at_ms < this.staleMutexMs) return false;
    try {
      unlinkSync(mutexOwnerPath(mutexDir));
    } catch {}
    try {
      rmdirSync(mutexDir);
    } catch {}
    return true;
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

function mutexOwnerPath(mutexDir: string): string {
  // Owner-identity file inside the takeover-mutex directory. Contending
  // acquirers read it to decide PID-liveness reclaim. Kept as a separate
  // helper so tests can pre-populate it to simulate specific scenarios.
  return `${mutexDir}/owner.json`;
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

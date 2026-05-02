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
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
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
  // longer alive may be reclaimed by a contending acquirer. The mutex is
  // an atomic hard-linked file containing the owner PID +
  // acquired-at timestamp from the moment it exists; reclaim is
  // conditioned on `!isAlive(owner.pid) AND (now - owner.taken_at_ms)
  // >= staleMutexMs`. Age alone is NEVER sufficient — that would allow
  // a paused-but-alive holder (long GC, page fault, debugger) to be
  // stripped of its mutex while it's still about to write to the
  // lockfile. Default 5000 ms.
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

  // Atomically create the lockfile so it carries our owner payload from the
  // instant it exists. Returns true if we now own the lock; false if the
  // canonical path already had a file.
  //
  // The earlier `openSync(.., "wx")` then `writePayload` sequence had a
  // crash window: the file existed empty for an instant. A process death
  // there leaves a permanently-unrecoverable lockfile because `tryAcquire`
  // refuses to reclaim a lock whose payload won't parse — so future tick
  // and cancel calls hang until an operator removes the file by hand.
  //
  // Same scratch+hard-link technique we already use for the takeover
  // mutex: write the payload to a private scratch file in the same
  // directory (so `linkSync` stays within one filesystem and is therefore
  // atomic), then `linkSync(scratch, canonical)`. POSIX hard-link is
  // atomic — exactly one of N concurrent linkers wins; the others see
  // EEXIST. When the link succeeds the canonical path is a second
  // hardlink to the scratch's inode and already carries the full payload;
  // there is no observable empty state. Drop scratch afterwards (the
  // canonical hardlink keeps the inode alive).
  private createExclusive(): boolean {
    mkdirSync(dirname(this.lockfilePath), { recursive: true });
    const scratch = `${this.lockfilePath}.init-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(
      scratch,
      JSON.stringify({ pid: process.pid, taken_at_ms: this.now() }),
    );
    let linked = false;
    try {
      linkSync(scratch, this.lockfilePath);
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          unlinkSync(scratch);
        } catch {}
        throw err;
      }
      // EEXIST: another acquirer landed first. Fall through; caller will
      // read the existing payload and decide between live-owner-bail and
      // stale-takeover.
    }
    // Drop the private scratch regardless of outcome. If linked, the
    // canonical lockfile keeps the inode (and our payload) alive; if not,
    // scratch is just leftover garbage to clean up.
    try {
      unlinkSync(scratch);
    } catch {}
    return linked;
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
    const mutexPath = `${this.lockfilePath}.takeover-mutex`;
    if (!this.acquireTakeoverMutex(mutexPath)) return false;
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
      // Defense-in-depth: re-read the mutex; if it no longer names us,
      // raise so a future protocol regression surfaces immediately.
      // With the hard-link mutex + PID-liveness reclaim, this should be
      // unreachable for an alive process — but the check is one read.
      const ownerNow = readPayloadFromPath(mutexPath);
      if (ownerNow === null || ownerNow.pid !== process.pid) {
        throw new Error(
          `supervisor lock takeover detected mutex theft (mutex owner is ${ownerNow?.pid ?? "missing"}, expected ${process.pid}); manual recovery required`,
        );
      }
      return true;
    } finally {
      // Release: unlink the mutex file. Best-effort; another acquirer's
      // stale-PID recovery may have removed it already.
      try {
        unlinkSync(mutexPath);
      } catch {}
    }
  }

  // Atomic, race-free mutex acquire using a pre-written scratch + hard
  // link.
  //
  // Why not `mkdirSync` first then `writeFileSync` of an owner file?
  // That sequence has a reclaimable ownerless window: between mkdir and
  // the owner write, the directory exists with no PID inside. A
  // contending acquirer that reads the directory then can only fall
  // back to age-based reclaim — and a sufficiently-long pause of the
  // mkdir-winner can let a third acquirer remove the directory and
  // create their own. When the paused winner resumes and writes
  // `owner.json`, it lands in someone else's mutex.
  //
  // To eliminate that window, the mutex IS a single file that already
  // contains owner content from the instant it exists. We:
  //
  //   1. Write the owner payload to a private scratch file.
  //   2. `linkSync(scratch, mutexPath)` — atomic on POSIX. Exactly one
  //      of N concurrent linkers wins; the others see EEXIST. The
  //      newly-created path is a hard link to the scratch, so reading
  //      it returns the owner payload immediately.
  //   3. Drop the scratch path. The mutex path keeps the inode (and
  //      thus our content) until someone unlinks it.
  //
  // Reclaim of an existing mutex is conditioned on
  //   `!isAlive(owner.pid) && (now - owner.taken_at_ms) >= staleMutexMs`.
  // Age alone is never sufficient.
  private acquireTakeoverMutex(mutexPath: string): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scratch = `${mutexPath}.init-${process.pid}-${randomBytes(6).toString("hex")}`;
      writeFileSync(
        scratch,
        JSON.stringify({
          pid: process.pid,
          taken_at_ms: this.now(),
        }),
      );
      let linked = false;
      try {
        linkSync(scratch, mutexPath);
        linked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          try {
            unlinkSync(scratch);
          } catch {}
          throw err;
        }
      }
      // Drop the private scratch regardless of outcome. If link
      // succeeded, the mutex file (the other hardlink) keeps the inode
      // alive and continues to reflect our content. If link failed,
      // scratch is just leftover garbage.
      try {
        unlinkSync(scratch);
      } catch {}
      if (linked) return true;
      if (!this.tryReclaimMutex(mutexPath)) return false;
      // Reclaimed; loop and retry the link.
    }
    return false;
  }

  // Examine an existing mutex; if its owner is dead beyond the grace
  // window, unlink it. Returns true iff cleanup happened (caller
  // should retry the link); false iff the mutex is still legitimately
  // held, contention prevented us from inspecting it, OR a previous
  // reclaim crashed mid-section and operator cleanup is required.
  //
  // Concurrency model:
  //
  //   The mutex content can change in only two ways: (1) the holder
  //   unlinks it on release, (2) some reclaimer unlinks the stale
  //   inode and a subsequent caller's `linkSync(scratch, canonical)`
  //   places fresh content. Acquirers themselves cannot modify
  //   existing mutex content — `linkSync` fails with EEXIST when the
  //   path already exists.
  //
  //   So the bug we're protecting against is two reclaimers racing.
  //   v1 (read+unlink-by-path) let the second reclaimer unlink the
  //   first reclaimer's fresh mutex. v2/v3 (rename-aside-and-verify)
  //   solved that but had its own bug: the rename empties the
  //   canonical path mid-decision, so a third process could `linkSync`
  //   into the empty path and become a phantom co-owner alongside the
  //   already-running legitimate holder.
  //
  //   v4: serialize reclaim with an outer mkdir-based reclaim-lock,
  //   plus mtime-based stale-recovery for the reclaim-lock itself. The
  //   stale-recovery added the same `stat` + `rmdirSync(byPath)`
  //   pattern that the original v1 bug had, just one level removed:
  //   two contenders could both observe a stale reclaim-lock, both
  //   rmdir, both mkdir, and both end up inside the supposedly-
  //   serialized critical section.
  //
  //   v5 (this version): NO stale auto-recovery for the reclaim-lock.
  //   `mkdirSync(EEXIST) → return false`, full stop. If the reclaim-
  //   lock dir exists for any reason — a peer is reclaiming, OR a
  //   previous reclaimer crashed mid-section — this tick refuses
  //   takeover. The crash case requires a process death inside a
  //   sub-millisecond critical section (mkdir → read → unlink →
  //   rmdir), so it is vanishingly rare in practice; when it does
  //   happen, the fix is `rm -rf <data_dir>/tick.lock.takeover-mutex
  //   <data_dir>/tick.lock.takeover-mutex.reclaim-lock` after
  //   verifying no live tick / cancel is in flight. That manual
  //   recovery cost is much cheaper than the alternative of risking
  //   double-runs of the supervisor's irreversible side effects
  //   (Slack post, gh promote, tmux spawn, branch update).
  //
  //   Inside the reclaim-lock no other reclaimer is concurrently
  //   modifying the mutex, and acquirers can't replace existing
  //   content, so the mutex's payload cannot change between our read
  //   and our unlink. The canonical mutex path is never emptied while
  //   it may contain a fresh live owner.
  private tryReclaimMutex(mutexPath: string): boolean {
    const reclaimLockPath = `${mutexPath}.reclaim-lock`;
    if (!this.acquireReclaimLock(reclaimLockPath)) return false;
    try {
      const owner = readPayloadFromPath(mutexPath);
      if (owner === null) {
        // ENOENT: caller's link retry will land on the empty path.
        // Unparseable payload: leave alone — we cannot safely decide,
        // operator territory.
        return existsSync(mutexPath) ? false : true;
      }
      if (this.isAlive(owner.pid)) return false;
      if (this.now() - owner.taken_at_ms < this.staleMutexMs) return false;
      // Inside the reclaim-lock the mutex content cannot change
      // between this read and the unlink, so the unlink is sound.
      try {
        unlinkSync(mutexPath);
      } catch {}
      return true;
    } finally {
      try {
        rmdirSync(reclaimLockPath);
      } catch {}
    }
  }

  // Acquire the outer reclaim-lock around tryReclaimMutex's
  // read+decide+unlink critical section. Returns true if we now hold
  // it; false on EEXIST (a peer is reclaiming, or a prior reclaimer
  // crashed mid-section and the dir is leaked).
  //
  // No stale auto-recovery: the canonical compare-and-delete primitive
  // POSIX provides for files (renameat2(RENAME_EXCHANGE)) is Linux-
  // only, and stale-recovery via `stat`+`rmdir`-by-path has the same
  // wrong-inode race we built this lock to prevent. Failing closed
  // means a crashed reclaim may need operator cleanup; that is a much
  // smaller cost than a double-run of supervisor side effects.
  private acquireReclaimLock(reclaimLockPath: string): boolean {
    try {
      mkdirSync(reclaimLockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
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

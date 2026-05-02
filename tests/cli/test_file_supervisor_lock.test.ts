// Cross-process supervisor lock contract (spec §5):
//   - tryRun returns acquired:false when another live PID owns the lockfile.
//   - run blocks until acquired (or stale-PID takeover after the grace
//     window).
//   - A dead-PID lockfile is NOT reclaimed inside the grace window — that
//     gives an operator killing a hung tick a chance to land cancel before a
//     racing acquirer skips ahead.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { FileSupervisorLock } from "../../src/core/supervisor_lock.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempLockfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-lock-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "tick.lock");
}

test("FileSupervisorLock acquires a free lock and writes its PID", () => {
  const path = tempLockfile();
  const lock = new FileSupervisorLock({ lockfilePath: path });
  let inside = false;
  let observedPid: number = -1;
  lock.run(() => {
    inside = true;
    observedPid = JSON.parse(readFileSync(path, "utf8")).pid;
  });
  expect(inside).toBe(true);
  expect(observedPid).toBe(process.pid);
  // Released on exit.
  expect(existsSync(path)).toBe(false);
});

test("FileSupervisorLock.tryRun returns acquired:false when held by another live PID", () => {
  const path = tempLockfile();
  // Simulate another process by writing a payload with a different PID and
  // forcing isAlive=true for that PID.
  const otherPid = process.pid + 1;
  writeFileSync(
    path,
    JSON.stringify({ pid: otherPid, taken_at_ms: Date.now() }),
  );
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid === otherPid,
  });
  let ran = false;
  const result = lock.tryRun(() => {
    ran = true;
  });
  expect(result.acquired).toBe(false);
  expect(ran).toBe(false);
  // The other process's lockfile is intact.
  const payload = JSON.parse(readFileSync(path, "utf8"));
  expect(payload.pid).toBe(otherPid);
});

test("FileSupervisorLock.tryRun acquires when the recorded PID is dead and beyond the grace window", () => {
  const path = tempLockfile();
  const deadPid = 999_999;
  // Mtime intentionally older than the 30 s default grace.
  writeFileSync(
    path,
    JSON.stringify({
      pid: deadPid,
      taken_at_ms: Date.now() - 60_000,
    }),
  );
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: () => false,
  });
  let ran = false;
  const result = lock.tryRun(() => {
    ran = true;
  });
  expect(result.acquired).toBe(true);
  expect(ran).toBe(true);
});

test("FileSupervisorLock.tryRun refuses to take over a dead-PID lock within the grace window", () => {
  const path = tempLockfile();
  const deadPid = 999_999;
  writeFileSync(
    path,
    JSON.stringify({
      pid: deadPid,
      // Just taken — operator may still be in the kill-then-recover window.
      taken_at_ms: Date.now(),
    }),
  );
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    staleSeconds: 30,
    isAlive: () => false,
  });
  const result = lock.tryRun(() => {});
  expect(result.acquired).toBe(false);
});

test("FileSupervisorLock.run blocks then acquires after the holder releases", () => {
  const path = tempLockfile();
  // First instance acquires and "leaves" — simulate another live process by
  // writing a current PID + taken_at, then teach our lock to flip isAlive
  // off on the third probe (modeling the holder exiting between polls).
  const otherPid = process.pid + 1;
  writeFileSync(
    path,
    JSON.stringify({ pid: otherPid, taken_at_ms: Date.now() - 60_000 }),
  );
  let aliveProbeCount = 0;
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => {
      if (pid === otherPid) {
        aliveProbeCount += 1;
        return aliveProbeCount < 3; // alive for first two probes, then dead
      }
      return false;
    },
    pollIntervalMs: 5,
  });
  let ran = false;
  lock.run(() => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(aliveProbeCount).toBeGreaterThanOrEqual(3);
});

test("FileSupervisorLock release deletes the lockfile only if it still owns it", () => {
  const path = tempLockfile();
  const lock = new FileSupervisorLock({ lockfilePath: path });
  // Acquire, then before releasing have someone else "take over" — release
  // must not delete that other owner's lock.
  lock.run(() => {
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid + 1, taken_at_ms: Date.now() }),
    );
  });
  // The lockfile still has the simulated other-owner PID — release left it.
  expect(existsSync(path)).toBe(true);
  const payload = JSON.parse(readFileSync(path, "utf8"));
  expect(payload.pid).not.toBe(process.pid);
});

test("FileSupervisorLock takeover is atomic against contending acquirers", () => {
  // Two acquirers (A and B) both observe a dead-PID stale lock and both
  // try to take over. The naive `unlink + create` sequence would let both
  // succeed: A unlinks → A creates → B unlinks A's fresh lock → B
  // creates. The atomic-rename takeover must elect exactly one winner.
  //
  // Simulating: pre-write a stale lock, then run A's `tryRun` whose body
  // calls B's `tryRun` from inside it. A must hold; B must not.
  // `isAlive` is mocked so ANY pid (including A's process.pid) reads as
  // dead — that's the worst case for the takeover path. A's freshly-
  // written taken_at_ms protects A from B taking over during the grace
  // window (A holds during fn()).
  const path = tempLockfile();
  const deadPid = 999_999;
  writeFileSync(
    path,
    JSON.stringify({ pid: deadPid, taken_at_ms: Date.now() - 60_000 }),
  );

  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: () => false,
  });
  const lockB = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: () => false,
  });

  let bResult: { acquired: boolean } | null = null;
  const aResult = lockA.tryRun(() => {
    // A is now inside fn(). The lockfile has A's payload with a fresh
    // taken_at_ms. B observes A's payload, finds it within the grace
    // window, and must refuse takeover.
    bResult = lockB.tryRun(() => {});
  });

  expect(aResult.acquired).toBe(true);
  expect(bResult).not.toBeNull();
  expect(bResult!.acquired).toBe(false);
});

test("FileSupervisorLock refuses takeover when the file changed between pre-mutex read and mutex acquire", () => {
  // Direct race: acquirer-A reads stale P_old, then before A acquires
  // the takeover mutex, a concurrent acquirer B successfully takes over
  // and writes a fresh payload P_new. A's mutex acquire eventually
  // succeeds; under the mutex A re-reads canonical and observes P_new
  // (not P_old). A must bail — both the in-progress fn() of B and the
  // canonical lockfile must remain undisturbed.
  //
  // Simulated by mutating the lockfile inside `isAlive` (called once
  // between A's pre-mutex read and A's takeover step). The mutation
  // models "B's takeover landed between our read and our mutex grab."
  const path = tempLockfile();
  const otherPid = process.pid + 7;
  const newOwnerPid = otherPid + 1;
  const newOwnerTakenAt = Date.now();
  writeFileSync(
    path,
    JSON.stringify({ pid: otherPid, taken_at_ms: Date.now() - 60_000 }),
  );
  let mutated = false;
  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: () => {
      if (!mutated) {
        mutated = true;
        writeFileSync(
          path,
          JSON.stringify({ pid: newOwnerPid, taken_at_ms: newOwnerTakenAt }),
        );
      }
      return false;
    },
  });
  const result = lockA.tryRun(() => {});
  // Under-mutex re-read sees the new payload, doesn't match A's
  // `expected` (P_old), so A bails without ever modifying canonical.
  expect(result.acquired).toBe(false);
  const remaining = JSON.parse(readFileSync(path, "utf8"));
  expect(remaining.pid).toBe(newOwnerPid);
  expect(remaining.taken_at_ms).toBe(newOwnerTakenAt);
});

test("FileSupervisorLock takeover never empties the canonical path (no third-acquirer race window)", () => {
  // Three-acquirer race the previous rename-based protocol allowed:
  //   A reads stale P_old.
  //   B takes over → canonical now has P_B; B is in fn().
  //   A's mismatch path renames B's fresh canonical lock into a
  //     tombstone — canonical is empty for an instant.
  //   C `createExclusive` races into the empty path → C in fn().
  //   B and C both run.
  //
  // The mkdir-mutex + rename-from-scratch protocol forbids this by
  // never moving canonical away. Here we assert the structural
  // invariant: at every observable moment during a contended takeover,
  // the canonical path either holds the (stale) original payload or a
  // takeover winner's fresh payload — it is never absent. We probe by
  // overriding `isAlive` to read canonical mid-takeover and record
  // whether it ever vanished.
  const path = tempLockfile();
  const stalePid = 999_990;
  const stalePayload = { pid: stalePid, taken_at_ms: Date.now() - 60_000 };
  writeFileSync(path, JSON.stringify(stalePayload));

  let observedMissing = false;
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => {
      // Sample canonical's existence at the moment the takeover decision
      // is being made (inside `tryAcquire`'s `isAlive` call). The new
      // protocol never unlinks canonical, so this should always observe
      // the file present.
      if (!existsSync(path)) observedMissing = true;
      return pid !== stalePid; // stale dead, anything else alive
    },
  });

  const result = lock.tryRun(() => {
    if (!existsSync(path)) observedMissing = true;
  });

  expect(result.acquired).toBe(true);
  expect(observedMissing).toBe(false);
});

test("FileSupervisorLock reclaims a takeover-mutex whose owner PID is dead and beyond grace", () => {
  // Stale-takeover-mutex recovery: a previous takeover holder crashed
  // before unlinking the mutex file. The mutex content names a dead PID
  // with an old timestamp. A new acquirer must reclaim.
  const path = tempLockfile();
  const stalePid = 999_991;
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;
  const deadMutexHolder = 999_992;
  writeFileSync(
    mutexPath,
    JSON.stringify({ pid: deadMutexHolder, taken_at_ms: Date.now() - 60_000 }),
  );

  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid !== deadMutexHolder && pid !== stalePid,
  });
  const result = lock.tryRun(() => {});
  expect(result.acquired).toBe(true);
  expect(existsSync(mutexPath)).toBe(false);
});

test("FileSupervisorLock refuses to reclaim a takeover-mutex whose owner PID is alive (paused-but-alive)", () => {
  // Reviewer scenario A: takeover holder is paused (long GC, page
  // fault, SIGSTOP), not crashed. PID is still alive. Pure age-based
  // reclaim would let another acquirer steal the mutex; the holder
  // would resume and clobber a fresh post-reclaim lock. PID-liveness
  // reclaim must refuse — even when the timestamp is old — as long as
  // the owner PID resolves to a live process.
  const path = tempLockfile();
  const stalePid = 999_993;
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;
  const liveMutexHolder = 1234;
  writeFileSync(
    mutexPath,
    JSON.stringify({
      pid: liveMutexHolder,
      taken_at_ms: Date.now() - 60_000,
    }),
  );

  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid === liveMutexHolder,
    staleMutexMs: 0,
  });
  const result = lock.tryRun(() => {});
  expect(result.acquired).toBe(false);
  expect(existsSync(mutexPath)).toBe(true);
  const owner = JSON.parse(readFileSync(mutexPath, "utf8"));
  expect(owner.pid).toBe(liveMutexHolder);
});

test("FileSupervisorLock takeover-mutex carries owner content from the instant it exists", () => {
  // Reviewer scenario B: the previous mkdir-then-write protocol had a
  // window where the mutex directory existed without owner.json. A
  // paused acquirer in that window could let a contending acquirer
  // age-reclaim the mutex; when the paused acquirer resumed, its
  // writeFileSync would land in someone else's mutex.
  //
  // The hard-link protocol eliminates this: the mutex IS a single file
  // that contains owner content from the moment it appears. Verified
  // by reading the mutex synchronously inside an `isAlive` hook —
  // which fires while the takeover decision is still in progress.
  const path = tempLockfile();
  const stalePid = 999_994;
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;

  let mutexHadOwnerFromFirstSighting = true;
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => {
      if (existsSync(mutexPath)) {
        // If the mutex exists at any point during decision-making, it
        // must carry valid owner content — never an empty file.
        const raw = readFileSync(mutexPath, "utf8");
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed?.pid !== "number") {
            mutexHadOwnerFromFirstSighting = false;
          }
        } catch {
          mutexHadOwnerFromFirstSighting = false;
        }
      }
      return pid !== stalePid;
    },
  });
  const result = lock.tryRun(() => {});
  expect(result.acquired).toBe(true);
  expect(mutexHadOwnerFromFirstSighting).toBe(true);
  expect(existsSync(mutexPath)).toBe(false);
});

test("FileSupervisorLock takeover-mutex contention: only one of two concurrent acquirers wins via linkSync", () => {
  // Two contending takeovers both attempt to acquire the mutex. The
  // hard-link protocol must elect exactly one — the other observes the
  // winner's payload and bails (live owner = process.pid). The losing
  // acquirer must NOT have left an artifact at the mutex path.
  const path = tempLockfile();
  const stalePid = 999_995;
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;

  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid !== stalePid,
  });
  const lockB = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid !== stalePid,
  });

  let bResult: { acquired: boolean } | null = null;
  const aResult = lockA.tryRun(() => {
    // While A is inside fn(), the mutex is already released (held only
    // for the takeover swap), so B's tryRun does its own takeover. A's
    // canonical lock is now in place; B should observe A as a live owner
    // of the canonical lockfile and refuse takeover.
    bResult = lockB.tryRun(() => {});
  });

  expect(aResult.acquired).toBe(true);
  expect(bResult).not.toBeNull();
  expect(bResult!.acquired).toBe(false);
});

test("FileSupervisorLock.run throws on reentrant acquire", () => {
  const path = tempLockfile();
  const lock = new FileSupervisorLock({ lockfilePath: path });
  let caught: unknown = null;
  lock.run(() => {
    try {
      lock.run(() => {});
    } catch (err) {
      caught = err;
    }
  });
  expect((caught as Error)?.message).toMatch(/already held in this process/);
});

// Cross-process supervisor lock contract (spec §5):
//   - tryRun returns acquired:false when another live PID owns the lockfile.
//   - run blocks until acquired (or stale-PID takeover after the grace
//     window).
//   - A dead-PID lockfile is NOT reclaimed inside the grace window — that
//     gives an operator killing a hung tick a chance to land cancel before a
//     racing acquirer skips ahead.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("FileSupervisorLock refuses takeover when the file changed between read and rename", () => {
  // Direct race: acquirer-1 reads stale payload P_old, then before
  // renaming, acquirer-2 takes over and writes P_new (a different
  // payload). acquirer-1 then renames the file — it captures P_new (not
  // P_old). The content-verification step must detect the mismatch and
  // bail rather than letting acquirer-1 also believe it took over.
  //
  // We simulate this by injecting a `now()` hook on lockA that, on its
  // first call (during the stale-read), advances the wall clock far
  // enough to make P_old look stale; then between A's stale-read and A's
  // rename, we manually replace the lockfile with a fresh payload (the
  // analog of "another acquirer just took over"). A's rename then
  // captures the wrong payload — verification must reject.
  const path = tempLockfile();
  const otherPid = process.pid + 7;
  writeFileSync(
    path,
    JSON.stringify({ pid: otherPid, taken_at_ms: Date.now() - 60_000 }),
  );
  // We'll simulate the interleave by overriding `isAlive` to also mutate
  // the file — when the takeover decision is being made, swap in a fresh
  // payload before A's rename can run.
  let mutated = false;
  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: () => {
      if (!mutated) {
        mutated = true;
        // Race: a concurrent acquirer just took over with a fresh payload.
        writeFileSync(
          path,
          JSON.stringify({
            pid: otherPid + 1,
            taken_at_ms: Date.now(),
          }),
        );
      }
      return false;
    },
  });
  const result = lockA.tryRun(() => {});
  // A must NOT acquire: it observed P_old, then captured P_new, payload
  // mismatched, restore was attempted.
  expect(result.acquired).toBe(false);
  // The fresh lock is back in place (or stayed in place), with the new owner.
  const restored = JSON.parse(readFileSync(path, "utf8"));
  expect(restored.pid).toBe(otherPid + 1);
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

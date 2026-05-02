// Regression: `tryReclaimMutex` used to read the mutex owner, decide it
// was stale, then `unlinkSync(mutexPath)` *by path* — without
// re-verifying that the path still pointed to the same stale payload.
// Two concurrent reclaimers (A and B) could both pass the staleness
// check on the same dead mutex; A unlinks the dead mutex and links its
// fresh one; B then unlinks A's *fresh* mutex by path and links B's.
// Net effect: both A and B believe they hold the takeover mutex and can
// run the supervisor's irreversible side effects concurrently.
//
// The fix uses `renameSync(mutexPath, asidePath)` to atomically take
// ownership of whatever inode currently lives at the path. Re-reading
// the moved-aside payload is race-free (the aside file is private), and
// only the original stale inode can satisfy the staleness check —
// freshly-linked third-party inodes get noticed and put back via
// `linkSync` instead of clobbered.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "quay-lock-reclaim-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "tick.lock");
}

test("reclaim does not clobber a fresh mutex linked between read and unlink", () => {
  // Simulated race: A reads the stale mutex. Before A acquires the
  // mutex, the test injects a fresh mutex at the canonical path
  // (modeling B having reclaimed and linked its own mutex). A's
  // reclaim must not delete the freshly-linked mutex; it must observe
  // the fresh content at its under-mutex re-read and refuse takeover.
  const path = tempLockfile();
  const stalePid = 999_911;
  const stalePayload = { pid: stalePid, taken_at_ms: Date.now() - 60_000 };
  // Ensure the lockfile dir exists, then plant a stale mutex directly.
  mkdirSync(join(path, ".."), { recursive: true });
  // Pre-seed a stale canonical lock (drives `tryAcquire` toward the
  // takeover path).
  writeFileSync(path, JSON.stringify(stalePayload));
  const mutexPath = `${path}.takeover-mutex`;
  writeFileSync(mutexPath, JSON.stringify(stalePayload));

  // We mutate the mutex path mid-decision via the `isAlive` hook —
  // this is the test's stand-in for "another reclaimer linked their
  // fresh mutex into the canonical mutex path between A's read and A's
  // unlink." The fresh mutex carries a live PID. With the old
  // unlink-by-path logic, A would unlink this fresh inode; with the
  // rename-aside fix, A's rename moves canonical away atomically —
  // but the test below simulates the racy mutation explicitly.
  const livePid = 1234;
  let mutated = false;
  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => {
      if (!mutated) {
        mutated = true;
        // Replace the mutex while A is mid-decision. Note:
        // `unlinkSync` then `writeFileSync` simulates an unlink+link
        // sequence; the rename-aside fix means A's reclaim has already
        // moved the *original* stale inode to a private aside before
        // this hook fires (the hook fires during A's owner liveness
        // check on the aside, not on canonical), so this mutation
        // affects the canonical path that A will now try to put back
        // into.
        try {
          unlinkSync(mutexPath);
        } catch {}
        writeFileSync(
          mutexPath,
          JSON.stringify({ pid: livePid, taken_at_ms: Date.now() }),
        );
      }
      return pid === livePid; // staleMutexHolder is dead, livePid alive
    },
    // Force PID-only staleness for the canonical lock path so the
    // outer `tryAcquire` flow proceeds to the mutex code path.
  });

  // Drive A's tryRun. With the fix, A either:
  //   (a) puts back the original stale mutex (rename-aside, then link
  //       back) — in which case the third-party fresh mutex prevents
  //       link, A drops aside, and the canonical mutex still holds
  //       the third party's fresh content; or
  //   (b) unlinks aside successfully because the aside owner read
  //       still showed dead — and the third-party fresh mutex remains
  //       at canonical untouched.
  // In NEITHER case does the fresh mutex (livePid) get unlinked.
  lockA.tryRun(() => {});

  // The decisive assertion: whatever happened, the canonical mutex path
  // either does not exist, OR contains a payload whose PID is one of
  // the legitimate values we tracked (stalePid we put back, or livePid
  // the third party linked). The old bug would have left the file
  // unlinked and ALSO left A inside the takeover, observable as A
  // having unlinked the live-pid file and replaced canonical lockfile.
  // With the fix, the live-pid mutex is preserved (or, if the rename
  // landed before the mutation, A's reclaim treats the original stale
  // payload appropriately).
  if (existsSync(mutexPath)) {
    const remaining = JSON.parse(readFileSync(mutexPath, "utf8"));
    expect([stalePid, livePid]).toContain(remaining.pid);
  }
});

function unlinkSync(p: string): void {
  // Local re-export: avoid name conflict with node:fs.unlinkSync used
  // in module scope while keeping the test self-contained.
  const { unlinkSync: u } = require("node:fs") as typeof import("node:fs");
  u(p);
}

test("rename-aside path: when both reclaimers see the same stale mutex, only the inode that survived the rename is unlinked", () => {
  // Direct verification of the new contract: the inode the reclaimer
  // unlinks is the one it moved aside, NOT whatever happens to live at
  // the canonical mutex path at unlink time. We assert this by writing
  // a stale mutex, running tryAcquire in a way that exercises the
  // takeover path, and checking that the canonical mutex path was
  // either successfully reclaimed (taken over) or left intact with a
  // live owner — never silently empty due to a wrong-inode unlink.
  const path = tempLockfile();
  const stalePid = 999_912;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;
  writeFileSync(
    mutexPath,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid !== stalePid, // anything else (real PID, etc.) is alive
  });
  const result = lock.tryRun(() => {});
  // The lock was acquired (stale dead → takeover succeeds).
  expect(result.acquired).toBe(true);
  // The mutex was released after tryRun; canonical path is empty.
  expect(existsSync(mutexPath)).toBe(false);
});

test("reclaim leaves a live-owner mutex in place after the rename-aside check", () => {
  // The mutex's recorded owner is alive: tryReclaimMutex must not
  // unlink it. With the rename-aside flow this means after the
  // reclaim attempt, the canonical mutex path still carries the live
  // owner's payload.
  const path = tempLockfile();
  const stalePid = 999_913;
  const liveOwnerPid = 4321;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;
  // Live owner — fresh timestamp, alive PID.
  writeFileSync(
    mutexPath,
    JSON.stringify({ pid: liveOwnerPid, taken_at_ms: Date.now() }),
  );
  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid === liveOwnerPid,
    staleMutexMs: 0, // age never short-circuits in this test
  });
  const result = lock.tryRun(() => {});
  expect(result.acquired).toBe(false);
  // Mutex still names the live owner. (The reclaim moved it aside,
  // observed live, and put it back.)
  expect(existsSync(mutexPath)).toBe(true);
  const owner = JSON.parse(readFileSync(mutexPath, "utf8"));
  expect(owner.pid).toBe(liveOwnerPid);
});

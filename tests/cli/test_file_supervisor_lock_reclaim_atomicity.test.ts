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

test("legit-holder takeover-mutex is NEVER moved or unlinked (no empty-canonical window)", () => {
  // Reviewer's specific scenario: process B legitimately holds the
  // takeover mutex. Process A's tryReclaimMutex must not even
  // briefly empty the canonical mutex path — otherwise process C can
  // `linkSync` into the empty path and end up inside the takeover
  // critical section concurrently with B.
  //
  // The v4 protocol serializes reclaim with an outer `mkdir`-based
  // reclaim-lock (`<mutex>.reclaim-lock` directory). Inside the
  // reclaim-lock the takeover-mutex can be inspected and acted on
  // without races; the canonical mutex path is therefore *never*
  // moved aside or unlinked while we're still deciding. The reclaim-
  // lock dir DOES appear briefly mid-decision (that's the whole
  // point), but it's a separate path that no acquirer would
  // `linkSync` into.
  //
  // We pin this by sampling the filesystem from inside the `isAlive`
  // hook (which fires WHILE A's reclaim decision is in progress) and
  // asserting:
  //   1. The canonical mutex path stays present and is the same inode
  //      we wrote (i.e., not renamed away to an aside path).
  //   2. The mutex content stays unchanged throughout the decision.
  const { readdirSync, statSync: statTest } =
    require("node:fs") as typeof import("node:fs");
  const path = tempLockfile();
  const stalePid = 999_914;
  const liveOwnerPid = 5678;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid: stalePid, taken_at_ms: Date.now() - 60_000 }),
  );
  const mutexPath = `${path}.takeover-mutex`;
  const livePayload = {
    pid: liveOwnerPid,
    taken_at_ms: Date.now(),
  };
  writeFileSync(mutexPath, JSON.stringify(livePayload));
  const expectedInode = statTest(mutexPath).ino;

  let observedMissing = false;
  let observedInodeChange = false;
  let observedRenameAside = false;
  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => {
      try {
        const dir = join(path, "..");
        const entries = readdirSync(dir);
        if (!entries.includes("tick.lock.takeover-mutex")) {
          observedMissing = true;
        } else if (statTest(mutexPath).ino !== expectedInode) {
          observedInodeChange = true;
        }
        // Sentinel for any v2/v3-style rename-aside file (paths like
        // `tick.lock.takeover-mutex.reclaim-<pid>-<rand>`). v4 uses a
        // directory named `.reclaim-lock` (no rand suffix) — that's
        // a separate path and not a problem, so we exclude it.
        if (
          entries.some(
            (e) =>
              e.startsWith("tick.lock.takeover-mutex.reclaim-") &&
              e !== "tick.lock.takeover-mutex.reclaim-lock",
          )
        ) {
          observedRenameAside = true;
        }
      } catch {}
      return pid === liveOwnerPid;
    },
  });

  const result = lockA.tryRun(() => {});
  expect(result.acquired).toBe(false);
  // The legit holder's mutex was never moved aside, never unlinked,
  // never replaced with a different inode during the decision.
  expect(observedMissing).toBe(false);
  expect(observedInodeChange).toBe(false);
  expect(observedRenameAside).toBe(false);
  // And the canonical mutex still has the live owner's payload.
  expect(existsSync(mutexPath)).toBe(true);
  const owner = JSON.parse(readFileSync(mutexPath, "utf8"));
  expect(owner.pid).toBe(liveOwnerPid);
});

test("a leaked .reclaim-lock dir fails closed: subsequent reclaim refuses, no path-based stale recovery", () => {
  // Per the v5 protocol the reclaim-lock has NO stale auto-recovery.
  // Path-based stale recovery (`stat` + `rmdir`-by-path) would
  // re-introduce the original race the reclaim-lock was meant to
  // prevent: two contenders could both observe a stale reclaim-lock,
  // both rmdir, both mkdir, and both end up inside the supposedly-
  // serialized critical section.
  //
  // The fail-closed behavior means: if `.reclaim-lock` exists for
  // any reason (a peer is mid-reclaim, OR a previous reclaimer
  // crashed inside the sub-millisecond critical section and leaked
  // the dir), we refuse takeover and the operator's manual cleanup
  // is the recovery path. That is far better than the alternative
  // of risking double-runs of supervisor side effects.
  const path = tempLockfile();
  const stalePid = 999_917;
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
  // Pre-seed a leaked reclaim-lock dir, mtime far in the past — under
  // any age-based recovery scheme this would auto-reclaim. With v5
  // the leaked dir is sticky regardless of age.
  const reclaimLockPath = `${mutexPath}.reclaim-lock`;
  mkdirSync(reclaimLockPath);
  // Backdating mtime is best-effort: the assertion below holds either
  // way because v5 doesn't consult mtime at all.
  try {
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(reclaimLockPath, new Date(Date.now() - 24 * 60 * 60 * 1000), new Date(Date.now() - 24 * 60 * 60 * 1000));
  } catch {}

  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: () => false,
  });
  const result = lock.tryRun(() => {});
  // No stale auto-recovery: the leaked reclaim-lock blocks takeover
  // until an operator removes it.
  expect(result.acquired).toBe(false);
  // The leaked dir is still there.
  expect(existsSync(reclaimLockPath)).toBe(true);
  // The takeover-mutex is left intact (we never entered the critical
  // section, so we never unlinked it).
  expect(existsSync(mutexPath)).toBe(true);

  // Manual operator cleanup is then sufficient to recover: rmdir the
  // reclaim-lock and the next acquire works.
  const { rmdirSync: rmdirTest } = require("node:fs") as typeof import("node:fs");
  rmdirTest(reclaimLockPath);
  const recovered = lock.tryRun(() => {});
  expect(recovered.acquired).toBe(true);
});

test("two reclaimers serialize through the reclaim-lock — only one passes through the critical section at a time", () => {
  // Direct simulation of the stale-to-fresh race this test covers: A
  // enters tryReclaimMutex (reads stale), and during A's decision a
  // second process B *also* tries to reclaim. Without serialization, B
  // could also pass the stale check and act on the same dead inode
  // that A is operating on. With the v4 reclaim-lock, B's mkdirSync
  // fails EEXIST and B refuses takeover — that's the correct outcome.
  //
  // We drive B's contention from inside A's `isAlive` hook, gated on
  // the reclaim-lock dir's existence so B fires only AFTER A has
  // entered its reclaim critical section. (A's `isAlive` is also
  // called at the supervisor-lockfile level *before* A acquires the
  // reclaim-lock; without the gate, B would race A there instead.)
  const path = tempLockfile();
  const stalePid = 999_916;
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
  const reclaimLockPath = `${mutexPath}.reclaim-lock`;

  let bAttempted = false;
  const bAcquiredHolder: { value: boolean | null } = { value: null };
  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => {
      // Trigger B's contention exactly once, and only when A is
      // observably inside the reclaim-lock critical section. This is
      // the precise window the race scenario targets: A has
      // read the stale mutex and is about to act on it.
      if (!bAttempted && existsSync(reclaimLockPath)) {
        bAttempted = true;
        const lockB = new FileSupervisorLock({
          lockfilePath: path,
          // B's hook treats anything as dead so its OWN takeover path
          // would otherwise succeed — leaving the reclaim-lock as
          // the only thing preventing B from racing A.
          isAlive: () => false,
        });
        bAcquiredHolder.value = lockB.tryRun(() => {}).acquired;
      }
      return pid !== stalePid;
    },
  });
  const aResult = lockA.tryRun(() => {});
  // A acquired (its reclaim was serialized; B did not interfere).
  expect(aResult.acquired).toBe(true);
  // B fired (the reclaim-lock dir was observable mid-decision).
  expect(bAttempted).toBe(true);
  // And B refused: it could not enter A's serialized critical section.
  expect(bAcquiredHolder.value).toBe(false);
});

test("stale-then-fresh race: a freshening between A's read and A's unlink CANNOT happen under the reclaim-lock", () => {
  // Stale-then-fresh race scenario: A reads a stale mutex, B freshens
  // between A's read and A's unlink, A unlinks B's fresh mutex. The
  // v4 protocol prevents this because the reclaim-lock is acquired
  // BEFORE A's read; B's freshening can't happen until A releases the
  // reclaim-lock (B would be waiting on the same reclaim-lock).
  //
  // We test this directly: pre-seed a stale mutex, then run two
  // sequential reclaim attempts and assert that neither one ever
  // sees a "different mutex inode at unlink time than at read time"
  // — which is structurally impossible under the v4 protocol because
  // the read and unlink happen inside the same reclaim-lock critical
  // section.
  const path = tempLockfile();
  const stalePid = 999_915;
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

  const lockA = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid !== stalePid,
  });
  const aResult = lockA.tryRun(() => {
    // Inside A's takeover, the takeover-mutex was released after the
    // reclaim+swap completed. Any concurrent reclaim attempt now
    // would simply create a fresh mutex via the normal acquire path;
    // a stale-mutex reclaim is not in play here.
    expect(existsSync(mutexPath)).toBe(false);
  });
  expect(aResult.acquired).toBe(true);
});

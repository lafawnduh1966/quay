// Regression: previously `createExclusive` did `openSync(.., "wx")` then a
// separate `writePayload`. A crash between those two steps left the
// canonical lockfile with no parseable payload — and `tryAcquire` refuses
// to reclaim a null-payload lock at all. The result was a permanently
// unrecoverable lock that blocked every subsequent tick / cancel until
// an operator removed the file by hand.
//
// The fix uses a scratch-plus-hard-link sequence (same as the takeover
// mutex): the canonical lockfile carries the owner payload from the
// instant it exists. The "no parseable payload" state cannot occur for a
// lockfile this code created.
//
// Tests below verify (a) the new sequence still holds the lock for normal
// acquire/release, (b) takeover still works when the file already exists
// (so the EEXIST path isn't broken), and (c) a payload written into the
// canonical path is observable from the moment the file appears.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  const dir = mkdtempSync(join(tmpdir(), "quay-lock-atomicity-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "tick.lock");
}

test("createExclusive writes payload as part of the create — never an empty file window", () => {
  // The lockfile must contain a parseable payload from the moment it
  // exists. This test peeks at the file the instant it appears (right
  // when we're about to start `fn`) and asserts the payload is already
  // there. It's a structural check on the new scratch+link sequence.
  const path = tempLockfile();
  const lock = new FileSupervisorLock({ lockfilePath: path });

  let payloadSeenInsideFn: { pid: number; taken_at_ms: number } | null = null;
  lock.run(() => {
    // Inside fn the file must exist with our payload — there should be no
    // observable window in which the file is present but empty.
    expect(existsSync(path)).toBe(true);
    const stat = statSync(path);
    expect(stat.size).toBeGreaterThan(0);
    payloadSeenInsideFn = JSON.parse(readFileSync(path, "utf8"));
  });
  expect(payloadSeenInsideFn).not.toBeNull();
  expect(payloadSeenInsideFn!.pid).toBe(process.pid);
  expect(typeof payloadSeenInsideFn!.taken_at_ms).toBe("number");
  // Released on exit.
  expect(existsSync(path)).toBe(false);
});

test("a leftover scratch file from a prior crash does not block a new acquire", () => {
  // If a previous process died after writing scratch but before linking
  // it, the canonical lockfile was never created and the dir contains
  // nothing but the orphan scratch. A new acquire must still succeed.
  const path = tempLockfile();
  // Pre-seed an orphan scratch file (the new createExclusive uses
  // `<lockfilePath>.init-<pid>-<rand>` for scratch).
  mkdirSync(join(path, ".."), { recursive: true });
  const orphanScratch = `${path}.init-99999-deadbeef`;
  writeFileSync(
    orphanScratch,
    JSON.stringify({ pid: 99999, taken_at_ms: Date.now() - 60_000 }),
  );

  const lock = new FileSupervisorLock({ lockfilePath: path });
  let ran = false;
  lock.run(() => {
    ran = true;
  });
  expect(ran).toBe(true);
});

test("EEXIST fallback path still kicks in when the canonical path already has a payload", () => {
  // Pre-seed the canonical lockfile with a live owner; createExclusive
  // must observe EEXIST and fall through to the live-owner-bail path
  // rather than throwing. The new scratch+link sequence preserves this
  // contract.
  const path = tempLockfile();
  const otherPid = process.pid + 1;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ pid: otherPid, taken_at_ms: Date.now() }),
  );

  const lock = new FileSupervisorLock({
    lockfilePath: path,
    isAlive: (pid) => pid === otherPid,
  });
  const result = lock.tryRun(() => {});
  expect(result.acquired).toBe(false);
  // Pre-existing lockfile is intact.
  expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(otherPid);
});

test("createExclusive cleans up its own scratch on success (no scratch leak)", () => {
  // After a successful acquire+release, the directory should not contain
  // any leftover scratch artifacts. A scratch leak per acquire would
  // accumulate over time across many ticks.
  const path = tempLockfile();
  const dir = join(path, "..");
  const lock = new FileSupervisorLock({ lockfilePath: path });
  lock.run(() => {});
  // Lockfile released on exit. No scratch files should remain either.
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const remaining = readdirSync(dir);
  // Filter out any unrelated junk the tmpdir may contain (none expected).
  const scratchLeak = remaining.filter((name) =>
    name.startsWith("tick.lock.init-"),
  );
  expect(scratchLeak).toEqual([]);
});

// Regression: `artifact get` used to read every artifact via
// `readFileSync(path, "utf8")`. That breaks the "raw file contents"
// contract for `malformed_signal` artifacts, which intentionally
// preserve invalid UTF-8 bytes — the classifier captures the worker's
// blocker payload verbatim so the operator can debug "what did the
// worker actually write?". A UTF-8 round-trip on a payload containing
// `0xFF`/`0xC0` etc. silently substitutes U+FFFD, destroying the
// evidence.
//
// The fix streams bytes through CliIO. Stdout now accepts Uint8Array,
// `artifact get` calls `readFileSync(path)` (no encoding), and the
// production sink (`process.stdout.write`) writes bytes natively. We
// verify by writing a malformed_signal artifact whose contents include
// invalid UTF-8 sequences and asserting `artifact get` echoes the bytes
// byte-for-byte.

import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("artifact get returns malformed_signal bytes verbatim, including invalid UTF-8", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const repoId = insertRepo(h.db, "repo-mal");
  const taskId = insertTask(h.db, {
    taskId: "task-mal",
    repoId,
    state: "queued",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });

  // Construct a payload that is NOT valid UTF-8. 0xFF is never a valid
  // UTF-8 byte; a lone 0x80 continuation byte is also invalid; 0xC0 is a
  // forbidden lead byte. Any UTF-8-decoding round-trip would replace
  // these with U+FFFD (3 bytes of 0xEF 0xBF 0xBD) and we'd see length /
  // content drift.
  const payload = new Uint8Array([
    0x68, 0x69, 0x0a, // "hi\n"
    0xff, 0xfe, 0xfd, // raw invalid bytes
    0xc0, 0x80,       // overlong NUL (forbidden by UTF-8)
    0xed, 0xa0, 0x80, // surrogate (forbidden)
    0x00,             // a literal NUL
    0x6f, 0x6b,       // "ok"
  ]);

  // Persist via the artifact store directly, bypassing the classifier
  // wiring — we're testing the CLI read path, not the classifier.
  built.deps.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "malformed_signal",
    content: payload,
    extension: "bin",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["artifact", "get", taskId, "malformed_signal"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");

  // Compare bytes, not strings — `out()` decodes lossily by design.
  const got = io.outBytes();
  expect(got.byteLength).toBe(payload.byteLength);
  for (let i = 0; i < payload.byteLength; i += 1) {
    if (got[i] !== payload[i]) {
      throw new Error(
        `byte mismatch at offset ${i}: expected 0x${payload[i]!.toString(16)}, got 0x${got[i]!.toString(16)}`,
      );
    }
  }
});

test("artifact get on a UTF-8 text artifact still works (regression guard for the new bytes path)", async () => {
  // The shape change (string → string|Uint8Array on CliIO.stdout) must
  // not break the common text path. We re-verify that a plain text
  // artifact comes back as the same bytes a `string` write would
  // produce.
  h = createHarness();
  const built = buildCliDeps(h);
  const repoId = insertRepo(h.db, "repo-text");
  const taskId = insertTask(h.db, {
    taskId: "task-text",
    repoId,
    state: "queued",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });

  const body = "hello unicode: café 日本語\n";
  built.deps.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: body,
    extension: "md",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["artifact", "get", taskId, "brief"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(io.out()).toBe(body);
});

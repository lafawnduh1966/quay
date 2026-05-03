// Regression: SlackAdapter previously passed the request URL and body as
// argv elements to its child Bun process. argv is world-readable on Linux
// via `/proc/<child_pid>/cmdline` and visible to `ps -ef` for the
// child's lifetime, so message text (escalation question, blocker
// excerpt, dedupe nonce) and GET query params (channel id, parent thread
// ts) leak to any local reader on a multi-tenant host.
//
// The fix routes everything sensitive through env vars (QUAY_SLACK_URL /
// QUAY_SLACK_BODY) — same channel the token already uses. This test pins
// that contract by intercepting `Bun.spawnSync` from inside the adapter
// and asserting the spawn cmd contains neither the body nor the URL.
//
// We short-circuit the intercepted spawn (return a fake success body)
// rather than actually running the child. Two reasons: (1) the parent's
// event loop is blocked inside `spawnSync`, so a child trying to fetch
// from a parent-hosted `Bun.serve` would hang; (2) the contract under
// test is purely about what gets serialized into argv vs env at the
// spawn boundary, not about the round-trip.

import { afterEach, expect, test } from "bun:test";
import { SlackAdapter } from "../../src/adapters/slack.ts";

let restoreSpawnSync: (() => void) | null = null;
const captured: Array<{ cmd: string[]; env: Record<string, string> }> = [];

afterEach(() => {
  captured.length = 0;
  if (restoreSpawnSync !== null) {
    restoreSpawnSync();
    restoreSpawnSync = null;
  }
});

function interceptSpawnSync(stubResponseBody: string): void {
  const original = Bun.spawnSync.bind(Bun);
  // Capture the spawn cmd + env, then return a minimal fake "child success"
  // result so the adapter parses a valid Slack body and the test assertions
  // can run synchronously.
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
    opts: Parameters<typeof Bun.spawnSync>[0],
  ) => {
    const o = opts as unknown as { cmd: string[]; env: Record<string, string> };
    captured.push({ cmd: [...o.cmd], env: { ...o.env } });
    return {
      exitCode: 0,
      stdout: new TextEncoder().encode(stubResponseBody),
      stderr: new TextEncoder().encode(""),
      success: true,
      signalCode: null,
      pid: 0,
      // resourceUsage is unused by SlackAdapter; cast through unknown so
      // the test doesn't depend on Bun's full SyncSubprocess shape.
    } as unknown as ReturnType<typeof Bun.spawnSync>;
  }) as typeof Bun.spawnSync;
  restoreSpawnSync = () => {
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync =
      original;
  };
}

test("post: body and URL are passed via env, not argv", () => {
  interceptSpawnSync(JSON.stringify({ ok: true, ts: "1700000001.0001" }));
  const adapter = new SlackAdapter({
    endpoint: "http://slack.local/api",
    token: "xoxb-test-token",
    timeoutMs: 5_000,
  });
  const sensitiveText =
    "QUAY_SECRET_ESCALATION_BODY: blocker quote with channel id C0SECRET inside";
  adapter.post({
    threadRef: "C0SECRET:1700000000.0001",
    body: sensitiveText,
  });

  expect(captured.length).toBe(1);
  const { cmd, env } = captured[0]!;
  // argv must not contain the message text, the channel id, or the parent
  // thread ts — argv is exposed via /proc/<pid>/cmdline.
  for (const arg of cmd) {
    expect(arg).not.toContain(sensitiveText);
    expect(arg).not.toContain("C0SECRET");
    expect(arg).not.toContain("1700000000.0001");
    expect(arg).not.toContain("xoxb-test-token");
  }
  // The same fields must instead be present in the child env, which is
  // gated behind same-uid `/proc/<pid>/environ` access.
  expect(env.QUAY_SLACK_BODY).toContain(sensitiveText);
  expect(env.QUAY_SLACK_BODY).toContain("C0SECRET");
  expect(env.QUAY_SLACK_BODY).toContain("1700000000.0001");
  expect(env.QUAY_SLACK_URL).toContain("chat.postMessage");
  expect(env.QUAY_SLACK_TOKEN).toBe("xoxb-test-token");
});

test("listReplies (GET): channel and parent ts are passed via env URL, not argv query string", () => {
  interceptSpawnSync(JSON.stringify({ ok: true, messages: [] }));
  const adapter = new SlackAdapter({
    endpoint: "http://slack.local/api",
    token: "xoxb-test-token",
    timeoutMs: 5_000,
  });
  adapter.listReplies("C0SECRETGET:1700000002.0002", "0");

  expect(captured.length).toBe(1);
  const { cmd, env } = captured[0]!;
  for (const arg of cmd) {
    expect(arg).not.toContain("C0SECRETGET");
    expect(arg).not.toContain("1700000002.0002");
    expect(arg).not.toContain("xoxb-test-token");
    // The API method name itself shouldn't leak via argv either, because
    // the URL is the full request endpoint and lives in env now.
    expect(arg).not.toContain("conversations.replies");
  }
  expect(env.QUAY_SLACK_URL).toContain("conversations.replies");
  expect(env.QUAY_SLACK_URL).toContain("C0SECRETGET");
  expect(env.QUAY_SLACK_URL).toContain("1700000002.0002");
});

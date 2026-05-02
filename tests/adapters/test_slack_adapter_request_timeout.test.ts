// Regression: SlackAdapter posts/reads through a child Bun process that
// runs `fetch`. Without a timeout, a stalled Slack connection holds the
// supervisor lock for the duration of `quay tick` (or `quay cancel`),
// blocking every other supervisor side effect indefinitely instead of
// logging `tick_error` and continuing on the next cycle.
//
// We pin the bounded behavior here: stand up a localhost HTTP server that
// holds connections open without responding, point SlackAdapter at it with
// a short timeout, and assert that `post()` throws within a small multiple
// of the budget.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackAdapter } from "../../src/adapters/slack.ts";

let server: ReturnType<typeof Bun.serve>;
let savedTimeoutEnv: string | undefined;

beforeAll(() => {
  savedTimeoutEnv = process.env.QUAY_SLACK_TIMEOUT_MS;
  // The hanging server: every request returns a Promise that never
  // resolves, which simulates a Slack endpoint that accepts the TCP
  // connection but never sends a response body.
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Promise(() => {});
    },
  });
});

afterAll(() => {
  server.stop(true);
  if (savedTimeoutEnv === undefined) {
    delete process.env.QUAY_SLACK_TIMEOUT_MS;
  } else {
    process.env.QUAY_SLACK_TIMEOUT_MS = savedTimeoutEnv;
  }
});

test("post aborts within the configured timeout when Slack never responds", () => {
  const timeoutMs = 250;
  const adapter = new SlackAdapter({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: "test-token",
    timeoutMs,
  });
  const start = Date.now();
  expect(() =>
    adapter.post({ threadRef: "C123:1.000000", body: "hello" }),
  ).toThrow(/timed out|aborted|abort/i);
  const elapsed = Date.now() - start;
  // Generous upper bound: child must abort and exit well before tick's
  // own cycle completes. A regression that drops the timeout would hang
  // until the parent grace deadline (~5s+timeoutMs), so a 4s ceiling is
  // a strong signal the abort path is wired.
  expect(elapsed).toBeLessThan(4_000);
});

test("listReplies aborts within the configured timeout when Slack never responds", () => {
  // GET path goes through the same child fetch — pin the timeout there
  // too so we don't regress one method while leaving the other unbounded.
  const timeoutMs = 250;
  const adapter = new SlackAdapter({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: "test-token",
    timeoutMs,
  });
  const start = Date.now();
  expect(() => adapter.listReplies("C123:1.000000", "0")).toThrow(
    /timed out|aborted|abort/i,
  );
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(4_000);
});

// Slack adapter contract tests are gated behind QUAY_INTEGRATION_TESTS=1
// because they require a Slack bot token + a test channel. The default
// `bun test` run must remain green without credentials.

import { describe, expect, test } from "bun:test";
import { SlackAdapter } from "../../src/adapters/slack.ts";

const integration = process.env.QUAY_INTEGRATION_TESTS === "1";

describe.skipIf(!integration)("SlackAdapter contract (integration)", () => {
  test("instantiates without error", () => {
    expect(new SlackAdapter()).toBeDefined();
  });

  // Real contract assertions land here once a Slack bot + channel are
  // available in CI. Until then the env-gate is the thing under test by
  // default.
});

test("slack adapter contract block is skipped by default", () => {
  expect(integration).toBe(false);
});

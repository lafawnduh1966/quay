// GitHub adapter contract tests are gated behind QUAY_INTEGRATION_TESTS=1
// because they require `gh` auth + a real test repo. The default `bun test`
// run must remain green without credentials.

import { describe, expect, test } from "bun:test";
import { GitHubCliAdapter } from "../../src/adapters/github.ts";

const integration = process.env.QUAY_INTEGRATION_TESTS === "1";

describe.skipIf(!integration)("GitHubCliAdapter contract (integration)", () => {
  test("instantiates without error", () => {
    expect(new GitHubCliAdapter("/tmp/quay-fake-repos-root")).toBeDefined();
  });

  // Real contract assertions land here once a test repo + creds are wired in
  // CI. Until then the integration block is intentionally minimal so the
  // env-gate is the thing under test by default.
});

test("github adapter contract block is skipped by default", () => {
  expect(integration).toBe(false);
});

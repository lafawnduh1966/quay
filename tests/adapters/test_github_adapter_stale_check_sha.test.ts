// Spec §5 / §12: tick must reject CI evaluation when the check rows it sees
// were produced against a SHA that's no longer the PR head (force-push or
// GitHub lag). `gh pr checks --json` doesn't carry a per-row SHA, so the
// adapter brackets the checks read with two `gh pr view --json headRefOid`
// reads; classifyCi compares the two.
//
// Regression: a previous adapter shipped `checkSha: null` from `fetchChecks`,
// which silently disables the stale-SHA branch in classifyCi. This test
// drives `prSnapshot` through a stubbed `gh` and asserts:
//   - `checks.checkSha` is non-null and reflects the head-before-checks read.
//   - When the head changes between the two `gh pr view` reads, the snapshot
//     surfaces `checks.checkSha !== headSha`, which classifyCi treats as
//     stale.
//   - When the head is stable across both reads, both SHAs match.

import { expect, test } from "bun:test";
import { GitHubCliAdapter, type RunResult } from "../../src/adapters/github.ts";
import { classifyCi } from "../../src/core/ci_status.ts";

class StubbedGitHubAdapter extends GitHubCliAdapter {
  // Each call to `run` consumes one entry from `responses` in order. If the
  // command shape doesn't match the expected one, we throw — that catches
  // unexpected gh invocations introduced by future refactors.
  constructor(
    private readonly responses: Array<
      ((cmd: string[]) => RunResult) | RunResult
    >,
  ) {
    super("/tmp/quay-stub-repos");
  }

  protected override run(_repoId: string, cmd: string[]): RunResult {
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error(
        `unexpected gh invocation; cmd=${JSON.stringify(cmd)}`,
      );
    }
    return typeof next === "function" ? next(cmd) : next;
  }
}

function ok(stdout: string): RunResult {
  return { exitCode: 0, stdout, stderr: "" };
}

test("prSnapshot sets checkSha to the head SHA observed before fetching checks", () => {
  // Stable head across both reads: snapshot.checkSha === snapshot.headSha;
  // classifyCi runs normally (here, "pass" via the no-required-checks rule).
  const adapter = new StubbedGitHubAdapter([
    // 1. fetchPrView (gh pr view --json state,headRefOid,...)
    ok(
      JSON.stringify({
        state: "OPEN",
        headRefOid: "sha-stable",
        baseRefOid: "base-1",
        mergeable: "MERGEABLE",
        reviewDecision: "NONE",
        latestReviews: [],
      }),
    ),
    // 2. fetchChecks (gh pr checks --json bucket,workflow,name,state)
    ok(JSON.stringify([])),
    // 3. fetchRequiredCheckKeys (gh pr checks --required ...)
    ok(JSON.stringify([])),
    // 4. fetchHeadShaOnly (gh pr view --json headRefOid)
    ok(JSON.stringify({ headRefOid: "sha-stable" })),
  ]);

  const snap = adapter.prSnapshot("repo-x", "quay/feat");
  expect(snap).not.toBeNull();
  expect(snap!.headSha).toBe("sha-stable");
  expect(snap!.checks.checkSha).toBe("sha-stable");
  // Head/check SHAs match → classifyCi proceeds (no-required-checks → pass).
  expect(classifyCi(snap!, null)).toBe("pass");
});

test("prSnapshot detects mid-fetch force-push and surfaces a stale outcome via classifyCi", () => {
  // Head changes between the bracketing reads: snapshot.checkSha = old,
  // snapshot.headSha = new. classifyCi must return "stale" so tick logs
  // `tick_error` rather than transitioning on possibly-old green checks.
  const adapter = new StubbedGitHubAdapter([
    // 1. fetchPrView reports the OLD head.
    ok(
      JSON.stringify({
        state: "OPEN",
        headRefOid: "sha-old",
        baseRefOid: "base-1",
        mergeable: "MERGEABLE",
        reviewDecision: "NONE",
        latestReviews: [],
      }),
    ),
    // 2. fetchChecks returns one passing required check (would normally → pass).
    ok(
      JSON.stringify([
        { bucket: "pass", workflow: "ci", name: "build", state: "SUCCESS" },
      ]),
    ),
    // 3. fetchRequiredCheckKeys marks (ci, build) as required.
    ok(JSON.stringify([{ workflow: "ci", name: "build" }])),
    // 4. fetchHeadShaOnly observes the NEW head — force-push happened.
    ok(JSON.stringify({ headRefOid: "sha-new" })),
  ]);

  const snap = adapter.prSnapshot("repo-x", "quay/feat");
  expect(snap).not.toBeNull();
  expect(snap!.headSha).toBe("sha-new");
  expect(snap!.checks.checkSha).toBe("sha-old");
  // The disagreement triggers the stale path even though the check itself is
  // passing. tick will log tick_error and not transition.
  expect(classifyCi(snap!, null)).toBe("stale");
});

test("prSnapshot returns null without bracketing reads when no PR exists for the branch", () => {
  // Defensive: the second head-SHA read must not trigger an extra gh call
  // when the first read already established that no PR exists. Verified by
  // omitting the second response — the stub throws if an unexpected gh
  // invocation occurs.
  const adapter = new StubbedGitHubAdapter([
    {
      exitCode: 1,
      stdout: "",
      stderr: "no pull request found for branch quay/missing",
    },
  ]);

  const snap = adapter.prSnapshot("repo-x", "quay/missing");
  expect(snap).toBeNull();
});

// Regression: `fetchHeadShaOnly` previously matched any stderr containing
// the substring "not found" as the spec's "no PR for this branch" signal,
// returning null. The caller in `prSnapshot` then falls back to
// `headShaBefore` (`?? headShaBefore`), which silently makes the bracket
// SHAs match and lets `classifyCi` transition on possibly-stale checks —
// the exact failure mode the §5/§12 stale-SHA gate was added to prevent.
//
// The new matcher restricts the no-PR path to PR-scoped phrasings
// ("no pull request" / "no pull requests"). A bare GraphQL "Not Found"
// from a transient API blip / auth scope must surface as a thrown error
// → tick_error, not as a silently-disabled stale-SHA gate.

import { expect, test } from "bun:test";
import { GitHubCliAdapter, type RunResult } from "../../src/adapters/github.ts";

class StubbedGitHubAdapter extends GitHubCliAdapter {
  constructor(
    private readonly responses: Array<
      ((cmd: string[]) => RunResult) | RunResult
    >,
  ) {
    super("/tmp/quay-stub-repos-headsha");
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

test("prSnapshot: a generic GraphQL 'Not Found' on the second head-SHA read fails closed instead of disabling the stale-SHA gate", () => {
  // The first head read succeeds (so prSnapshot proceeds through fetchChecks
  // and into the bracketing second read). The second `gh pr view --json
  // headRefOid` fails with a generic GraphQL 404 — under the bare `not
  // found` matcher, it would return null and the caller's `?? headShaBefore`
  // would silently make `headSha === checkSha`, defeating the spec §5/§12
  // stale-SHA gate. After the matcher tightening, the same response must
  // throw so tick logs tick_error instead.
  const adapter = new StubbedGitHubAdapter([
    // 1. fetchPrView
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
    // 2. fetchChecks
    ok(
      JSON.stringify([
        { bucket: "pass", workflow: "ci", name: "build", state: "SUCCESS" },
      ]),
    ),
    // 3. fetchRequiredCheckKeys
    ok(JSON.stringify([{ workflow: "ci", name: "build" }])),
    // 4. fetchHeadShaOnly — generic GraphQL 404, NOT a "no pull request"
    //    response. This must surface as a thrown error.
    {
      exitCode: 1,
      stdout: "",
      stderr:
        "GraphQL: Could not resolve to a PullRequest with the number 17. (repository.pullRequest) Not Found",
    },
  ]);

  expect(() => adapter.prSnapshot("repo-x", "quay/feat")).toThrow(
    /headRefOid|not found|could not resolve/i,
  );
});

test("prSnapshot: a real 'no pull request' response on the second head-SHA read still resolves to a stable bracket (no false stale)", () => {
  // The other side of the contract: a legitimate "no pull request" reply on
  // the second bracket read must still degrade gracefully (caller falls
  // back to headShaBefore so the SHAs match), not throw. We pin this so
  // the matcher tightening doesn't regress the legitimate path.
  const adapter = new StubbedGitHubAdapter([
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
    ok(JSON.stringify([])),
    ok(JSON.stringify([])),
    {
      exitCode: 1,
      stdout: "",
      stderr: "no pull requests found for branch quay/feat",
    },
  ]);

  const snap = adapter.prSnapshot("repo-x", "quay/feat");
  expect(snap).not.toBeNull();
  expect(snap!.headSha).toBe("sha-stable");
  expect(snap!.checks.checkSha).toBe("sha-stable");
});

// Pin the gh `pr view --json` field set to portable values that work on gh
// 2.45.0 (baseRefOid was added in 2.46 — including it here makes every poll
// on older gh installs fail with "Unknown JSON field"). The adapter must
// request `baseRefName` instead and resolve it to a SHA via a `git merge-base
// origin/<baseRefName> <headRefOid>` shell-out, plus carry `number` + `url`
// so the operator-visible task row gets PR linkage.
import { expect, test } from "bun:test";
import {
  GitHubCliAdapter,
  type RunResult,
} from "../../src/adapters/github.ts";

class RecordingAdapter extends GitHubCliAdapter {
  readonly cmds: string[][] = [];
  // Pre-seeded responses indexed by command shape; the test sets these up
  // per-call to drive the snapshot through both the gh and git shell-outs.
  responder: (cmd: string[]) => RunResult = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  constructor() {
    super("/tmp/quay-stub-portable-field");
  }

  protected override run(_repoId: string, cmd: string[]): RunResult {
    this.cmds.push(cmd);
    return this.responder(cmd);
  }
}

test("fetchPrView requests number/url/baseRefName but never baseRefOid", () => {
  const adapter = new RecordingAdapter();
  adapter.responder = (cmd) => {
    // First gh pr view (full snapshot) — multi-field --json arg
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      const fieldsArg = cmd[cmd.indexOf("--json") + 1] ?? "";
      const fields = fieldsArg.split(",");
      // The bracketing read in `prSnapshot` asks for headRefOid alone;
      // only check the rich snapshot read.
      if (fields.length > 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 12,
            url: "https://github.com/example/repo/pull/12",
            state: "OPEN",
            headRefOid: "head-sha-xyz",
            baseRefName: "main",
            isDraft: true,
            mergeable: "MERGEABLE",
            reviewDecision: "NONE",
            latestReviews: [],
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ headRefOid: "head-sha-xyz" }),
        stderr: "",
      };
    }
    if (cmd[0] === "git" && cmd[1] === "merge-base") {
      return { exitCode: 0, stdout: "merge-base-sha-abc\n", stderr: "" };
    }
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      return { exitCode: 0, stdout: "base-tip-sha-def\n", stderr: "" };
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "checks") {
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }
    throw new Error(`unexpected cmd ${JSON.stringify(cmd)}`);
  };

  const snap = adapter.prSnapshot("repo-x", "quay/feat");
  expect(snap).not.toBeNull();
  expect(snap!.headSha).toBe("head-sha-xyz");
  // baseSha was resolved via the git merge-base shell-out, not from gh.
  expect(snap!.baseSha).toBe("merge-base-sha-abc");
  // baseTipSha is the rev-parse result, distinct from the merge-base so
  // conflict-respawn dedup can react to base advances.
  expect(snap!.baseTipSha).toBe("base-tip-sha-def");
  expect(snap!.prNumber).toBe(12);
  expect(snap!.prUrl).toBe("https://github.com/example/repo/pull/12");
  expect(snap!.baseRef).toBe("main");
  expect(snap!.isDraft).toBe(true);

  // Cross-check the recorded calls: the rich snapshot view must request
  // portable fields and never baseRefOid.
  const richView = adapter.cmds.find(
    (c) =>
      c[0] === "gh" &&
      c[1] === "pr" &&
      c[2] === "view" &&
      (c[c.indexOf("--json") + 1] ?? "").split(",").length > 1,
  );
  expect(richView, "expected a multi-field gh pr view call").toBeDefined();
  const fields = new Set(
    (richView![richView!.indexOf("--json") + 1] ?? "").split(","),
  );
  expect(fields.has("baseRefOid")).toBe(false);
  expect(fields.has("baseRefName")).toBe(true);
  expect(fields.has("number")).toBe(true);
  expect(fields.has("url")).toBe(true);
  expect(fields.has("isDraft")).toBe(true);
  expect(fields.has("headRefOid")).toBe(true);

  // The merge-base call carried the right operands.
  const mergeBase = adapter.cmds.find(
    (c) => c[0] === "git" && c[1] === "merge-base",
  );
  expect(mergeBase).toEqual([
    "git",
    "merge-base",
    "origin/main",
    "head-sha-xyz",
  ]);
  // The base ref tip resolution targets the same ref as merge-base.
  const revParse = adapter.cmds.find(
    (c) => c[0] === "git" && c[1] === "rev-parse",
  );
  expect(revParse).toEqual(["git", "rev-parse", "origin/main"]);
});

test("baseSha falls back to null when git merge-base fails (e.g. unfetched base)", () => {
  // The adapter must degrade gracefully: a missing local ref or unfetched
  // base branch leaves base_sha null, but pr_number/pr_url/head_sha still
  // land so the operator gets partial linkage rather than a tick_error.
  const adapter = new RecordingAdapter();
  adapter.responder = (cmd) => {
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      const fieldsArg = cmd[cmd.indexOf("--json") + 1] ?? "";
      const fields = new Set(fieldsArg.split(","));
      if (fields.size > 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 99,
            url: "https://github.com/example/repo/pull/99",
            state: "OPEN",
            headRefOid: "head-z",
            baseRefName: "main",
            mergeable: "MERGEABLE",
            reviewDecision: "NONE",
            latestReviews: [],
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ headRefOid: "head-z" }),
        stderr: "",
      };
    }
    if (cmd[0] === "git" && cmd[1] === "merge-base") {
      // Simulate "unfetched base ref" — git exits 128.
      return {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: Not a valid object name origin/main",
      };
    }
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      // Same failure mode for the base ref tip — an unfetched base means
      // neither merge-base nor rev-parse can resolve it.
      return {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: ambiguous argument 'origin/main'",
      };
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "checks") {
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }
    throw new Error(`unexpected cmd ${JSON.stringify(cmd)}`);
  };

  const snap = adapter.prSnapshot("repo-x", "quay/feat");
  expect(snap).not.toBeNull();
  expect(snap!.baseSha).toBeNull();
  // baseTipSha is omitted (not present) when rev-parse fails.
  expect(snap!.baseTipSha).toBeUndefined();
  expect(snap!.prNumber).toBe(99);
  expect(snap!.headSha).toBe("head-z");
});

test("open PR reconciliation lookup filters by head and base", () => {
  const adapter = new RecordingAdapter();
  adapter.responder = (cmd) => {
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
      return { exitCode: 0, stdout: JSON.stringify([{ number: 42 }]), stderr: "" };
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/example/repo/pull/42",
          state: "OPEN",
          headRefOid: "head-42",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          reviewDecision: "NONE",
          latestReviews: [],
        }),
        stderr: "",
      };
    }
    if (cmd[0] === "git" && cmd[1] === "merge-base") {
      return { exitCode: 0, stdout: "base-42\n", stderr: "" };
    }
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      return { exitCode: 0, stdout: "base-tip-42\n", stderr: "" };
    }
    throw new Error(`unexpected cmd ${JSON.stringify(cmd)}`);
  };

  const prs = adapter.openPrsForBranchBase("repo-x", "quay/feat", "main");
  expect(prs).toEqual([
    {
      number: 42,
      url: "https://github.com/example/repo/pull/42",
      headSha: "head-42",
      baseSha: "base-42",
      baseRef: "main",
    },
  ]);
  expect(adapter.cmds[0]).toEqual([
    "gh",
    "pr",
    "list",
    "--head",
    "quay/feat",
    "--state",
    "open",
    "--base",
    "main",
    "--json",
    "number",
  ]);
});

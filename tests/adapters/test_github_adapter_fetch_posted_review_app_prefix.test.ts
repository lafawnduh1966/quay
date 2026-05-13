// Identity-preserving review-author matching.
//
// `fetchPostedReview` gates the pr-review -> done transition, so it must
// distinguish a GitHub App identity (`reviewer.login = "app/<slug>"`) from
// a regular user account that happens to share the slug. The previous
// `gh pr view --json reviews` projection collapsed both into the same
// `author.login` string ("<slug>", with the `[bot]` suffix stripped),
// which means a same-named user could satisfy a gate intended for the
// App.
//
// The adapter now reads the REST reviews endpoint and matches on
// `user.type` (`Bot` for App, `User` for regular) in addition to
// `user.login` (with `[bot]` stripped on the Bot side only).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GitHubCliAdapter } from "../../src/adapters/github.ts";

let cleanups: Array<() => void> = [];
let savedPath: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-gh-posted-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function installGhStub(body: string): void {
  const bin = tempDir();
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function makeBareDir(): { reposRoot: string; repoId: string } {
  const reposRoot = tempDir("quay-gh-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

// gh stub responding to:
//   - `gh api repos/{owner}/{repo}/pulls/<n>/reviews...` → the JSON body
//     provided by the caller
//   - `gh api graphql ... PullRequestReview ... comments` → empty inline
//     comments
// Any other invocation is fatal so tests fail loudly on accidental
// fallthrough (e.g. the adapter probing `gh api user`).
function stubReviewsRest(reviewsJson: string): string {
  return `
case "$*" in
  *"api"*"pulls/"*"/reviews"*)
    cat <<'JSON'
${reviewsJson}
JSON
    exit 0
    ;;
  *"api"*"graphql"*)
    echo '{"data":{"node":{"comments":{"nodes":[]}}}}'
    exit 0
    ;;
  *)
    echo "unexpected gh invocation: $*" 1>&2
    exit 99
    ;;
esac
`;
}

// REST review row for a GitHub App author posting an APPROVED review.
const BOT_APPROVED = `[
  {
    "id": 1,
    "node_id": "PRR_bot",
    "user": {"login": "didier-reviewer[bot]", "type": "Bot"},
    "body": "LGTM (bot)",
    "state": "APPROVED",
    "commit_id": "abc123"
  }
]`;

// REST review row for a regular user account posting an APPROVED review,
// where the user's login coincidentally matches the App slug.
const USER_APPROVED = `[
  {
    "id": 2,
    "node_id": "PRR_user",
    "user": {"login": "didier-reviewer", "type": "User"},
    "body": "LGTM (user)",
    "state": "APPROVED",
    "commit_id": "abc123"
  }
]`;

test("app/<slug> matches a Bot review with login <slug>[bot]", () => {
  installGhStub(stubReviewsRest(BOT_APPROVED));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "abc123",
    "app/didier-reviewer",
  );
  expect(posted).not.toBeNull();
  expect(posted!.decision).toBe("APPROVED");
  expect(posted!.reviewId).toBe("PRR_bot");
});

test("bare <slug> matches a User review with login <slug>", () => {
  installGhStub(stubReviewsRest(USER_APPROVED));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "abc123",
    "didier-reviewer",
  );
  expect(posted).not.toBeNull();
  expect(posted!.decision).toBe("APPROVED");
  expect(posted!.reviewId).toBe("PRR_user");
});

test("app/<slug> does NOT match a regular user named <slug> (identity preserved)", () => {
  // Approval-gate bypass guard: an attacker who controls a User account
  // sharing the App slug must not be able to satisfy a gate intended for
  // the App. The match must require user.type == "Bot".
  installGhStub(stubReviewsRest(USER_APPROVED));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "abc123",
    "app/didier-reviewer",
  );
  expect(posted).toBeNull();
});

test("bare <slug> does NOT match a Bot review with login <slug>[bot] (identity preserved)", () => {
  // Symmetric guard: an operator who configures the gate against a User
  // account must not have it satisfied by a Bot of the same slug.
  installGhStub(stubReviewsRest(BOT_APPROVED));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "abc123",
    "didier-reviewer",
  );
  expect(posted).toBeNull();
});

test("Bot review with wrong slug does not match", () => {
  installGhStub(stubReviewsRest(BOT_APPROVED));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "abc123",
    "app/some-other-bot",
  );
  expect(posted).toBeNull();
});

test("review against an older head_sha is ignored", () => {
  installGhStub(stubReviewsRest(BOT_APPROVED));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "def456",
    "app/didier-reviewer",
  );
  expect(posted).toBeNull();
});

test("most recent matching review wins when several share the author and SHA", () => {
  // Iteration is newest-first; the adapter must return PRR_third (the
  // last row), not PRR_first.
  const multi = `[
    {"id": 10, "node_id": "PRR_first",  "user": {"login": "didier-reviewer[bot]", "type": "Bot"}, "body": "first",  "state": "COMMENTED",        "commit_id": "abc123"},
    {"id": 11, "node_id": "PRR_second", "user": {"login": "didier-reviewer[bot]", "type": "Bot"}, "body": "second", "state": "APPROVED",         "commit_id": "abc123"},
    {"id": 12, "node_id": "PRR_third",  "user": {"login": "didier-reviewer[bot]", "type": "Bot"}, "body": "third",  "state": "CHANGES_REQUESTED","commit_id": "abc123"}
  ]`;
  installGhStub(stubReviewsRest(multi));
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const posted = adapter.fetchPostedReview(
    repoId,
    42,
    "abc123",
    "app/didier-reviewer",
  );
  expect(posted).not.toBeNull();
  expect(posted!.reviewId).toBe("PRR_third");
  expect(posted!.decision).toBe("CHANGES_REQUESTED");
});

// Regression: when a posted review's `author.login` comes back from
// `gh pr view --json reviews` without the `app/` prefix (the form
// the gh CLI returns for App-bot authors), `fetchPostedReview` must
// still match an operator-configured `expectedLogin` that *includes*
// the `app/` prefix — the form `gh pr view --json author`, the GitHub
// UI, and the natural reading of the bot identity all expose.
//
// Symmetric case: a configured bare-slug `expectedLogin` matches a
// review whose author.login carries the prefix. Future-proofs against
// any reversal of the gh CLI's prefix behavior on either field.
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

// gh stub: `pr view <n> --json reviews` returns a single APPROVED review
// authored by the bare-slug form `<slug>`; graphql inline-comments call
// returns an empty list. Any other invocation is fatal so the test fails
// loudly if the adapter probes anything unexpected (e.g. `gh api user`,
// which would defeat the point — `expectedLogin` must be honored).
const STUB_BARE_AUTHOR_APPROVED = `
case "$*" in
  *"pr view"*"--json reviews"*)
    cat <<'JSON'
{"reviews":[{"id":"PRR_ok","state":"APPROVED","body":"LGTM","author":{"login":"didier-reviewer"},"commit":{"oid":"abc123"}}]}
JSON
    exit 0
    ;;
  *"api graphql"*)
    echo '{"data":{"node":{"comments":{"nodes":[]}}}}'
    exit 0
    ;;
  *)
    echo "unexpected gh invocation: $*" 1>&2
    exit 99
    ;;
esac
`;

const STUB_PREFIXED_AUTHOR_APPROVED = `
case "$*" in
  *"pr view"*"--json reviews"*)
    cat <<'JSON'
{"reviews":[{"id":"PRR_ok","state":"APPROVED","body":"LGTM","author":{"login":"app/didier-reviewer"},"commit":{"oid":"abc123"}}]}
JSON
    exit 0
    ;;
  *"api graphql"*)
    echo '{"data":{"node":{"comments":{"nodes":[]}}}}'
    exit 0
    ;;
  *)
    echo "unexpected gh invocation: $*" 1>&2
    exit 99
    ;;
esac
`;

test("expectedLogin with app/ prefix matches a review author returned as a bare slug", () => {
  installGhStub(STUB_BARE_AUTHOR_APPROVED);
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
  expect(posted!.reviewId).toBe("PRR_ok");
});

test("expectedLogin without prefix still matches a bare-slug review author", () => {
  installGhStub(STUB_BARE_AUTHOR_APPROVED);
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
});

test("bare expectedLogin matches a review author returned with app/ prefix (symmetric)", () => {
  installGhStub(STUB_PREFIXED_AUTHOR_APPROVED);
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
});

test("expectedLogin does not match a different bot after prefix stripping", () => {
  installGhStub(STUB_BARE_AUTHOR_APPROVED);
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

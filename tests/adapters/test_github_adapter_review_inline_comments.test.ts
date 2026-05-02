// Regression: a CHANGES_REQUESTED review with an empty summary body but
// non-empty inline review comments must come back from `prSnapshot` with the
// inline comments folded into `latestReview.comments`. Previously the
// adapter only stored the review body, so the worker's review_comments
// artifact was effectively empty and the respawn carried no actionable
// feedback.
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

function tempDir(prefix = "quay-gh-review-"): string {
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

test("CHANGES_REQUESTED review with empty body but inline comments returns the inline comments", () => {
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[]'
    exit 0
    ;;
  *"api"*"graphql"*)
    cat <<'JSON'
{"data":{"node":{"comments":{"nodes":[
  {"path":"src/foo.ts","line":42,"originalLine":42,"body":"This is wrong, please fix"},
  {"path":"src/bar.ts","line":null,"originalLine":17,"body":"Add a guard here"}
]}}}}
JSON
    exit 0
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "baseRefOid":"def",
  "mergeable":"MERGEABLE",
  "reviewDecision":"CHANGES_REQUESTED",
  "latestReviews":[
    {"id":"PRR_xyz123","state":"CHANGES_REQUESTED","body":""}
  ]
}
JSON
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const snap = adapter.prSnapshot(repoId, "quay/branch");
  expect(snap).not.toBeNull();
  expect(snap!.latestReview.decision).toBe("CHANGES_REQUESTED");
  expect(snap!.latestReview.latestReviewId).toBe("PRR_xyz123");
  // The composed `comments` field carries the inline comments verbatim,
  // keyed by `path:line` (or just `path` when line is null).
  const comments = snap!.latestReview.comments;
  expect(comments).toContain("Inline review comments (2):");
  expect(comments).toContain("- src/foo.ts:42 — This is wrong, please fix");
  expect(comments).toContain("- src/bar.ts:17 — Add a guard here");
});

test("CHANGES_REQUESTED review with body AND inline comments returns both", () => {
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[]'
    exit 0
    ;;
  *"api"*"graphql"*)
    cat <<'JSON'
{"data":{"node":{"comments":{"nodes":[
  {"path":"src/foo.ts","line":10,"originalLine":10,"body":"Use a const"}
]}}}}
JSON
    exit 0
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "baseRefOid":"def",
  "mergeable":"MERGEABLE",
  "reviewDecision":"CHANGES_REQUESTED",
  "latestReviews":[
    {"id":"PRR_abc","state":"CHANGES_REQUESTED","body":"Overall approach is wrong, see inline."}
  ]
}
JSON
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const snap = adapter.prSnapshot(repoId, "quay/branch");
  expect(snap).not.toBeNull();
  const comments = snap!.latestReview.comments;
  // Body comes first.
  expect(comments.startsWith("Overall approach is wrong, see inline.")).toBe(true);
  expect(comments).toContain("Inline review comments (1):");
  expect(comments).toContain("- src/foo.ts:10 — Use a const");
});

test("non-CHANGES_REQUESTED review skips the inline-comment fetch", () => {
  // A NONE / APPROVED / COMMENTED decision doesn't trigger a respawn, so
  // there's no caller that would read inline comments — and we don't want
  // to pay for the extra graphql round-trip. Verified by making the
  // graphql endpoint fatal: if the adapter still calls it, the test fails.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[]'
    exit 0
    ;;
  *"api"*"graphql"*)
    echo 'unexpected: graphql should not be called for non-CHANGES_REQUESTED' 1>&2
    exit 99
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "baseRefOid":"def",
  "mergeable":"MERGEABLE",
  "reviewDecision":"APPROVED",
  "latestReviews":[
    {"id":"PRR_q","state":"APPROVED","body":"LGTM"}
  ]
}
JSON
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const snap = adapter.prSnapshot(repoId, "quay/branch");
  expect(snap).not.toBeNull();
  expect(snap!.latestReview.decision).toBe("APPROVED");
  expect(snap!.latestReview.comments).toBe("LGTM");
});

test("inline-comment fetch failure surfaces as a thrown error (fail closed)", () => {
  // A graphql failure at the inline-comment step must propagate, not be
  // swallowed: silently dropping inline comments would respawn the worker
  // with stale or empty feedback while looking like everything is fine.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[]'
    exit 0
    ;;
  *"api"*"graphql"*)
    echo 'API rate limit exceeded' 1>&2
    exit 1
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "baseRefOid":"def",
  "mergeable":"MERGEABLE",
  "reviewDecision":"CHANGES_REQUESTED",
  "latestReviews":[
    {"id":"PRR_q","state":"CHANGES_REQUESTED","body":"Please fix"}
  ]
}
JSON
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  expect(() => adapter.prSnapshot(repoId, "quay/branch")).toThrow(
    /rate limit|review comments/i,
  );
});

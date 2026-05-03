// Regression: GraphQL `comments(first: 100)` caps a CHANGES_REQUESTED
// review's inline comments at 100 per request and silently drops the rest
// without `pageInfo.hasNextPage` paging. Tick records the review id as
// acted-on after the respawn, so any comments past the first 100 would
// never be surfaced to the worker — the operator would see the task
// march to done while a reviewer's later requested changes hang
// unaddressed.
//
// The fix paginates: the adapter loops through pages until
// `hasNextPage` is false. We pin two contracts here:
//   1. A two-page response is fully concatenated (no truncation).
//   2. A malformed server response (hasNextPage=true with no advancing
//      cursor) throws rather than wedging or silently truncating.

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

function tempDir(prefix = "quay-gh-paging-"): string {
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
  const reposRoot = tempDir("quay-gh-paging-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

test("CHANGES_REQUESTED review with >100 inline comments is fully fetched across pages, not truncated", () => {
  // Stub gh: first graphql call (no `after` arg) returns a page with
  // hasNextPage=true and an endCursor. Second call (with `after=CURSOR1`)
  // returns the final page with hasNextPage=false. Adapter must
  // concatenate both pages into the composed comments string.
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
  *"api"*"graphql"*"after=CURSOR1"*)
    cat <<'JSON'
{"data":{"node":{"comments":{
  "nodes":[
    {"path":"src/page2-a.ts","line":1,"originalLine":1,"body":"page2 first comment"},
    {"path":"src/page2-b.ts","line":2,"originalLine":2,"body":"page2 last comment"}
  ],
  "pageInfo":{"hasNextPage":false,"endCursor":"CURSOR2"}
}}}}
JSON
    exit 0
    ;;
  *"api"*"graphql"*)
    cat <<'JSON'
{"data":{"node":{"comments":{
  "nodes":[
    {"path":"src/page1-a.ts","line":10,"originalLine":10,"body":"page1 first comment"},
    {"path":"src/page1-b.ts","line":20,"originalLine":20,"body":"page1 last comment"}
  ],
  "pageInfo":{"hasNextPage":true,"endCursor":"CURSOR1"}
}}}}
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
    {"id":"PRR_paged","state":"CHANGES_REQUESTED","body":""}
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
  // Both pages are folded into the composed feedback in order.
  expect(comments).toContain("Inline review comments (4):");
  expect(comments).toContain("- src/page1-a.ts:10 — page1 first comment");
  expect(comments).toContain("- src/page1-b.ts:20 — page1 last comment");
  expect(comments).toContain("- src/page2-a.ts:1 — page2 first comment");
  expect(comments).toContain("- src/page2-b.ts:2 — page2 last comment");
});

test("malformed paging response (hasNextPage=true with no advancing cursor) throws rather than truncating or wedging", () => {
  // Adversarial / buggy server: every page reports hasNextPage=true with
  // the same cursor. A naive loop would either spin forever or — worse —
  // re-fetch the same page until the safety cap and silently truncate.
  // Adapter must detect the non-advancing cursor and fail closed so the
  // operator sees a tick_error instead of a quietly-empty review.
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
{"data":{"node":{"comments":{
  "nodes":[{"path":"src/x.ts","line":1,"originalLine":1,"body":"first"}],
  "pageInfo":{"hasNextPage":true,"endCursor":null}
}}}}
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
    {"id":"PRR_bad","state":"CHANGES_REQUESTED","body":""}
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
    /advancing cursor|hasNextPage/i,
  );
});

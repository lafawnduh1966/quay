// Regression: some `gh` versions (e.g. the one shipped with current
// Debian/Ubuntu) return `gh pr view --json latestReviews` rows with
// `"id": ""` even when a review exists. The same review surfaced under
// `--json reviews` carries the real `PRR_…` GraphQL node id. The adapter
// must recover the id from the `reviews` projection so the inline-comment
// fetch (`gh api graphql node(id: …)`) doesn't get called with an empty
// id and tick doesn't loop on `Could not resolve to a node with the
// global id of ''` every cycle.
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
import {
  GitHubCliAdapter,
  type RunResult,
} from "../../src/adapters/github.ts";

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

function tempDir(prefix = "quay-gh-review-id-"): string {
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

test("empty latestReviews[].id is recovered from reviews by matching submittedAt/state", () => {
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
    # Reflect the id received so the test can assert what was queried.
    case "$*" in
      *"PRR_real_id"*)
        cat <<'JSON'
{"data":{"node":{"comments":{"nodes":[
  {"path":"src/foo.ts","line":7,"originalLine":7,"body":"Use a const"}
]}}}}
JSON
        exit 0
        ;;
      *)
        echo "graphql called with unexpected id: $*" 1>&2
        exit 99
        ;;
    esac
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "mergeable":"MERGEABLE",
  "reviewDecision":"CHANGES_REQUESTED",
  "latestReviews":[
    {"id":"","state":"APPROVED","body":"LGTM","submittedAt":"2026-05-13T10:33:15Z"},
    {"id":"","state":"CHANGES_REQUESTED","body":"please fix","submittedAt":"2026-05-13T10:44:50Z"}
  ],
  "reviews":[
    {"id":"PRR_old_approval","state":"APPROVED","body":"LGTM","submittedAt":"2026-05-13T10:33:15Z"},
    {"id":"PRR_real_id","state":"CHANGES_REQUESTED","body":"please fix","submittedAt":"2026-05-13T10:44:50Z"}
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
  // The real id from `reviews` is recovered and enrichment fires.
  expect(snap!.latestReview.latestReviewId).toBe("PRR_real_id");
  expect(snap!.latestReview.comments).toContain("please fix");
  expect(snap!.latestReview.comments).toContain(
    "Inline review comments (1):",
  );
  expect(snap!.latestReview.comments).toContain(
    "- src/foo.ts:7 — Use a const",
  );
});

test("empty latestReviews[].id with no matching submittedAt falls back to last state-matched review id", () => {
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
{"data":{"node":{"comments":{"nodes":[]}}}}
JSON
    exit 0
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "mergeable":"MERGEABLE",
  "reviewDecision":"CHANGES_REQUESTED",
  "latestReviews":[
    {"id":"","state":"CHANGES_REQUESTED","body":"please fix"}
  ],
  "reviews":[
    {"id":"PRR_first_cr","state":"CHANGES_REQUESTED","body":"nope"},
    {"id":"PRR_second_cr","state":"CHANGES_REQUESTED","body":"please fix"}
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
  // Without a submittedAt to disambiguate, the newest state-matched id wins.
  expect(snap!.latestReview.latestReviewId).toBe("PRR_second_cr");
});

test("empty latestReviews[].id with no recoverable reviews row yields null (no graphql call)", () => {
  // Reviews list is empty (or carries no usable id). Without a recoverable
  // node id, the guard must short-circuit the graphql fetch — otherwise
  // `gh api graphql node(id: "")` errors and tick loops on tick_error.
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
    echo 'unexpected: graphql must not be called when no id can be resolved' 1>&2
    exit 99
    ;;
  *"view"*)
    cat <<'JSON'
{
  "state":"OPEN",
  "headRefOid":"abc",
  "mergeable":"MERGEABLE",
  "reviewDecision":"CHANGES_REQUESTED",
  "latestReviews":[
    {"id":"","state":"CHANGES_REQUESTED","body":"please fix"}
  ],
  "reviews":[]
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
  expect(snap!.latestReview.latestReviewId).toBeNull();
  // The summary body still survives — only the inline-comment enrichment
  // is skipped when no node id is recoverable.
  expect(snap!.latestReview.comments).toBe("please fix");
});

// Pin the gh `pr view --json` field set: the snapshot read must request
// `reviews` alongside `latestReviews` so the adapter can recover the
// review node id when `latestReviews[].id` comes back empty.
class RecordingAdapter extends GitHubCliAdapter {
  readonly cmds: string[][] = [];
  responder: (cmd: string[]) => RunResult = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  constructor() {
    super("/tmp/quay-stub-reviews-field");
  }

  protected override run(_repoId: string, cmd: string[]): RunResult {
    this.cmds.push(cmd);
    return this.responder(cmd);
  }
}

test("snapshot read requests `reviews` alongside `latestReviews`", () => {
  const adapter = new RecordingAdapter();
  adapter.responder = (cmd) => {
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      const fieldsArg = cmd[cmd.indexOf("--json") + 1] ?? "";
      const fields = fieldsArg.split(",");
      if (fields.length > 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 1,
            url: "https://example.com/pr/1",
            state: "OPEN",
            headRefOid: "h",
            baseRefName: "main",
            mergeable: "MERGEABLE",
            reviewDecision: "NONE",
            latestReviews: [],
            reviews: [],
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ headRefOid: "h" }), stderr: "" };
    }
    if (cmd[0] === "git" && cmd[1] === "merge-base") {
      return { exitCode: 0, stdout: "mb\n", stderr: "" };
    }
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      return { exitCode: 0, stdout: "tip\n", stderr: "" };
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "checks") {
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }
    throw new Error(`unexpected cmd ${JSON.stringify(cmd)}`);
  };

  adapter.prSnapshot("repo", "quay/branch");

  const richView = adapter.cmds.find(
    (c) =>
      c[0] === "gh" &&
      c[1] === "pr" &&
      c[2] === "view" &&
      (c[c.indexOf("--json") + 1] ?? "").split(",").length > 1,
  );
  expect(richView).toBeDefined();
  const fields = new Set(
    (richView![richView!.indexOf("--json") + 1] ?? "").split(","),
  );
  expect(fields.has("latestReviews")).toBe(true);
  expect(fields.has("reviews")).toBe(true);
});

// Spec §13: the real git adapter enforces the final `git check-ref-format`
// gate as a defense-in-depth layer below the JS-side slug normalizer. If the
// upstream slug ever produces a value that git rejects, the adapter falls
// back to `task-<id>`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { LocalGitAdapter } from "../../src/adapters/git.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempReposRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-git-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("test_git_adapter_branch_slug_final_check_ref_format", () => {
  const adapter = new LocalGitAdapter(tempReposRoot());
  // `feat/abc-123` satisfies refs/heads/quay/<slug>.
  expect(adapter.safeBranchSlug("feat/abc-123", "abcd1234")).toBe(
    "feat/abc-123",
  );
});

test("test_git_adapter_invalid_slug_falls_back_to_task_id", () => {
  const adapter = new LocalGitAdapter(tempReposRoot());

  // Each of these is rejected by `git check-ref-format refs/heads/quay/<slug>`.
  // They're chosen so that even if the JS slug fails to filter them, the
  // adapter's final gate still rejects.
  const invalids = [
    "..feat",
    "feat..weird",
    "feat.",
    "feat.lock",
    "/leading-slash",
    "trailing-slash/",
    "has space",
    "has\nnewline",
    "back\\slash",
    "tilde~one",
    "caret^one",
    "colon:one",
    "question?one",
    "asterisk*one",
    "open[bracket",
  ];
  for (const slug of invalids) {
    expect(adapter.safeBranchSlug(slug, "abcd1234")).toBe("task-abcd1234");
  }
});

test("test_git_adapter_empty_slug_falls_back", () => {
  const adapter = new LocalGitAdapter(tempReposRoot());
  expect(adapter.safeBranchSlug("", "deadbeef")).toBe("task-deadbeef");
});

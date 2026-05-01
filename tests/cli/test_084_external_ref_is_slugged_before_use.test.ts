import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { isValidGitRef } from "../../src/core/branch_slug.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO_INPUT = {
  repo_id: "repo-adversarial",
  repo_url: "git@example.com:owner/r.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

interface AdversarialCase {
  external_ref: string;
  description: string;
}

// Each case carries a name and an external_ref. The branch name must satisfy
// `git check-ref-format refs/heads/<branch>`; the tmux id must contain only
// safe ASCII; the row must preserve the verbatim string.
const CASES: AdversarialCase[] = [
  { description: "path traversal", external_ref: "../../etc/passwd" },
  { description: "shell metas", external_ref: "feat; rm -rf /" },
  {
    description: "git ref-illegal chars",
    external_ref: "feat~1^2:foo?bar*baz[qux]\\quux",
  },
  { description: "leading/trailing dots", external_ref: "..feat.." },
  { description: "double-dot inside", external_ref: "feat..weird" },
  { description: ".lock suffix", external_ref: "feat.lock" },
  { description: "spaces and tabs", external_ref: "spaces in\tref" },
  { description: "control chars", external_ref: "ctl\x00\x01\x1fend" },
  { description: "empty string", external_ref: "" },
  { description: "only invalid chars", external_ref: "@#$%^&*()" },
  { description: "long ref", external_ref: "a".repeat(300) },
];

test("test_084_external_ref_is_slugged_before_use", async () => {
  for (const c of CASES) {
    h = createHarness();
    createRepoService({ db: h.db, clock: h.clock }).add({ ...REPO_INPUT });

    const built = buildCliDeps(h);
    const io = bufferIO();

    const result = await dispatch(
      [
        "enqueue",
        "--input",
        JSON.stringify({
          repo_id: REPO_INPUT.repo_id,
          brief: "do the thing",
          external_ref: c.external_ref,
        }),
      ],
      built.deps,
      io,
    );

    expect(result.exitCode).toBe(0);
    expect(io.err()).toBe("");
    const enqueueResult = JSON.parse(io.out().trim());
    expect(typeof enqueueResult.task_id).toBe("string");

    // Verbatim external_ref preserved in SQL.
    const row = h.db
      .query<
        {
          external_ref: string | null;
          branch_name: string;
          tmux_id: string;
        },
        [string]
      >(
        "SELECT external_ref, branch_name, tmux_id FROM tasks WHERE task_id = ?",
      )
      .get(enqueueResult.task_id);
    expect(row).not.toBeNull();
    expect(row!.external_ref).toBe(c.external_ref);

    // Branch name normalized: must satisfy git's ref-format rules.
    expect(row!.branch_name.startsWith("quay/")).toBe(true);
    expect(isValidGitRef(row!.branch_name)).toBe(true);
    // Branch name must NOT contain the raw adversarial string verbatim, since
    // by construction every case in CASES has at least one ref-illegal char.
    if (c.external_ref.length > 0) {
      // The raw value contains ref-illegal characters — the slugger must have
      // rewritten them, so the verbatim ref cannot appear inside the branch.
      expect(row!.branch_name.includes(c.external_ref)).toBe(false);
    }

    // tmux id: ASCII identifier characters only (letters, digits, dash,
    // underscore). Real tmux session names must be safe to pass to a shell.
    expect(/^[A-Za-z0-9_-]+$/.test(row!.tmux_id)).toBe(true);

    h.cleanup();
    h = null;
  }
});

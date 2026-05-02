import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";

// Regression: enqueue used to pass the bare slug ("ITRY-900") to worktreeAdd
// while storing the full `quay/<slug>` form in SQL. The result was a worker
// checked out on `ITRY-900` whose pushes never matched the `quay/<slug>` ref
// that tick / GitHub polling / cleanup look for. Both sides must agree.
let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO = {
  repo_id: "repo-branch-match",
  repo_url: "git@example.com:owner/branch-match.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("enqueue_worktree_branch_matches_sql_branch_name", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  h.ids.push("aaaaaaaabbbbccccddddeeeeeeeeffff");

  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-900",
    brief: "Implement feature X",
  });

  // SQL branch_name carries the `quay/<slug>` form.
  expect(result.branch_name).toBe("quay/ITRY-900");

  // The worktree's checked-out branch is the SAME ref — not the bare slug.
  const checkout = built.git.worktreeBranches.get(result.worktree_path);
  expect(checkout).toBeDefined();
  expect(checkout!.repoId).toBe(REPO.repo_id);
  expect(checkout!.branch).toBe("quay/ITRY-900");

  // The worktreeAdd record stored the full ref, not the bare slug. This is
  // the ref the worker's `git push` will target, so it has to agree with
  // what tick / GitHub polling later look up.
  const worktreeAddCall = built.git.calls.find((c) => c.op === "worktreeAdd");
  expect(worktreeAddCall).toBeDefined();
  expect(worktreeAddCall!.args.branch).toBe("quay/ITRY-900");
});

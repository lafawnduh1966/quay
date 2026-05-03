// Regression: `cancel` is destructive (kills the tmux session, removes the
// worktree, optionally closes the PR). The dispatcher used to read the
// destructive flags via `argv.includes("--keep-worktree")` with no
// unknown-flag validation. A misspelled `--keep-worktre` would silently
// evaluate to `false` and the operator would lose the on-disk worktree
// state they explicitly asked to preserve.
//
// The fix rejects any unknown long flag on `cancel` BEFORE invoking the
// finalizer. We verify (a) the misspelled flag exits non-zero with a
// usage_error, (b) no worktree-removing or branch-mutating call is made
// on the underlying adapters, (c) the task is not transitioned out of its
// pre-cancel state.

import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("cancel with a misspelled --keep-worktre rejects usage_error and runs no destructive side effects", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-cancel-typo");
  const taskId = insertTask(h.db, {
    taskId: "task-cancel-typo",
    repoId,
    state: "running",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });

  const built = buildCliDeps(h);
  const stateBefore = h.db
    .query<{ state: string; updated_at: string }, [string]>(
      `SELECT state, updated_at FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!;
  const eventsBefore = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ?`,
    )
    .get(taskId)!.n;

  const io = bufferIO();
  const result = await dispatch(
    ["cancel", taskId, "--keep-worktre"], // typo: missing trailing 'e'
    built.deps,
    io,
  );

  // Hard exit, structured error.
  expect(result.exitCode).not.toBe(0);
  expect(io.out()).toBe("");
  const parsed = JSON.parse(io.err().trim());
  expect(parsed.error).toBe("usage_error");
  expect(typeof parsed.message).toBe("string");
  // The bad flag itself appears in the message so the operator can locate
  // the typo without re-reading their shell history.
  expect(parsed.message).toContain("--keep-worktre");

  // No destructive substrate calls. The cancel finalizer would otherwise
  // call worktreeRemove/worktreeDetach/deleteRemoteBranch on git and kill
  // on tmux. None of those should have happened.
  const destructiveGitOps = built.git.calls.filter(
    (c) =>
      c.op === "worktreeRemove" ||
      c.op === "worktreeDetach" ||
      c.op === "deleteRemoteBranch" ||
      c.op === "branchDelete",
  );
  expect(destructiveGitOps).toHaveLength(0);
  expect(built.tmux.killCalls).toHaveLength(0);

  // Task state is untouched — no `cancelled` event, no state transition.
  const stateAfter = h.db
    .query<{ state: string; updated_at: string }, [string]>(
      `SELECT state, updated_at FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!;
  expect(stateAfter.state).toBe(stateBefore.state);
  expect(stateAfter.updated_at).toBe(stateBefore.updated_at);
  const eventsAfter = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ?`,
    )
    .get(taskId)!.n;
  expect(eventsAfter).toBe(eventsBefore);
});

test("cancel rejects the --flag=value form for --keep-worktree / --close-pr and runs no destructive side effects", async () => {
  // The unknown-flag validator strips `=value` before the membership check,
  // so `--keep-worktree=true` passes that gate. But the detector below uses
  // `argv.includes("--keep-worktree")` (exact-match), which returns false
  // for the element `--keep-worktree=true` — net result is the destructive
  // cancel path runs anyway and deletes the worktree the operator asked to
  // preserve. Same hazard for `--close-pr=true`. Reject the `=value` form
  // outright as a usage_error so the two layers stay aligned.
  for (const flag of ["--keep-worktree=true", "--close-pr=true"]) {
    h?.cleanup();
    h = createHarness();
    h.clock.set("2026-04-28T10:00:00.000Z");
    const repoId = insertRepo(h.db, `repo-cancel-eqval-${flag.length}`);
    const taskId = insertTask(h.db, {
      taskId: `task-cancel-eqval-${flag.length}`,
      repoId,
      state: "running",
    });
    insertAttempt(h.db, {
      taskId,
      attemptNumber: 1,
      spawnedAt: "2026-04-28T09:00:00.000Z",
    });

    const built = buildCliDeps(h);
    const stateBefore = h.db
      .query<{ state: string; updated_at: string }, [string]>(
        `SELECT state, updated_at FROM tasks WHERE task_id = ?`,
      )
      .get(taskId)!;

    const io = bufferIO();
    const result = await dispatch(["cancel", taskId, flag], built.deps, io);

    expect(result.exitCode).not.toBe(0);
    expect(io.out()).toBe("");
    const parsed = JSON.parse(io.err().trim());
    expect(parsed.error).toBe("usage_error");
    expect(parsed.message).toContain(flag);

    const destructiveGitOps = built.git.calls.filter(
      (c) =>
        c.op === "worktreeRemove" ||
        c.op === "worktreeDetach" ||
        c.op === "deleteRemoteBranch" ||
        c.op === "branchDelete",
    );
    expect(destructiveGitOps).toHaveLength(0);
    expect(built.tmux.killCalls).toHaveLength(0);

    const stateAfter = h.db
      .query<{ state: string; updated_at: string }, [string]>(
        `SELECT state, updated_at FROM tasks WHERE task_id = ?`,
      )
      .get(taskId)!;
    expect(stateAfter.state).toBe(stateBefore.state);
    expect(stateAfter.updated_at).toBe(stateBefore.updated_at);
  }
});

test("cancel still accepts the spelled-correctly --keep-worktree and --close-pr flags", async () => {
  // Sanity check that the unknown-flag guard didn't accidentally reject
  // the legitimate flags. We point at a non-existent task so the call
  // surfaces the downstream `unknown_task` error — but the important bit
  // is that it's NOT `usage_error: unknown cancel flag`. If the new
  // validator regressed, both flag forms would short-circuit before
  // reaching cancel_task and the error code would be `usage_error`.
  h = createHarness();
  const built = buildCliDeps(h);

  for (const flag of ["--keep-worktree", "--close-pr"]) {
    const io = bufferIO();
    const result = await dispatch(
      ["cancel", "task-does-not-exist", flag],
      built.deps,
      io,
    );
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(io.err().trim());
    expect(parsed.error).toBe("unknown_task");
  }
});

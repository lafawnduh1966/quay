// Spec §13: `retry_budget` is a deployment-level knob (default 5). When the
// operator sets it in `~/.quay/config.toml`, the production CLI must forward
// the value all the way through dispatch → enqueue so the persisted
// `tasks.retry_budget` reflects the deployment override (not the
// EnqueueDeps default).
//
// This test wires CliDeps directly (skipping the file loader) and asserts
// that `deps.retryBudget` ends up in the row enqueue writes. The loader's
// own contract — that `retry_budget` is parsed and rejected when invalid —
// is covered by tests/cli/test_config_loader.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";

let h: Harness | null = null;
let scratchDirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  h = null;
  for (const d of scratchDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function writeTemp(contents: string, name = "f.md"): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-cli-rb-"));
  scratchDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

test("enqueue dispatch honors deps.retryBudget when set (overrides default)", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  // Operator-configured retry budget — distinct from the default 5 so we
  // can prove the override actually flowed through.
  built.deps.retryBudget = 11;

  // Pre-register the repo so we exercise enqueue, not repo add.
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "repo-rb",
      "--url",
      "git@example.com:o/r.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );

  const briefPath = writeTemp("brief", "b.md");
  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", "repo-rb", "--brief-file", briefPath],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const enqueued = JSON.parse(io.out().trim());

  const row = h.db
    .query<{ retry_budget: number }, [string]>(
      `SELECT retry_budget FROM tasks WHERE task_id = ?`,
    )
    .get(enqueued.task_id);
  expect(row?.retry_budget).toBe(11);
});

test("enqueue dispatch falls back to enqueue's DEFAULT_RETRY_BUDGET when deps.retryBudget unset", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  // Deliberately do NOT set retryBudget — empty config is the no-override
  // case and enqueue should apply its own default (spec §13 = 5).

  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "repo-rb-default",
      "--url",
      "git@example.com:o/r.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );

  const briefPath = writeTemp("brief", "b.md");
  const io = bufferIO();
  const result = await dispatch(
    ["enqueue", "--repo", "repo-rb-default", "--brief-file", briefPath],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const enqueued = JSON.parse(io.out().trim());
  const row = h.db
    .query<{ retry_budget: number }, [string]>(
      `SELECT retry_budget FROM tasks WHERE task_id = ?`,
    )
    .get(enqueued.task_id);
  expect(row?.retry_budget).toBe(5);
});

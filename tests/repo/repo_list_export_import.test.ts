// Spec §10: `quay repo list`, `quay repo export [--out <path>]`, and
// `quay repo import --in <path>` round out the operator-facing repo
// surface. List exposes the registry; export dumps it as JSON; import
// upserts a dump for idempotent restore. These tests pin the dispatch
// wiring AND the round-trip property (export → wipe → import → list
// reproduces the original rows).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "quay-repo-cli-"));
  scratchDirs.push(d);
  return d;
}

async function addRepo(
  built: ReturnType<typeof buildCliDeps>,
  id: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const flags = [
    "repo",
    "add",
    "--id",
    id,
    "--url",
    overrides.url ?? `git@example.com:owner/${id}.git`,
    "--base-branch",
    overrides.base_branch ?? "main",
    "--package-manager",
    overrides.package_manager ?? "bun",
    "--install-cmd",
    overrides.install_cmd ?? "bun install",
  ];
  const io = bufferIO();
  const result = await dispatch(flags, built.deps, io);
  expect(result.exitCode).toBe(0);
}

test("repo list returns all registered repos as a JSON array, ordered by repo_id", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-c");
  await addRepo(built, "repo-a");
  await addRepo(built, "repo-b");

  const io = bufferIO();
  const result = await dispatch(["repo", "list"], built.deps, io);
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");

  const parsed = JSON.parse(io.out());
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.map((r: { repo_id: string }) => r.repo_id)).toEqual([
    "repo-a",
    "repo-b",
    "repo-c",
  ]);
  // Each row has the full RepoRow shape — including archived_at and
  // created_at — so a downstream consumer can roundtrip into `repo import`.
  expect(parsed[0]).toMatchObject({
    repo_id: "repo-a",
    archived_at: null,
    base_branch: "main",
    install_cmd: "bun install",
    package_manager: "bun",
  });
  expect(typeof parsed[0].created_at).toBe("string");
});

test("repo list returns an empty JSON array when no repos are registered", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();
  const result = await dispatch(["repo", "list"], built.deps, io);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toEqual([]);
});

test("repo export with no --out flag emits the JSON dump on stdout", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-x");
  await addRepo(built, "repo-y");

  const io = bufferIO();
  const result = await dispatch(["repo", "export"], built.deps, io);
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");

  const parsed = JSON.parse(io.out());
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(2);
  expect(parsed.map((r: { repo_id: string }) => r.repo_id).sort()).toEqual([
    "repo-x",
    "repo-y",
  ]);
});

test("repo export --out <path> writes the dump to the file and emits a summary", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-out-1");
  await addRepo(built, "repo-out-2");

  const dumpPath = join(tempDir(), "repos.json");
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "export", "--out", dumpPath],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);

  const onDisk = JSON.parse(readFileSync(dumpPath, "utf8"));
  expect(onDisk).toHaveLength(2);

  // Stdout is a small operator-friendly summary, NOT the dump itself —
  // operators often pipe stdout to logs and don't want a multi-MB blob.
  const summary = JSON.parse(io.out());
  expect(summary).toEqual({ out: dumpPath, count: 2 });
});

test("repo import --in <path> upserts every row from a dump and emits a summary", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const dump = [
    {
      repo_id: "repo-fresh-1",
      repo_url: "git@example.com:owner/fresh-1.git",
      base_branch: "main",
      package_manager: "bun",
      install_cmd: "bun install",
    },
    {
      repo_id: "repo-fresh-2",
      repo_url: "git@example.com:owner/fresh-2.git",
      base_branch: "trunk",
      package_manager: "npm",
      install_cmd: "npm ci",
      test_cmd: "npm test",
    },
  ];
  const dumpPath = join(tempDir(), "import.json");
  writeFileSync(dumpPath, JSON.stringify(dump));

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "import", "--in", dumpPath],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toEqual({
    imported: 2,
    repo_ids: ["repo-fresh-1", "repo-fresh-2"],
  });

  // Both rows are now persisted with the dump's fields.
  const listIO = bufferIO();
  await dispatch(["repo", "list"], built.deps, listIO);
  const parsed = JSON.parse(listIO.out());
  expect(parsed).toHaveLength(2);
  const second = parsed.find(
    (r: { repo_id: string }) => r.repo_id === "repo-fresh-2",
  );
  expect(second).toMatchObject({
    base_branch: "trunk",
    package_manager: "npm",
    install_cmd: "npm ci",
    test_cmd: "npm test",
  });
});

test("repo import is a true upsert: re-importing the same dump is idempotent and updates fields", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  // Pre-seed an existing repo with old fields. Then import a dump that
  // changes its install_cmd. The existing row must be updated in place;
  // count stays at 1 (no duplicate insert).
  await addRepo(built, "repo-up", {
    install_cmd: "old install cmd",
  });

  const dump = [
    {
      repo_id: "repo-up",
      repo_url: "git@example.com:owner/repo-up.git",
      base_branch: "main",
      package_manager: "bun",
      install_cmd: "new install cmd",
    },
  ];
  const dumpPath = join(tempDir(), "upsert.json");
  writeFileSync(dumpPath, JSON.stringify(dump));

  // First import: applies the change.
  await dispatch(["repo", "import", "--in", dumpPath], built.deps, bufferIO());
  // Second import: idempotent — same fields, no error.
  const io2 = bufferIO();
  const result2 = await dispatch(
    ["repo", "import", "--in", dumpPath],
    built.deps,
    io2,
  );
  expect(result2.exitCode).toBe(0);

  const listIO = bufferIO();
  await dispatch(["repo", "list"], built.deps, listIO);
  const parsed = JSON.parse(listIO.out());
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({
    repo_id: "repo-up",
    install_cmd: "new install cmd",
  });
});

test("repo import preserves archived_at when the dump carries it (full-fidelity restore)", async () => {
  // The documented use case is "backup → restore." If the export captured
  // an archived row, the import must restore it as archived; otherwise a
  // restore would silently reactivate previously-soft-deleted repos.
  h = createHarness();
  const built = buildCliDeps(h);

  const archivedAt = "2026-01-15T08:30:00.000Z";
  const dump = [
    {
      repo_id: "repo-archived",
      repo_url: "git@example.com:owner/archived.git",
      base_branch: "main",
      package_manager: "bun",
      install_cmd: "bun install",
      archived_at: archivedAt,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const dumpPath = join(tempDir(), "archived.json");
  writeFileSync(dumpPath, JSON.stringify(dump));

  await dispatch(["repo", "import", "--in", dumpPath], built.deps, bufferIO());

  const listIO = bufferIO();
  await dispatch(["repo", "list"], built.deps, listIO);
  const parsed = JSON.parse(listIO.out());
  expect(parsed[0]).toMatchObject({
    repo_id: "repo-archived",
    archived_at: archivedAt,
    created_at: "2026-01-01T00:00:00.000Z",
  });
});

test("repo export → wipe → repo import is a faithful round-trip", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-rt-a");
  await addRepo(built, "repo-rt-b");

  // Export to a file.
  const dumpPath = join(tempDir(), "rt.json");
  await dispatch(
    ["repo", "export", "--out", dumpPath],
    built.deps,
    bufferIO(),
  );

  // Wipe via direct DB delete (the operator's "fresh DB" scenario).
  built.deps.db.exec("DELETE FROM repos");

  // Re-import from the file.
  const importIO = bufferIO();
  await dispatch(
    ["repo", "import", "--in", dumpPath],
    built.deps,
    importIO,
  );
  expect(JSON.parse(importIO.out()).imported).toBe(2);

  // The post-import list matches the pre-export list.
  const listIO = bufferIO();
  await dispatch(["repo", "list"], built.deps, listIO);
  const restored = JSON.parse(listIO.out());
  expect(restored.map((r: { repo_id: string }) => r.repo_id).sort()).toEqual([
    "repo-rt-a",
    "repo-rt-b",
  ]);
});

test("repo import errors with usage_error when --in is omitted", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();
  const result = await dispatch(["repo", "import"], built.deps, io);
  expect(result.exitCode).toBe(1);
  expect(io.out()).toBe("");
  const parsed = JSON.parse(io.err());
  expect(parsed.error).toBe("usage_error");
  expect(parsed.message).toMatch(/--in/);
});

test("repo import errors when the file is not a JSON array", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dumpPath = join(tempDir(), "not-array.json");
  writeFileSync(dumpPath, JSON.stringify({ repo_id: "single-object" }));

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "import", "--in", dumpPath],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const parsed = JSON.parse(io.err());
  expect(parsed.error).toBe("usage_error");
  expect(parsed.message).toMatch(/array/i);
});

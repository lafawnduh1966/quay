import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService, type RepoRow } from "../../src/core/repos/service.ts";
import { QuayError } from "../../src/core/errors.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REQUIRED_FIELDS = {
  repo_id: "repo-1",
  repo_url: "git@example.com:owner/repo.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

function repoCount(harness: Harness): number {
  return harness.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM repos")
    .get()!.c;
}

function readRepo(harness: Harness, repoId: string): RepoRow | null {
  return (
    harness.db
      .query<RepoRow, [string]>(
        `SELECT repo_id, repo_url, base_branch, package_manager, install_cmd,
                test_cmd, ci_workflow_name, contribution_guide_path,
                archived_at, created_at
         FROM repos WHERE repo_id = ?`,
      )
      .get(repoId) ?? null
  );
}

test("test_repo_add_persists_required_repo_config", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  const created = repos.add({ ...REQUIRED_FIELDS });
  expect(created.repo_id).toBe(REQUIRED_FIELDS.repo_id);
  expect(created.archived_at).toBeNull();

  const row = readRepo(h, REQUIRED_FIELDS.repo_id);
  expect(row).not.toBeNull();
  expect(row!.repo_url).toBe(REQUIRED_FIELDS.repo_url);
  expect(row!.base_branch).toBe(REQUIRED_FIELDS.base_branch);
  expect(row!.package_manager).toBe(REQUIRED_FIELDS.package_manager);
  expect(row!.install_cmd).toBe(REQUIRED_FIELDS.install_cmd);
  expect(row!.test_cmd).toBeNull();
  expect(row!.ci_workflow_name).toBeNull();
  expect(row!.contribution_guide_path).toBeNull();
  expect(row!.archived_at).toBeNull();
  expect(row!.created_at).toBe(h.clock.nowISO());
});

test("test_repo_add_persists_optional_repo_config", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  // ci_workflow_name omitted on purpose to confirm absence is not an error.
  repos.add({
    ...REQUIRED_FIELDS,
    repo_id: "repo-with-test",
    test_cmd: "bun test",
    contribution_guide_path: "docs/CONTRIBUTING.md",
  });

  const row1 = readRepo(h, "repo-with-test")!;
  expect(row1.test_cmd).toBe("bun test");
  expect(row1.ci_workflow_name).toBeNull();
  expect(row1.contribution_guide_path).toBe("docs/CONTRIBUTING.md");

  // All optional fields supplied.
  repos.add({
    ...REQUIRED_FIELDS,
    repo_id: "repo-full",
    test_cmd: "bun test --coverage",
    ci_workflow_name: "ci.yml",
    contribution_guide_path: "CONTRIBUTING.md",
  });

  const row2 = readRepo(h, "repo-full")!;
  expect(row2.test_cmd).toBe("bun test --coverage");
  expect(row2.ci_workflow_name).toBe("ci.yml");
  expect(row2.contribution_guide_path).toBe("CONTRIBUTING.md");
});

test("test_repo_add_rejects_duplicate_id", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  repos.add({ ...REQUIRED_FIELDS });

  let caught: unknown;
  try {
    repos.add({
      ...REQUIRED_FIELDS,
      repo_url: "git@example.com:other/repo.git",
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("duplicate_repo");

  // The original row was not overwritten by the failed second add.
  expect(repoCount(h)).toBe(1);
  const row = readRepo(h, REQUIRED_FIELDS.repo_id)!;
  expect(row.repo_url).toBe(REQUIRED_FIELDS.repo_url);
});

test("test_repo_add_requires_minimum_fields", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  const invalidInputs: unknown[] = [
    {},
    { repo_id: "repo-1" },
    {
      repo_id: "repo-1",
      repo_url: "git@example.com:owner/repo.git",
      base_branch: "main",
      package_manager: "bun",
      // install_cmd missing
    },
    {
      // empty strings are not acceptable for required fields
      repo_id: "",
      repo_url: "git@example.com:owner/repo.git",
      base_branch: "main",
      package_manager: "bun",
      install_cmd: "bun install",
    },
  ];

  for (const bad of invalidInputs) {
    let caught: unknown;
    try {
      repos.add(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("validation_error");
  }

  expect(repoCount(h)).toBe(0);
});

test("test_repo_add_rejects_unsafe_repo_ids", () => {
  // The real git adapter uses repo_id directly in filesystem paths
  // (`<reposRoot>/<repo_id>.git`), so an id like `../escape` would write
  // outside the data dir. Schema validation must reject anything containing
  // path separators or `..`.
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  const unsafeIds = [
    "../escape",
    "..",
    ".",
    "foo/bar",
    "foo\\bar",
    "abc def", // whitespace
    "abc\u0000def", // NUL
    "abc\u0001def", // control char
    "é", // non-ASCII (the schema is intentionally ASCII-only)
  ];
  for (const id of unsafeIds) {
    let caught: unknown;
    try {
      repos.add({ ...REQUIRED_FIELDS, repo_id: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("validation_error");
  }

  // Sanity: the safe ids the existing test suite uses are still accepted.
  for (const id of ["repo-1", "repo_1", "repo.1", "ABC123"]) {
    const row = repos.add({ ...REQUIRED_FIELDS, repo_id: id });
    expect(row.repo_id).toBe(id);
  }
});

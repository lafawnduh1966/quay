// Ticket validator tests per validator-spec §9.
//
// Test names below match the §9 table verbatim — the slice gate enforces
// those names. We exercise the CLI handler directly (no dispatch wrap) so
// tests don't need to construct a full CliDeps; the dispatch wiring is a
// 1-line switch case and any regression there is caught by the existing
// `test_cli_spec_command_surface` smoke tests.

import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferIO } from "../../src/cli/io.ts";
import { handleValidateTicket } from "../../src/cli/validate_ticket.ts";
import { loadSchema, parseSchema } from "../../src/validator/load_schema.ts";
import { validateTicket } from "../../src/validator/validate.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-validator-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function writeFile(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

// Empty config dir → handler falls through to the shipped default schema
// (config/ticket_schema.toml). Use this when a test wants the §6 schema.
function shippedDefaultEnv(): { QUAY_CONFIG_DIR: string } {
  return { QUAY_CONFIG_DIR: tempDir() };
}

const VALID_DRAFT = {
  body:
    "Refactor the auth-session cache to evict entries when a user logs out. Context: stale entries persist for 30 minutes after revocation.",
  repo: "my-repo",
  tags: ["auth-session", "cache"],
  authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
};

function pipeJson(payload: unknown, schemaFile?: string, extra: string[] = []) {
  const io = bufferIO();
  io.setStdin(JSON.stringify(payload));
  const argv = ["--ticket-json", "-", ...extra];
  if (schemaFile !== undefined) {
    argv.push("--schema-file", schemaFile);
  }
  return { io, run: (env: Record<string, string> = shippedDefaultEnv()) => handleValidateTicket(argv, io, env) };
}

// --- §9 table tests ------------------------------------------------------

test("test_validate_ticket_passes_well_formed_input", () => {
  const { io, run } = pipeJson(VALID_DRAFT);
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("test_validate_ticket_fails_on_missing_required_field", () => {
  const { tags: _omitted, ...withoutTags } = VALID_DRAFT;
  const { io, run } = pipeJson(withoutTags);
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  expect(out.valid).toBe(false);
  const missing = out.errors.filter((e: { code: string }) => e.code === "MISSING");
  expect(missing).toHaveLength(1);
  expect(missing[0].field).toBe("tags");
});

test("test_validate_ticket_fails_on_type_mismatch", () => {
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    body: 12345, // body must be a string
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const typeErrs = out.errors.filter((e: { code: string }) => e.code === "TYPE");
  expect(typeErrs).toHaveLength(1);
  expect(typeErrs[0].field).toBe("body");
});

test("test_validate_ticket_fails_on_pattern_mismatch", () => {
  // authors[0].slack_id requires `^U[A-Z0-9]+$`. "u-lowercase" fails it.
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    authors: [{ name: "x", slack_id: "u06tdc56vjb" }],
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const patternErrs = out.errors.filter((e: { code: string }) => e.code === "PATTERN");
  expect(patternErrs).toHaveLength(1);
  expect(patternErrs[0].field).toBe("authors[0].slack_id");
});

test("test_validate_ticket_fails_on_charset_violation", () => {
  // tags is charset = lowercase_alphanum_dash. UPPERCASE fails the charset.
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    tags: ["AuthSession"], // mixed case → CHARSET error
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const charsetErrs = out.errors.filter((e: { code: string }) => e.code === "CHARSET");
  expect(charsetErrs).toHaveLength(1);
  expect(charsetErrs[0].field).toBe("tags[0]");
});

test("test_validate_ticket_fails_on_min_count", () => {
  const { io, run } = pipeJson({ ...VALID_DRAFT, tags: [] });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const minCount = out.errors.filter((e: { code: string }) => e.code === "MIN_COUNT");
  expect(minCount).toHaveLength(1);
  expect(minCount[0].field).toBe("tags");
});

test("test_validate_ticket_fails_on_duplicate_when_unique", () => {
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    tags: ["auth", "auth"], // duplicate in a unique list
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const dupes = out.errors.filter((e: { code: string }) => e.code === "DUPLICATE");
  expect(dupes).toHaveLength(1);
  expect(dupes[0].field).toBe("tags");
});

test("test_validate_ticket_fails_on_enum_invalid_value", () => {
  // The shipped default has no enum field, so use a custom schema.
  const dir = tempDir();
  const schemaPath = writeFile(
    dir,
    "ticket_schema.toml",
    `
[required.priority]
type = "enum"
allowed = ["urgent", "high", "medium", "low"]
`,
  );
  const io = bufferIO();
  io.setStdin(JSON.stringify({ priority: "extreme" }));
  const result = handleValidateTicket(
    ["--ticket-json", "-", "--schema-file", schemaPath],
    io,
    { QUAY_CONFIG_DIR: dir },
  );
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const enums = out.errors.filter((e: { code: string }) => e.code === "ENUM");
  expect(enums).toHaveLength(1);
  expect(enums[0].field).toBe("priority");
});

test("test_validate_ticket_reports_multiple_errors_simultaneously", () => {
  // Three independent violations in one input:
  //   1. tags: empty (MIN_COUNT)
  //   2. authors[0].slack_id: pattern mismatch (PATTERN)
  //   3. body: too short (MIN_LENGTH)
  const { io, run } = pipeJson({
    body: "tiny",
    tags: [],
    authors: [{ name: "a", slack_id: "lowercase-bad" }],
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const codes = out.errors.map((e: { code: string }) => e.code).sort();
  expect(codes).toContain("MIN_COUNT");
  expect(codes).toContain("PATTERN");
  expect(codes).toContain("MIN_LENGTH");
  expect(out.errors.length).toBeGreaterThanOrEqual(3);
});

test("test_validate_ticket_emits_dotted_field_paths_for_nested_errors", () => {
  // authors is a list of objects; an error in a nested field must surface
  // as `authors[<i>].<field>`.
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    authors: [
      { name: "ok", slack_id: "U123" },
      { name: "still-ok", slack_id: "u-bad" }, // PATTERN at index 1
    ],
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const fields = out.errors.map((e: { field: string }) => e.field);
  expect(fields).toContain("authors[1].slack_id");
});

test("test_validate_ticket_optional_field_absent_does_not_error", () => {
  // VALID_DRAFT already omits slack_thread + external_ref (both optional).
  const { io, run } = pipeJson(VALID_DRAFT);
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("test_validate_ticket_optional_field_present_is_validated", () => {
  // slack_thread is optional but, when provided, must match the regex.
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    slack_thread: "not-a-thread-ref",
  });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  const patternErr = out.errors.find(
    (e: { field: string; code: string }) =>
      e.field === "slack_thread" && e.code === "PATTERN",
  );
  expect(patternErr).toBeDefined();
});

test("test_validate_ticket_unknown_field_is_silently_ignored", () => {
  const { io, run } = pipeJson({
    ...VALID_DRAFT,
    gitBranchName: "feature/auth-cache", // not in the schema
    custom_field: { nested: 1 },
  });
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("test_validate_ticket_loads_schema_from_default_path", () => {
  // Write a uniquely-shaped schema at $QUAY_CONFIG_DIR/ticket_schema.toml so
  // we can prove the handler actually read THAT file (not the shipped
  // default — which doesn't require `title`).
  const dir = tempDir();
  writeFile(
    dir,
    "ticket_schema.toml",
    `
[required.title]
type = "string"
min_length = 1
`,
  );

  const ioMissing = bufferIO();
  ioMissing.setStdin(JSON.stringify({ body: "no title here" }));
  const missing = handleValidateTicket(
    ["--ticket-json", "-"],
    ioMissing,
    { QUAY_CONFIG_DIR: dir },
  );
  expect(missing.exitCode).toBe(1);
  const out = JSON.parse(ioMissing.out().trim());
  expect(out.errors.find((e: { field: string }) => e.field === "title"))
    .toBeDefined();

  const ioOk = bufferIO();
  ioOk.setStdin(JSON.stringify({ title: "ok" }));
  const ok = handleValidateTicket(
    ["--ticket-json", "-"],
    ioOk,
    { QUAY_CONFIG_DIR: dir },
  );
  expect(ok.exitCode).toBe(0);
});

test("test_validate_ticket_accepts_schema_file_override", () => {
  // --schema-file wins over the env-rooted default.
  const overrideDir = tempDir();
  const overridePath = writeFile(
    overrideDir,
    "alt_schema.toml",
    `
[required.alt_only]
type = "string"
min_length = 1
`,
  );

  // Env points at a directory whose schema *would* require `title`.
  const envDir = tempDir();
  writeFile(
    envDir,
    "ticket_schema.toml",
    `
[required.title]
type = "string"
min_length = 1
`,
  );

  const io = bufferIO();
  io.setStdin(JSON.stringify({ alt_only: "present" }));
  const result = handleValidateTicket(
    ["--ticket-json", "-", "--schema-file", overridePath],
    io,
    { QUAY_CONFIG_DIR: envDir },
  );
  // Override schema only requires `alt_only`; title-less input still passes.
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("test_validate_ticket_supports_ticket_json_stdin", () => {
  const io = bufferIO();
  io.setStdin(JSON.stringify(VALID_DRAFT));
  // Explicit `--ticket-json -` form.
  const result = handleValidateTicket(
    ["--ticket-json", "-"],
    io,
    shippedDefaultEnv(),
  );
  expect(result.exitCode).toBe(0);

  // Implicit (no flag) form also reads stdin.
  const io2 = bufferIO();
  io2.setStdin(JSON.stringify(VALID_DRAFT));
  const result2 = handleValidateTicket([], io2, shippedDefaultEnv());
  expect(result2.exitCode).toBe(0);
});

test("test_validate_ticket_supports_ticket_json_file", () => {
  const dir = tempDir();
  const inputPath = writeFile(dir, "draft.json", JSON.stringify(VALID_DRAFT));

  const io = bufferIO();
  // No stdin set; we expect file read to be the input source.
  const result = handleValidateTicket(
    ["--ticket-json", inputPath],
    io,
    shippedDefaultEnv(),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

test("test_validate_ticket_exits_2_on_missing_schema_file", () => {
  const io = bufferIO();
  io.setStdin(JSON.stringify(VALID_DRAFT));
  const result = handleValidateTicket(
    ["--ticket-json", "-", "--schema-file", "/no/such/schema.toml"],
    io,
    shippedDefaultEnv(),
  );
  expect(result.exitCode).toBe(2);
  expect(io.out()).toBe("");
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("schema_error");
});

test("test_validate_ticket_exits_2_on_malformed_schema_toml", () => {
  const dir = tempDir();
  const broken = writeFile(
    dir,
    "broken.toml",
    `[required.body
type = "string"
`, // missing closing bracket
  );
  const io = bufferIO();
  io.setStdin(JSON.stringify(VALID_DRAFT));
  const result = handleValidateTicket(
    ["--ticket-json", "-", "--schema-file", broken],
    io,
    shippedDefaultEnv(),
  );
  expect(result.exitCode).toBe(2);
  expect(io.out()).toBe("");
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("schema_error");
});

test("test_validate_ticket_exits_3_on_malformed_input_json", () => {
  const io = bufferIO();
  io.setStdin("{not: valid json"); // unparseable
  const result = handleValidateTicket(
    ["--ticket-json", "-"],
    io,
    shippedDefaultEnv(),
  );
  expect(result.exitCode).toBe(3);
  expect(io.out()).toBe("");
  const err = JSON.parse(io.err().trim());
  expect(err.error).toBe("input_error");
});

test("test_validate_ticket_quiet_flag_suppresses_stdout", () => {
  // Valid input: stdout would normally be `{"valid":true}` — with --quiet,
  // it's empty. Exit code is unchanged.
  const ioValid = bufferIO();
  ioValid.setStdin(JSON.stringify(VALID_DRAFT));
  const okResult = handleValidateTicket(
    ["--ticket-json", "-", "--quiet"],
    ioValid,
    shippedDefaultEnv(),
  );
  expect(okResult.exitCode).toBe(0);
  expect(ioValid.out()).toBe("");

  // Invalid input: same suppression, exit code still 1.
  const ioBad = bufferIO();
  ioBad.setStdin(JSON.stringify({ ...VALID_DRAFT, tags: [] }));
  const badResult = handleValidateTicket(
    ["--ticket-json", "-", "--quiet"],
    ioBad,
    shippedDefaultEnv(),
  );
  expect(badResult.exitCode).toBe(1);
  expect(ioBad.out()).toBe("");
});

test("test_validate_ticket_library_pure_for_same_inputs", () => {
  // Library function returns identical output for identical input. Snapshot
  // the inputs deeply and confirm they aren't mutated, and confirm two
  // independent calls produce structurally equal results.
  const schema = parseSchema(
    `
[required.body]
type = "string"
min_length = 5

[required.tags]
type = "list"
item_type = "string"
min_count = 1
charset = "lowercase_alphanum_dash"
unique = true
`,
    "<inline>",
  );

  const payload = {
    body: "valid body",
    tags: ["one", "two"],
  };
  const before = JSON.stringify(payload);

  const a = validateTicket({ ...payload }, schema);
  const b = validateTicket({ ...payload }, schema);
  expect(a).toEqual(b);
  expect(JSON.stringify(payload)).toBe(before); // payload not mutated

  const bad = { body: "x", tags: [] };
  const badBefore = JSON.stringify(bad);
  const c = validateTicket({ ...bad }, schema);
  const d = validateTicket({ ...bad }, schema);
  expect(c).toEqual(d);
  expect(c.valid).toBe(false);
  expect(JSON.stringify(bad)).toBe(badBefore);
});

test("test_validate_ticket_hermes_first_draft_missing_tags_fails", () => {
  // Reproduces validator-spec §8.1 end-to-end against the shipped default
  // schema: first draft fails with exactly one tags(MIN_COUNT) error;
  // the corrected draft passes.
  //
  // Note: the §8.1 narrative quotes a Slack URL form for slack_thread
  // (`C...:1777622349373109`) but the §6 default schema requires the
  // canonical API form `<channel>:<seconds>.<micros>` (a literal `.` in
  // the message_ts portion). We use the canonical form here so the only
  // schema violation in the first draft is the missing tags — matching
  // the spec's stated outcome ("exactly one MIN_COUNT error").
  const firstDraft = {
    body:
      "Refactor the auth-session cache to evict entries when a user logs out.\n\nContext: the cache currently retains entries for 30 minutes regardless of session lifecycle, which means revoked sessions can still grant access until the entry expires naturally.",
    repo: "my-repo",
    tags: [],
    slack_thread: "C0AEN8KDRT2:1777622349.373109",
    authors: [{ name: "Fabian Scherer", slack_id: "U06TDC56VJB" }],
  };

  const env = shippedDefaultEnv();

  const ioFirst = bufferIO();
  ioFirst.setStdin(JSON.stringify(firstDraft));
  const firstResult = handleValidateTicket(["--ticket-json", "-"], ioFirst, env);
  expect(firstResult.exitCode).toBe(1);
  const firstOut = JSON.parse(ioFirst.out().trim());
  expect(firstOut.valid).toBe(false);
  expect(firstOut.errors).toHaveLength(1);
  expect(firstOut.errors[0].field).toBe("tags");
  expect(firstOut.errors[0].code).toBe("MIN_COUNT");

  const corrected = {
    ...firstDraft,
    tags: ["auth-session", "cache"],
  };
  const ioCorr = bufferIO();
  ioCorr.setStdin(JSON.stringify(corrected));
  const corrResult = handleValidateTicket(["--ticket-json", "-"], ioCorr, env);
  expect(corrResult.exitCode).toBe(0);
  expect(JSON.parse(ioCorr.out().trim())).toEqual({ valid: true });
});

// --- spec sanity guard: the shipped default schema parses and matches §6 ---

test("shipped default schema parses and matches §6 field set", () => {
  const repoConfig = join(
    new URL("../../config/ticket_schema.toml", import.meta.url).pathname,
  );
  const schema = loadSchema(repoConfig);
  expect(Object.keys(schema.required).sort()).toEqual(
    ["authors", "body", "repo", "tags"],
  );
  expect(Object.keys(schema.optional).sort()).toEqual(
    ["external_ref", "slack_thread"],
  );
});

test("test_validate_ticket_repo_missing_emits_missing_error", () => {
  // repo is a required field; omitting it must produce a MISSING error on
  // field "repo". This is the canonical repo_missing signal.
  const { repo: _omitted, ...withoutRepo } = VALID_DRAFT;
  const { io, run } = pipeJson(withoutRepo);
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  expect(out.valid).toBe(false);
  const missing = out.errors.filter(
    (e: { field: string; code: string }) =>
      e.field === "repo" && e.code === "MISSING",
  );
  expect(missing).toHaveLength(1);
});

test("test_validate_ticket_repo_pattern_violation_emits_pattern_error", () => {
  // repo accepts the same charset as the registry's `repo_id` schema
  // (`[A-Za-z0-9._-]+`), so uppercase, dots, and underscores are all OK.
  // Whitespace and path separators are not — those must surface as PATTERN.
  const { io, run } = pipeJson({ ...VALID_DRAFT, repo: "has space" });
  const result = run();
  expect(result.exitCode).toBe(1);
  const out = JSON.parse(io.out().trim());
  expect(out.valid).toBe(false);
  const patternErr = out.errors.find(
    (e: { field: string; code: string }) =>
      e.field === "repo" && e.code === "PATTERN",
  );
  expect(patternErr).toBeDefined();
});

test("test_validate_ticket_repo_present_and_valid_passes", () => {
  // VALID_DRAFT already includes repo; confirm the happy path is intact.
  const { io, run } = pipeJson(VALID_DRAFT);
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out().trim())).toEqual({ valid: true });
});

// silence "unused" complaints for helpers used only conditionally
void mkdirSync;

// Spec §13 deployment config: `quay tick` and the production CLI must read
// `~/.quay/config.toml` (or the operator's override) and forward the knobs
// to `await tick_once()` + the supervisor lock. Without this wiring, every
// production deployment runs with the hard-coded defaults regardless of
// what the operator sets.
//
// We pin the loader contract here:
//   - missing file → empty config (defaults apply)
//   - well-formed file → typed config object
//   - schema-invalid file → throws with a useful pointer
//   - QUAY_CONFIG_FILE / QUAY_CONFIG_DIR / QUAY_DATA_DIR precedence
//   - tickOptionsFromConfig → only forwards keys actually set

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptersConfigFromConfig,
  linearAdapterOptionsFromConfig,
  loadConfig,
  slackAdapterOptionsFromConfig,
  tickOptionsFromConfig,
} from "../../src/cli/config.ts";

let cleanups: Array<() => void> = [];

function tempDir(prefix = "quay-config-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

test("missing config file returns an empty config (defaults apply)", () => {
  const home = tempDir();
  const result = loadConfig({ env: {}, homeDir: home });
  expect(result.config).toEqual({});
  expect(result.configPath).toBeNull();
});

test("loads a well-formed config.toml from QUAY_CONFIG_FILE override", () => {
  const dir = tempDir();
  const path = join(dir, "custom.toml");
  writeFileSync(
    path,
    `agent_invocation = "claude --custom < {prompt_file}"
max_concurrent = 4
max_concurrent_reviewers = 3
retry_budget = 8
staleness_threshold_seconds = 900
supervisor_lock_stale_seconds = 60
tick_lock_path = "/tmp/custom-tick.lock"
worktree_root = "/var/lib/quay/worktrees"
max_attempt_duration_seconds = 7200
max_spawn_failures = 5
claim_timeout_seconds = 600
max_claim_expirations = 2
max_non_budget_respawns = 30

[reviewer]
enabled = true
gate_quay_owned_done = false
`,
  );
  const result = loadConfig({ env: { QUAY_CONFIG_FILE: path } });
  expect(result.configPath).toBe(path);
  expect(result.config.agent_invocation).toBe(
    "claude --custom < {prompt_file}",
  );
  expect(result.config.max_concurrent).toBe(4);
  expect(result.config.max_concurrent_reviewers).toBe(3);
  expect(result.config.reviewer?.enabled).toBe(true);
  expect(result.config.reviewer?.gate_quay_owned_done).toBe(false);
  expect(result.config.retry_budget).toBe(8);
  expect(result.config.staleness_threshold_seconds).toBe(900);
  expect(result.config.supervisor_lock_stale_seconds).toBe(60);
  expect(result.config.tick_lock_path).toBe("/tmp/custom-tick.lock");
  expect(result.config.worktree_root).toBe("/var/lib/quay/worktrees");
});

test("rejects a non-positive integer for retry_budget", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `retry_budget = 0\n`);
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /retry_budget/,
  );
});

test("accepts repos_root and parses it into config", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `repos_root = "/some/path"\n`);
  const result = loadConfig({ env: { QUAY_CONFIG_FILE: path } });
  expect(result.config.repos_root).toBe("/some/path");
});

test("rejects an empty string for repos_root", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `repos_root = ""\n`);
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /repos_root/,
  );
});

test("rejects an empty string for worktree_root", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `worktree_root = ""\n`);
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /worktree_root/,
  );
});

test("QUAY_CONFIG_DIR resolves to <dir>/config.toml", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.toml"), `max_concurrent = 7\n`);
  const result = loadConfig({ env: { QUAY_CONFIG_DIR: dir } });
  expect(result.config.max_concurrent).toBe(7);
});

test("QUAY_DATA_DIR resolves to <dir>/config.toml when QUAY_CONFIG_DIR is unset", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.toml"), `max_concurrent = 9\n`);
  const result = loadConfig({ env: { QUAY_DATA_DIR: dir } });
  expect(result.config.max_concurrent).toBe(9);
});

test("falls back to ~/.quay/config.toml when no env vars are set", () => {
  const home = tempDir();
  mkdirSync(join(home, ".quay"));
  writeFileSync(
    join(home, ".quay", "config.toml"),
    `agent_invocation = "claude --from-default-path"\n`,
  );
  const result = loadConfig({ env: {}, homeDir: home });
  expect(result.config.agent_invocation).toBe("claude --from-default-path");
});

test("accepts an [agents] block with per-role defaults and per-agent invocations", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[agents]
worker = "claude"
reviewer = "codex"

[agents.invocations.claude]
worker = "claude --w < {prompt_file}"
reviewer = "claude --r < {prompt_file}"

[agents.invocations.codex]
worker = "codex exec < {prompt_file}"
reviewer = "codex exec --review < {prompt_file}"
`,
  );
  const result = loadConfig({ env: { QUAY_CONFIG_FILE: path } });
  expect(result.config.agents?.worker).toBe("claude");
  expect(result.config.agents?.reviewer).toBe("codex");
  expect(result.config.agents?.invocations?.claude?.worker).toBe(
    "claude --w < {prompt_file}",
  );
  expect(result.config.agents?.invocations?.codex?.reviewer).toBe(
    "codex exec --review < {prompt_file}",
  );
});

test("rejects an unknown key under [agents] (strict schema, no silent typos)", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[agents]
default = "claude"
`,
  );
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /agents|default|unrecognized/i,
  );
});

test("rejects an empty agent invocation string", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[agents.invocations.codex]
worker = ""
`,
  );
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow();
});

test("rejects an unknown key (typo'd config refuses to silently fall back)", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  // `max_concurrency` is a plausible typo of `max_concurrent`. The
  // loader's strict schema must surface it instead of silently using
  // the default.
  writeFileSync(path, `max_concurrency = 4\n`);
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /max_concurrency|invalid|unrecognized/i,
  );
});

test("rejects a non-positive integer for max_concurrent", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `max_concurrent = 0\n`);
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /max_concurrent/,
  );
});

test("rejects malformed TOML with a useful pointer to the file", () => {
  const dir = tempDir();
  const path = join(dir, "broken.toml");
  // Unclosed string literal — fails Bun.TOML.parse.
  writeFileSync(path, `agent_invocation = "claude --unterminated\n`);
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /not valid TOML|TOML/i,
  );
});

test("tickOptionsFromConfig only forwards keys that are present", () => {
  // Empty config → empty options (every default in tick.ts applies).
  expect(tickOptionsFromConfig({})).toEqual({});

  // Partial config → only the named keys land in TickOptions.
  expect(
    tickOptionsFromConfig({
      max_concurrent: 6,
      max_concurrent_reviewers: 2,
      agent_invocation: "claude < {prompt_file}",
      reviewer: { enabled: true },
    }),
  ).toEqual({
    maxConcurrent: 6,
    maxConcurrentReviewers: 2,
    agentInvocation: "claude < {prompt_file}",
    reviewerEnabled: true,
  });
});

test("loads [adapters.linear] and [adapters.slack] sections", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[adapters.linear]
enabled = true
api_key_env = "MY_LINEAR_KEY"

[adapters.slack]
enabled = true
bot_token_env = "MY_SLACK_TOKEN"
max_thread_messages = 400
`,
  );
  const result = loadConfig({ env: { QUAY_CONFIG_FILE: path } });
  expect(adaptersConfigFromConfig(result.config)).toEqual({
    linearEnabled: true,
    slackEnabled: true,
  });
  expect(linearAdapterOptionsFromConfig(result.config)).toEqual({
    tokenEnvVar: "MY_LINEAR_KEY",
  });
  expect(slackAdapterOptionsFromConfig(result.config)).toEqual({
    tokenEnvVar: "MY_SLACK_TOKEN",
    maxThreadMessages: 400,
  });
});

test("absent [adapters] section means both adapters disabled", () => {
  expect(adaptersConfigFromConfig({})).toEqual({
    linearEnabled: false,
    slackEnabled: false,
  });
  expect(linearAdapterOptionsFromConfig({})).toEqual({});
  expect(slackAdapterOptionsFromConfig({})).toEqual({});
});

test("rejects an unknown key under [adapters.linear]", () => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[adapters.linear]
enabled = true
unknown_field = "x"
`,
  );
  expect(() => loadConfig({ env: { QUAY_CONFIG_FILE: path } })).toThrow(
    /unknown_field|unrecognized|invalid/i,
  );
});

test("tickOptionsFromConfig maps every supported key", () => {
  const opts = tickOptionsFromConfig({
    max_concurrent: 1,
    max_concurrent_reviewers: 2,
    agent_invocation: "x",
    max_attempt_duration_seconds: 2,
    staleness_threshold_seconds: 3,
    max_spawn_failures: 4,
    claim_timeout_seconds: 5,
    max_claim_expirations: 6,
    max_non_budget_respawns: 7,
    reviewer: { enabled: true, gate_quay_owned_done: true },
  });
  expect(opts).toEqual({
    maxConcurrent: 1,
    maxConcurrentReviewers: 2,
    agentInvocation: "x",
    maxAttemptDurationSeconds: 2,
    stalenessThresholdSeconds: 3,
    maxSpawnFailures: 4,
    claimTimeoutSeconds: 5,
    maxClaimExpirations: 6,
    maxNonBudgetRespawns: 7,
    reviewerEnabled: true,
    gateQuayOwnedDone: true,
  });
});

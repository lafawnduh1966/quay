// Deployment-level config loader for the production CLI.
//
// Spec §13: a single TOML file (default `~/.quay/config.toml`) provides the
// knobs that tune `quay tick` — agent invocation, concurrency, staleness,
// supervisor lock grace period, etc. Tests do NOT load config; they call
// `dispatch()` directly with explicit `tickOptions`. Keep this file thin.
//
// Resolution order (highest precedence first):
//   1. `QUAY_CONFIG_FILE` env var (full path; honored verbatim).
//   2. `${QUAY_CONFIG_DIR}/config.toml`.
//   3. `${QUAY_DATA_DIR}/config.toml`.
//   4. `~/.quay/config.toml`.
//
// A missing file is not an error: `loadConfig()` returns an empty config and
// every default in tick.ts / FileSupervisorLock applies. An unparseable or
// schema-invalid file IS an error — silent acceptance of bad config has
// burned us before, and the only safe default is to refuse to run.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { TickOptions } from "../core/tick.ts";

const positiveInt = z.number().int().positive();

// Schema mirrors the keys in spec §13. We only declare the keys the
// production CLI actually consumes; any other key in the file is rejected
// so a typo'd `max_concurrency` doesn't silently fall back to the default.
const LinearAdapterConfigSchema = z
  .object({
    enabled: z.boolean(),
    api_key_env: z.string().min(1).optional(),
  })
  .strict();

const SlackAdapterConfigSchema = z
  .object({
    enabled: z.boolean(),
    bot_token_env: z.string().min(1).optional(),
    max_thread_messages: positiveInt.optional(),
  })
  .strict();

const AdaptersConfigSchema = z
  .object({
    linear: LinearAdapterConfigSchema.optional(),
    slack: SlackAdapterConfigSchema.optional(),
  })
  .strict();

const ReviewerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    gate_quay_owned_done: z.boolean().optional(),
    // gh login tick matches posted reviews against when ingesting a finished
    // reviewer attempt. When unset the tick process's own `gh api user` is
    // used; set this when tick and worker authenticate as different gh
    // identities so the ingest doesn't silently drop the posted review.
    login: z.string().min(1).optional(),
  })
  .strict();

// `[agents]` block lets the deployment register a per-agent invocation
// template once (under `[agents.invocations.<name>].worker` /
// `.reviewer`) and choose one as the global default for each role via
// `[agents].worker` / `[agents].reviewer`. Per-repo overrides on the
// `repos` row pick a different registered agent for either role.
//
// Legacy compatibility: a top-level `agent_invocation = "..."` continues
// to work and is treated as `[agents.invocations.claude].worker` with
// `[agents].worker = "claude"`. The downstream resolver folds the two
// representations together.
const AgentInvocationSchema = z
  .object({
    worker: z.string().min(1).optional(),
    reviewer: z.string().min(1).optional(),
  })
  .strict();

const AgentsConfigSchema = z
  .object({
    worker: z.string().min(1).optional(),
    reviewer: z.string().min(1).optional(),
    invocations: z.record(z.string().min(1), AgentInvocationSchema).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    data_dir: z.string().min(1).optional(),
    repos_root: z.string().min(1).optional(),
    worktree_root: z.string().min(1).optional(),
    max_concurrent: positiveInt.optional(),
    max_concurrent_reviewers: positiveInt.optional(),
    retry_budget: positiveInt.optional(),
    agent_invocation: z.string().min(1).optional(),
    agents: AgentsConfigSchema.optional(),
    max_attempt_duration_seconds: positiveInt.optional(),
    staleness_threshold_seconds: positiveInt.optional(),
    max_spawn_failures: positiveInt.optional(),
    claim_timeout_seconds: positiveInt.optional(),
    max_claim_expirations: positiveInt.optional(),
    max_non_budget_respawns: positiveInt.optional(),
    tick_lock_path: z.string().min(1).optional(),
    supervisor_lock_stale_seconds: positiveInt.optional(),
    adapters: AdaptersConfigSchema.optional(),
    reviewer: ReviewerConfigSchema.optional(),
  })
  .strict();

export type QuayConfig = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: QuayConfig;
  configPath: string | null;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const path = resolveConfigPath(env, home);
  if (!existsSync(path)) {
    return { config: {}, configPath: null };
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`quay config at ${path} is not valid TOML: ${message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`quay config at ${path} is invalid: ${issues}`);
  }
  return { config: result.data, configPath: path };
}

// Map config keys to TickOptions, only forwarding fields that were actually
// set in the file. tick.ts applies its DEFAULT_* constants for any field
// left undefined, so an empty config still runs with the spec defaults.
export function tickOptionsFromConfig(config: QuayConfig): TickOptions {
  const opts: TickOptions = {};
  if (config.max_concurrent !== undefined) {
    opts.maxConcurrent = config.max_concurrent;
  }
  if (config.max_concurrent_reviewers !== undefined) {
    opts.maxConcurrentReviewers = config.max_concurrent_reviewers;
  }
  if (config.reviewer?.enabled !== undefined) {
    opts.reviewerEnabled = config.reviewer.enabled;
  }
  if (config.reviewer?.gate_quay_owned_done !== undefined) {
    opts.gateQuayOwnedDone = config.reviewer.gate_quay_owned_done;
  }
  if (config.reviewer?.login !== undefined) {
    opts.reviewerLogin = config.reviewer.login;
  }
  if (config.agent_invocation !== undefined) {
    opts.agentInvocation = config.agent_invocation;
  }
  if (config.max_attempt_duration_seconds !== undefined) {
    opts.maxAttemptDurationSeconds = config.max_attempt_duration_seconds;
  }
  if (config.staleness_threshold_seconds !== undefined) {
    opts.stalenessThresholdSeconds = config.staleness_threshold_seconds;
  }
  if (config.max_spawn_failures !== undefined) {
    opts.maxSpawnFailures = config.max_spawn_failures;
  }
  if (config.claim_timeout_seconds !== undefined) {
    opts.claimTimeoutSeconds = config.claim_timeout_seconds;
  }
  if (config.max_claim_expirations !== undefined) {
    opts.maxClaimExpirations = config.max_claim_expirations;
  }
  if (config.max_non_budget_respawns !== undefined) {
    opts.maxNonBudgetRespawns = config.max_non_budget_respawns;
  }
  return opts;
}

// Adapters are opt-in: a deployment without an `[adapters]` section in
// config.toml gets `linearEnabled=false, slackEnabled=false`, and the
// dispatcher fails closed for `--linear-issue` (per spec §12).
export function adaptersConfigFromConfig(
  config: QuayConfig,
): { linearEnabled: boolean; slackEnabled: boolean } {
  return {
    linearEnabled: config.adapters?.linear?.enabled === true,
    slackEnabled: config.adapters?.slack?.enabled === true,
  };
}

export function linearAdapterOptionsFromConfig(
  config: QuayConfig,
): { tokenEnvVar?: string } {
  const opts: { tokenEnvVar?: string } = {};
  const envVar = config.adapters?.linear?.api_key_env;
  if (envVar !== undefined) opts.tokenEnvVar = envVar;
  return opts;
}

export function slackAdapterOptionsFromConfig(
  config: QuayConfig,
): { tokenEnvVar?: string; maxThreadMessages?: number } {
  const opts: { tokenEnvVar?: string; maxThreadMessages?: number } = {};
  const envVar = config.adapters?.slack?.bot_token_env;
  if (envVar !== undefined) opts.tokenEnvVar = envVar;
  const cap = config.adapters?.slack?.max_thread_messages;
  if (cap !== undefined) opts.maxThreadMessages = cap;
  return opts;
}

function resolveConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  if (env.QUAY_CONFIG_FILE !== undefined && env.QUAY_CONFIG_FILE !== "") {
    return env.QUAY_CONFIG_FILE;
  }
  if (env.QUAY_CONFIG_DIR !== undefined && env.QUAY_CONFIG_DIR !== "") {
    return join(env.QUAY_CONFIG_DIR, "config.toml");
  }
  if (env.QUAY_DATA_DIR !== undefined && env.QUAY_DATA_DIR !== "") {
    return join(env.QUAY_DATA_DIR, "config.toml");
  }
  return join(home, ".quay", "config.toml");
}

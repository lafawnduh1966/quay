// Agent selection: turns deployment config (`[agents]` block) plus
// per-repo overrides into a concrete invocation string for a given
// (repo_id, role) pair.
//
// Two axes — worker vs. reviewer, and global default vs. per-repo
// override — feed a single resolver so the call sites (worker /
// reviewer spawn) only ask `which agent does THIS attempt run under?`
// without re-doing the precedence math.
//
// Legacy fallback: a top-level `agent_invocation = "..."` in
// config.toml continues to work without an `[agents]` block. We treat
// it as `[agents.invocations.claude].worker = <legacy>` with
// `[agents].worker = "claude"`, and use the same string for the
// reviewer role when no reviewer-specific invocation is registered.
// This matches the pre-ticket behaviour of running the same template
// for both roles.

import type { DB } from "../db/connection.ts";
import type { QuayConfig } from "../cli/config.ts";

export const DEFAULT_AGENT_NAME = "claude";
export const DEFAULT_CLAUDE_WORKER_INVOCATION =
  "claude --permission-mode bypassPermissions --output-format json --debug --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json";
export const DEFAULT_CLAUDE_REVIEWER_INVOCATION =
  "claude --permission-mode bypassPermissions --output-format json < {prompt_file} > .quay-usage.json";

export type AgentRole = "worker" | "reviewer";

export interface ResolvedAgent {
  // The registered key (e.g. "claude", "codex"). Recorded on the
  // attempt row so observability can distinguish runtimes without
  // string-matching the invocation.
  agent: string;
  invocation: string;
}

export interface AgentResolverDeps {
  db: DB;
  config: QuayConfig;
}

// Bundles the parts of the config we care about into a plain
// data shape so callers that don't have a `QuayConfig` (tests,
// the in-memory dispatcher) can still drive resolution.
export interface AgentSelection {
  defaults: Record<AgentRole, string>;
  invocations: Record<string, { worker?: string; reviewer?: string }>;
}

export interface AgentResolver {
  resolve(repoId: string, role: AgentRole): ResolvedAgent;
  // List of registered agent names — used by CLI flag validation so
  // operators get a clear error when they pass `--agent-worker typo`.
  registeredAgents(): string[];
}

interface RepoOverrideRow {
  agent_worker: string | null;
  agent_reviewer: string | null;
}

export function buildAgentSelection(config: QuayConfig): AgentSelection {
  const invocations: Record<string, { worker?: string; reviewer?: string }> = {};
  for (const [name, body] of Object.entries(config.agents?.invocations ?? {})) {
    const entry: { worker?: string; reviewer?: string } = {};
    if (body.worker !== undefined) entry.worker = body.worker;
    if (body.reviewer !== undefined) entry.reviewer = body.reviewer;
    invocations[name] = entry;
  }

  // Legacy `agent_invocation = "..."` folds into the claude entry.
  // If the operator also defined `[agents.invocations.claude]`, the
  // explicit block wins for whichever role it sets; the legacy string
  // only fills slots the block left undefined.
  if (config.agent_invocation !== undefined) {
    const existing = invocations[DEFAULT_AGENT_NAME] ?? {};
    invocations[DEFAULT_AGENT_NAME] = {
      worker: existing.worker ?? config.agent_invocation,
      reviewer: existing.reviewer ?? config.agent_invocation,
    };
  }

  // Always seed a built-in claude entry so a config with no `[agents]`
  // block and no legacy `agent_invocation` still produces a runnable
  // default. Operators who customise the claude invocation can do so
  // via either the legacy key or `[agents.invocations.claude]`; this
  // seeding only fills the slots they didn't override.
  const seeded = invocations[DEFAULT_AGENT_NAME] ?? {};
  invocations[DEFAULT_AGENT_NAME] = {
    worker: seeded.worker ?? DEFAULT_CLAUDE_WORKER_INVOCATION,
    reviewer: seeded.reviewer ?? DEFAULT_CLAUDE_REVIEWER_INVOCATION,
  };

  const defaults: Record<AgentRole, string> = {
    worker: config.agents?.worker ?? DEFAULT_AGENT_NAME,
    reviewer: config.agents?.reviewer ?? DEFAULT_AGENT_NAME,
  };
  return { defaults, invocations };
}

// Catches operator typos at boot rather than at first-spawn time. A
// config that says `[agents].worker = "codex"` but never registers a
// `[agents.invocations.codex]` block (or registers one without a
// `worker = ...` line) is a config mistake, not a runtime condition.
// Surfacing it during `createAgentResolver` means the production CLI
// startup fails loudly the moment the config is loaded — same shape
// as the schema rejection in `loadConfig` for typo'd top-level keys.
export function validateAgentSelection(selection: AgentSelection): void {
  for (const role of ["worker", "reviewer"] as const) {
    const name = selection.defaults[role];
    const entry = selection.invocations[name];
    if (entry === undefined) {
      throw new Error(
        `[agents].${role} = "${name}" but no [agents.invocations.${name}] is registered`,
      );
    }
    if (entry[role] === undefined) {
      throw new Error(
        `[agents].${role} = "${name}" but [agents.invocations.${name}].${role} is not set`,
      );
    }
  }
}

export function createAgentResolver(deps: AgentResolverDeps): AgentResolver {
  const selection = buildAgentSelection(deps.config);
  validateAgentSelection(selection);

  function lookupOverride(repoId: string): RepoOverrideRow | null {
    return (
      deps.db
        .query<RepoOverrideRow, [string]>(
          `SELECT agent_worker, agent_reviewer FROM repos WHERE repo_id = ?`,
        )
        .get(repoId) ?? null
    );
  }

  function resolve(repoId: string, role: AgentRole): ResolvedAgent {
    const override = lookupOverride(repoId);
    const overrideName =
      role === "worker" ? override?.agent_worker : override?.agent_reviewer;
    const agentName = overrideName ?? selection.defaults[role];
    const entry = selection.invocations[agentName];
    if (entry === undefined) {
      // The CLI rejects unknown agent names on `repo add` / `repo
      // update`, and the config loader rejects unknown defaults via
      // schema, so reaching here means the deployment renamed an
      // invocation entry out from under an existing row. Fail loudly
      // rather than fall back to claude silently — the operator needs
      // to either re-register the agent or update the repo override.
      throw new Error(
        `agent "${agentName}" is not registered in [agents.invocations] (repo ${repoId}, role ${role})`,
      );
    }
    const invocation = role === "worker" ? entry.worker : entry.reviewer;
    if (invocation === undefined) {
      throw new Error(
        `agent "${agentName}" has no ${role} invocation registered`,
      );
    }
    return { agent: agentName, invocation };
  }

  return {
    resolve,
    registeredAgents: () => Object.keys(selection.invocations).sort(),
  };
}

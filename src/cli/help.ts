// Human-facing help for the quay CLI.
//
// Usage text only — this module does NOT replace the structured-error JSON
// envelope on real command misuse (`{error: "usage_error", ...}` and friends).
// Per AST-83, the contract is layered:
//
//   * Explicit help (`--help` / `-h` / bare `help`) → plain text on stdout, exit 0.
//   * Misuse fallback (bare `quay`, bare `quay <noun>`, unknown command) → the
//     usual structured error on stderr, plus a usage block (or one-line hint)
//     on stderr as well, non-zero exit.
//
// The dispatcher in dispatch.ts is responsible for wiring those policies; this
// file just owns the text and the lookup table.
//
// We keep this in-repo and dependency-free on purpose. A CLI framework
// (commander/yargs/...) is overkill for the surface we have, and would shift
// the source of truth for the command surface away from dispatch.ts.

const TOP_HEADER = "quay — orchestrate code agents over a queue of work items";

interface FlagSpec {
  flag: string;
  desc: string;
}

interface CommandSpec {
  // Path including parents, joined with " " (e.g. "task list").
  path: string;
  // Single-line synopsis for the Usage: block.
  synopsis: string;
  // One-liner used in parent listings.
  summary: string;
  // Optional longer text rendered between Usage: and Options:.
  details?: string;
  flags?: FlagSpec[];
  // For sub-noun commands. Keys reference other entries in COMMANDS.
  subcommands?: string[];
}

// Source of truth for help. Keep entries close to the command surface they
// describe; if you add a command in dispatch.ts, add an entry here.
const COMMANDS: Record<string, CommandSpec> = {
  task: {
    path: "task",
    synopsis: "quay task <subcommand> [options]",
    summary: "Inspect and manage tasks",
    subcommands: [
      "task list",
      "task get",
      "task events",
      "task claim",
      "task release-claim",
    ],
  },
  "task list": {
    path: "task list",
    synopsis:
      "quay task list [--state <s>]... [--repo <id>] [--external-ref <ref>]",
    summary: "List tasks, optionally filtered. Outputs a JSON array.",
    flags: [
      { flag: "--state <s>", desc: "Filter by state. Repeatable." },
      { flag: "--repo <id>", desc: "Filter by repo_id." },
      { flag: "--external-ref <ref>", desc: "Filter by external_ref." },
    ],
  },
  "task get": {
    path: "task get",
    synopsis: "quay task get <task_id>",
    summary: "Print one task as JSON.",
  },
  "task events": {
    path: "task events",
    synopsis: "quay task events <task_id>",
    summary: "Print the task event log, oldest-first, as a JSON array.",
  },
  "task claim": {
    path: "task claim",
    synopsis: "quay task claim <task_id>",
    summary:
      "Claim a task for an orchestrator process. Returns a fresh claim_id.",
  },
  "task release-claim": {
    path: "task release-claim",
    synopsis: "quay task release-claim <task_id> --claim-id <id>",
    summary: "Release a previously held claim.",
    flags: [{ flag: "--claim-id <id>", desc: "The claim_id returned by `task claim`." }],
  },
  tick: {
    path: "tick",
    synopsis: "quay tick",
    summary:
      "Run the supervisor tick loop once and exit. Emits one JSON line per result.",
  },
  handoff: {
    path: "handoff",
    synopsis: "quay handoff <subcommand> [options]",
    summary: "Inspect durable orchestrator handoffs",
    subcommands: ["handoff list"],
  },
  "handoff list": {
    path: "handoff list",
    synopsis: "quay handoff list [--status <s>] [--task <task_id>]",
    summary:
      "List orchestrator handoffs. Defaults to pending rows and outputs a JSON array.",
    flags: [
      { flag: "--status <s>", desc: "Filter by status: pending, claimed, completed, cancelled. Defaults to pending." },
      { flag: "--task <task_id>", desc: "Filter by task_id." },
    ],
  },
  enqueue: {
    path: "enqueue",
    synopsis:
      "quay enqueue --repo <id> --brief-file <path> [--ticket-snapshot-file <p>] [--external-ref <r>] [--slack-thread-ref <r>] [--tag <name>]...",
    summary: "Enqueue a new task from a brief file (or a Linear issue).",
    details:
      "Pass --linear-issue <id> instead of --brief-file to derive the task from a Linear ticket via the configured adapter.",
    flags: [
      { flag: "--repo <id>", desc: "Target repo_id (required, unless --linear-issue carries one)." },
      { flag: "--brief-file <path>", desc: "Path to the brief markdown file (required)." },
      { flag: "--ticket-snapshot-file <p>", desc: "Optional ticket-snapshot file." },
      { flag: "--external-ref <ref>", desc: "Optional ticket reference (e.g., ITRY-900)." },
      { flag: "--slack-thread-ref <ref>", desc: "Optional Slack thread reference." },
      { flag: "--linear-issue <id>", desc: "Adapter-driven flow; mutually exclusive with --brief-file/--external-ref/--slack-thread-ref." },
      { flag: "--tag <name>", desc: "Repeatable. Attach a task tag." },
    ],
  },
  "review-pr": {
    path: "review-pr",
    synopsis: "quay review-pr --pr <repo>:<num> [--head-sha <sha>] [--tag <name>]...",
    summary: "Schedule a Quay reviewer for a GitHub PR.",
    details:
      "Fire-and-forget entry point for CI. The command returns after scheduling or idempotently skipping the review attempt.",
    flags: [
      { flag: "--pr <repo>:<num>", desc: "Pull request identifier, e.g. owner/repo:47." },
      { flag: "--head-sha <sha>", desc: "Optional dedup SHA. Defaults to gh pr view headRefOid." },
      { flag: "--tag <name>", desc: "Repeatable. Attach tags to synthetic review tasks." },
    ],
  },
  repo: {
    path: "repo",
    synopsis: "quay repo <subcommand> [options]",
    summary: "Manage the repo registry",
    subcommands: [
      "repo add",
      "repo update",
      "repo remove",
      "repo list",
      "repo export",
      "repo import",
      "repo set-tags",
      "repo unset-tags",
      "repo get-tags",
      "repo apply-tags",
    ],
  },
  "repo add": {
    path: "repo add",
    synopsis:
      "quay repo add --id <id> --url <url> --base-branch <b> --package-manager <pm> --install-cmd <cmd> [options]",
    summary: "Add a repo to the registry.",
    flags: [
      { flag: "--id <id>", desc: "Repo identifier (required)." },
      { flag: "--url <url>", desc: "Clone URL (required)." },
      { flag: "--base-branch <b>", desc: "Default branch (required)." },
      { flag: "--package-manager <pm>", desc: "e.g., bun, pnpm, npm (required)." },
      { flag: "--install-cmd <cmd>", desc: "Install command (required)." },
      { flag: "--test-cmd <cmd>", desc: "Optional test command." },
      { flag: "--ci-workflow-name <name>", desc: "Optional CI workflow name." },
      { flag: "--contribution-guide-path <path>", desc: "Optional CONTRIBUTING path." },
      {
        flag: "--agent-worker <name>",
        desc: "Optional. Pin worker attempts to an agent registered under [agents.invocations]. Defaults to [agents].worker.",
      },
      {
        flag: "--agent-reviewer <name>",
        desc: "Optional. Pin reviewer attempts to an agent registered under [agents.invocations]. Defaults to [agents].reviewer.",
      },
      { flag: "--input <json>", desc: "Alternative: pass the full row as JSON." },
    ],
  },
  "repo update": {
    path: "repo update",
    synopsis: "quay repo update <repo_id> [flags...]",
    summary: "Update mutable fields on an existing repo row.",
    flags: [
      { flag: "--id <id>", desc: "Selector (alternative to positional <repo_id>)." },
      {
        flag: "--agent-worker <name>",
        desc: "Pin worker attempts to a registered agent. Pass '' to clear and fall back to the deployment default.",
      },
      {
        flag: "--agent-reviewer <name>",
        desc: "Pin reviewer attempts to a registered agent. Pass '' to clear and fall back to the deployment default.",
      },
      { flag: "--input <json>", desc: "Alternative: pass the patch as JSON." },
    ],
  },
  "repo remove": {
    path: "repo remove",
    synopsis: "quay repo remove <repo_id>",
    summary: "Remove a repo row from the registry.",
  },
  "repo list": {
    path: "repo list",
    synopsis: "quay repo list [--active]",
    summary: "Print all repo rows as a JSON array.",
    details:
      "By default lists every row, archived included (so operators can see soft-deleted repos). Pass --active to limit the output to repos with archived_at IS NULL — the typical \"which repos are in service?\" question.",
    flags: [
      {
        flag: "--active",
        desc: "Only return rows where archived_at IS NULL.",
      },
    ],
  },
  "repo export": {
    path: "repo export",
    synopsis: "quay repo export [--out <path>] [--active]",
    summary: "Dump the repo registry as JSON. Default writes to stdout.",
    flags: [
      { flag: "--out <path>", desc: "Write the dump to <path> instead of stdout." },
      {
        flag: "--active",
        desc: "Only export rows where archived_at IS NULL.",
      },
    ],
  },
  "repo import": {
    path: "repo import",
    synopsis: "quay repo import --in <path>",
    summary: "Upsert each repo row from a JSON array file (idempotent).",
    flags: [{ flag: "--in <path>", desc: "Path to a JSON array file (required)." }],
  },
  "repo set-tags": {
    path: "repo set-tags",
    synopsis: "quay repo set-tags <repo_id> --namespace <name> --value <v>",
    summary: "Add a value to a tag namespace for a repo (idempotent).",
    details:
      "Namespaces must match [a-z0-9]+ (no dashes — the validator splits ticket tags on the first dash). Values may use [a-z0-9-]+. Running the same command twice is safe — duplicate pairs are silently ignored.",
    flags: [
      { flag: "--namespace <name>", desc: "Namespace identifier (required). Must match [a-z0-9]+." },
      { flag: "--value <v>", desc: "Value to add to the namespace (required). Must match [a-z0-9-]+." },
    ],
  },
  "repo unset-tags": {
    path: "repo unset-tags",
    synopsis: "quay repo unset-tags <repo_id> --namespace <name> [--value <v>]",
    summary: "Remove a value (or a whole namespace) from a repo's tag vocab.",
    details:
      "When --value is supplied, only that one value is removed. When omitted, the entire namespace and its required/optional metadata are deleted.",
    flags: [
      { flag: "--namespace <name>", desc: "Namespace to target (required)." },
      { flag: "--value <v>", desc: "Specific value to remove. Omit to remove the whole namespace." },
    ],
  },
  "repo get-tags": {
    path: "repo get-tags",
    synopsis: "quay repo get-tags <repo_id>",
    summary: "Print the tag vocabulary for a repo as JSON.",
    details:
      'Output shape: { "repo_id": "...", "namespaces": { "<ns>": { "values": [...], "required": bool }, ... } }. Namespaces and values are sorted alphabetically for stable output.',
  },
  "repo apply-tags": {
    path: "repo apply-tags",
    synopsis: "quay repo apply-tags <repo_id> --from <path>",
    summary: "Declaratively replace a repo's entire tag vocabulary from a JSON file.",
    details:
      'Reads a { "namespaces": { "<ns>": { "values": [...], "required": bool }, ... } } document. Any existing namespaces not present in the input are removed. An empty namespaces object clears everything. Pass - as path to read from stdin. The operation is transactional: on validation failure nothing is written.',
    flags: [
      { flag: "--from <path>", desc: "Path to a JSON file (required). Use - for stdin." },
    ],
  },
  tags: {
    path: "tags",
    synopsis: "quay tags <subcommand> [options]",
    summary: "Manage the deployment-wide tag vocabulary and inspect merged vocab",
    subcommands: [
      "tags set-deployment",
      "tags unset-deployment",
      "tags get-deployment",
      "tags apply-deployment",
      "tags import",
      "tags list",
    ],
  },
  "tags set-deployment": {
    path: "tags set-deployment",
    synopsis: "quay tags set-deployment --namespace <name> --value <v>",
    summary: "Add a value to a deployment-scoped tag namespace (idempotent).",
    details:
      "Namespaces must match [a-z0-9]+ (no dashes — the validator splits ticket tags on the first dash). Values may use [a-z0-9-]+. Running the same command twice is safe — duplicate pairs are silently ignored.",
    flags: [
      { flag: "--namespace <name>", desc: "Namespace identifier (required). Must match [a-z0-9]+." },
      { flag: "--value <v>", desc: "Value to add to the namespace (required). Must match [a-z0-9-]+." },
    ],
  },
  "tags unset-deployment": {
    path: "tags unset-deployment",
    synopsis: "quay tags unset-deployment --namespace <name> [--value <v>]",
    summary: "Remove a value (or a whole namespace) from the deployment tag vocab.",
    details:
      "When --value is supplied, only that one value is removed. When omitted, the entire namespace and its required/optional metadata are deleted.",
    flags: [
      { flag: "--namespace <name>", desc: "Namespace to target (required)." },
      { flag: "--value <v>", desc: "Specific value to remove. Omit to remove the whole namespace." },
    ],
  },
  "tags get-deployment": {
    path: "tags get-deployment",
    synopsis: "quay tags get-deployment",
    summary: "Print the deployment-wide tag vocabulary as JSON.",
    details:
      'Output shape: { "scope": "deployment", "namespaces": { "<ns>": { "values": [...], "required": bool }, ... } }. Namespaces and values are sorted alphabetically for stable output.',
  },
  "tags apply-deployment": {
    path: "tags apply-deployment",
    synopsis: "quay tags apply-deployment --from <path>",
    summary: "Declaratively replace the deployment tag vocabulary from a JSON file.",
    details:
      'Reads a { "namespaces": { "<ns>": { "values": [...], "required": bool }, ... } } document. Any existing namespaces not present in the input are removed. An empty namespaces object clears everything. Pass - as path to read from stdin. The operation is transactional: on validation failure nothing is written.',
    flags: [
      { flag: "--from <path>", desc: "Path to a JSON file (required). Use - for stdin." },
    ],
  },
  "tags import": {
    path: "tags import",
    synopsis: "quay tags import --from <path> [--force]",
    summary: "Import deployment tag vocab from a TOML file.",
    details:
      "Reads [tags.namespaces.*] from the TOML file. If the deployment vocab is already non-empty and the desired state differs, the command exits 1 with a vocab_exists error unless --force is passed.",
    flags: [
      { flag: "--from <path>", desc: "Path to a TOML file (required)." },
      { flag: "--force", desc: "Overwrite existing deployment vocab without prompting." },
    ],
  },
  "tags list": {
    path: "tags list",
    synopsis: "quay tags list --repo <repo_id>",
    summary: "Print the merged (deployment + per-repo) tag vocabulary for a repo.",
    details:
      'Output shape: { "repo_id": "...", "namespaces": { ... }, "enforced": bool }. The enforced flag is true when the repo has any per-repo vocabulary configured. Deployment vocab alone never enforces.',
    flags: [
      { flag: "--repo <repo_id>", desc: "Repo identifier (required)." },
    ],
  },
  cancel: {
    path: "cancel",
    synopsis: "quay cancel <task_id> [--close-pr] [--keep-worktree]",
    summary: "Cancel a running or queued task.",
    flags: [
      { flag: "--close-pr", desc: "Also close the open PR for this task, if any." },
      { flag: "--keep-worktree", desc: "Preserve the on-disk worktree (default: remove)." },
    ],
  },
  "submit-brief": {
    path: "submit-brief",
    synopsis:
      "quay submit-brief <task_id> --claim-id <id> --brief-file <path> --reason <blocker_resolved|advice_answered>",
    summary: "Submit a follow-up brief to resume a waiting task.",
    flags: [
      { flag: "--claim-id <id>", desc: "The claim_id held by the caller (required)." },
      { flag: "--brief-file <path>", desc: "Path to the new brief (required)." },
      { flag: "--reason <r>", desc: "blocker_resolved | advice_answered (required)." },
      { flag: "--input <json>", desc: "Alternative: pass the full payload as JSON." },
    ],
  },
  "escalate-human": {
    path: "escalate-human",
    synopsis:
      "quay escalate-human <task_id> --claim-id <id> --question-file <path> [--thread-ref <ref>]",
    summary: "Record a human question while the orchestrator owns the wait.",
    flags: [
      { flag: "--claim-id <id>", desc: "The claim_id held by the caller (required)." },
      { flag: "--question-file <path>", desc: "Path to the question body (required)." },
      { flag: "--thread-ref <ref>", desc: "Optional Slack thread ref chosen by the orchestrator." },
      { flag: "--input <json>", desc: "Alternative: pass the full payload as JSON." },
    ],
  },
  "record-human-reply": {
    path: "record-human-reply",
    synopsis:
      "quay record-human-reply <task_id> --claim-id <id> --reply-file <path> [--thread-ref <ref>] [--message-ts <ts>] [--author <name>]",
    summary: "Persist a human answer and return the task to the claimed state.",
    flags: [
      { flag: "--claim-id <id>", desc: "The claim_id held by the caller (required)." },
      { flag: "--reply-file <path>", desc: "Path to the human reply body (required)." },
      { flag: "--thread-ref <ref>", desc: "Optional Slack thread ref for audit metadata." },
      { flag: "--message-ts <ts>", desc: "Optional Slack message timestamp." },
      { flag: "--author <name>", desc: "Optional reply author display name or id." },
      { flag: "--input <json>", desc: "Alternative: pass the full payload as JSON." },
    ],
  },
  artifact: {
    path: "artifact",
    synopsis: "quay artifact <subcommand> [options]",
    summary: "Read artifacts captured for a task",
    subcommands: ["artifact get"],
  },
  "artifact get": {
    path: "artifact get",
    synopsis: "quay artifact get <task_id> <kind> [--attempt <n>] [--path]",
    summary:
      "Print the latest matching artifact. Default streams the raw bytes.",
    flags: [
      { flag: "--attempt <n>", desc: "Restrict to a specific attempt_id." },
      { flag: "--path", desc: "Print the on-disk file path instead of the contents." },
    ],
  },
};

// Top-level commands shown in `quay --help`. Order matters — these are listed
// in the same order a typical operator hits them when exploring.
const TOP_LEVEL_ORDER: string[] = [
  "task",
  "tick",
  "handoff",
  "enqueue",
  "review-pr",
  "repo",
  "tags",
  "cancel",
  "submit-brief",
  "escalate-human",
  "record-human-reply",
  "artifact",
];

// Entry-level commands that are handled in src/cli/index.ts before dispatch
// runs (so they don't appear in COMMANDS). We still want them listed in the
// top-level help so operators know they exist.
const ENTRY_LEVEL_EXTRAS: Array<{ name: string; summary: string }> = [
  { name: "validate-ticket", summary: "Validate a Linear ticket payload against the schema (reads stdin)." },
  { name: "--version, -v", summary: "Print the quay version and exit." },
];

export function isHelpToken(s: string): boolean {
  return s === "--help" || s === "-h" || s === "help";
}

// Returns true if argv asks for help.
//
// Naively `argv.some(isHelpToken)` would mis-fire when `help` / `-h` /
// `--help` is the *value* of a preceding flag (e.g. `quay enqueue
// --external-ref help`). We walk argv and skip the values of value-taking
// long flags, mirroring the dispatch positional walker.
//
// Recognised forms:
//   * `--help`  (and `--help=anything`)
//   * `-h`      only as a standalone token
//   * `help`    only as a positional token
export function wantsHelp(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      if (a === "--help" || a.startsWith("--help=")) return true;
      // Value-taking long flags: a `--flag value` pair consumes both tokens
      // so we skip the value before continuing. `--flag=value` is
      // self-contained. A following token that is itself a `--flag` does
      // NOT get consumed (matches dispatch.positionalAt semantics).
      if (!a.includes("=")) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) i += 1;
      }
      continue;
    }
    // Non-flag token: only `-h` / `help` count as a help request here. A
    // token that is the value of a preceding `--flag` was already skipped
    // above, so any token reaching this branch is a positional.
    if (a === "-h" || a === "help") return true;
  }
  return false;
}

// Top-level help text, for `quay --help` and friends.
export function topLevelHelp(): string {
  const lines: string[] = [];
  lines.push(TOP_HEADER);
  lines.push("");
  lines.push("Usage:");
  lines.push("  quay <command> [options]");
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(
    ...TOP_LEVEL_ORDER.map((n) => n.length),
    ...ENTRY_LEVEL_EXTRAS.map((e) => e.name.length),
  );
  for (const name of TOP_LEVEL_ORDER) {
    const c = COMMANDS[name];
    if (!c) continue;
    lines.push(`  ${name.padEnd(width)}  ${c.summary}`);
  }
  for (const e of ENTRY_LEVEL_EXTRAS) {
    lines.push(`  ${e.name.padEnd(width)}  ${e.summary}`);
  }
  lines.push("");
  lines.push("Run `quay <command> --help` for per-command usage.");
  return `${lines.join("\n")}\n`;
}

// Per-command help text. Returns null if the path is unknown.
export function commandHelp(path: string[]): string | null {
  const key = path.join(" ");
  const spec = COMMANDS[key];
  if (!spec) return null;
  const lines: string[] = [];
  lines.push(`quay ${spec.path} — ${spec.summary}`);
  lines.push("");
  lines.push("Usage:");
  lines.push(`  ${spec.synopsis}`);
  if (spec.details) {
    lines.push("");
    lines.push(spec.details);
  }
  if (spec.subcommands && spec.subcommands.length > 0) {
    lines.push("");
    lines.push("Subcommands:");
    const childKeys = spec.subcommands;
    const childWidth = Math.max(...childKeys.map((k) => leafName(k).length));
    for (const k of childKeys) {
      const child = COMMANDS[k];
      if (!child) continue;
      lines.push(`  ${leafName(k).padEnd(childWidth)}  ${child.summary}`);
    }
    lines.push("");
    lines.push(`Run \`quay ${spec.path} <subcommand> --help\` for per-subcommand usage.`);
  }
  if (spec.flags && spec.flags.length > 0) {
    lines.push("");
    lines.push("Options:");
    const flagWidth = Math.max(...spec.flags.map((f) => f.flag.length));
    for (const f of spec.flags) {
      lines.push(`  ${f.flag.padEnd(flagWidth)}  ${f.desc}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// "task list" -> "list"; "repo" -> "repo".
function leafName(path: string): string {
  const parts = path.split(" ");
  return parts[parts.length - 1] ?? path;
}

// One-line hint emitted alongside misuse errors. Kept on its own line so the
// JSON envelope on the line before it stays parseable.
export const HELP_HINT = "Run `quay --help` for usage.\n";

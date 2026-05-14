# CLI Reference

The main command surface is implemented by `src/cli/dispatch.ts`. The older
spec docs may lag behind this list.

## Output Conventions

- Successful read commands print JSON to stdout.
- Successful write commands print JSON to stdout.
- Write-command failures print JSON to stderr and exit non-zero.
- `quay tick` prints newline-delimited JSON, one action per line.
- `quay artifact get` streams raw artifact bytes unless `--path` is used.

## Help

Every command supports `--help`, `-h`, or a bare `help` subcommand to print
a plain-text usage block:

```bash
quay --help                # top-level command list
quay help                  # same as --help
quay help repo             # equivalent to `quay repo --help`
quay repo --help           # per-noun usage + subcommand list
quay repo add --help       # leaf-command usage with required flags
```

Help requested explicitly (`--help` / `-h` / `help`) goes to **stdout** and
exits 0. Misuse — bare `quay`, bare `quay <noun>`, an unknown command, or a
typo'd subcommand — still emits the structured `{error: "usage_error"}`
envelope on stderr (so machine consumers like `hermes-agent` keep parsing
it), and additionally appends the relevant usage block (or a one-line
`Run \`quay --help\` for usage.` hint for unknown top-level commands).
Misuse always exits non-zero.

## Global

```bash
quay --version
quay -v
```

`--version` short-circuits before config, DB, and migrations.

## Repo

```bash
quay repo add \
  --id <repo_id> \
  --url <repo_url> \
  --base-branch <branch> \
  --package-manager <name> \
  --install-cmd <cmd> \
  [--test-cmd <cmd>] \
  [--ci-workflow-name <name>] \
  [--contribution-guide-path <path>]

quay repo update <repo_id> [flags]
quay repo update --id <repo_id> [flags]
quay repo remove <repo_id>
quay repo list [--active]
quay repo export [--out <path>] [--active]
quay repo import --in <path>

quay repo set-tags <repo_id> --namespace <name> --value <v>
quay repo unset-tags <repo_id> --namespace <name> [--value <v>]
quay repo get-tags <repo_id>
quay repo apply-tags <repo_id> --from <path>
```

`repo add` and `repo update` also accept `--input <json>` for structured
automation.

`repo list` and `repo export` default to returning every row, archived
included, so operators debugging "where did my repo go?" still see
soft-deleted entries (and `repo export` keeps full-fidelity backup
semantics). Pass `--active` to limit the output to rows with
`archived_at IS NULL` — the typical "which repos are in service?"
question that consumers like `setup-hermes.sh` ask.

## Tags

Deployment-wide vocabulary management and per-repo merged-vocab inspection:

```bash
quay tags set-deployment --namespace <name> --value <v>
quay tags unset-deployment --namespace <name> [--value <v>]
quay tags get-deployment
quay tags apply-deployment --from <path>
quay tags import --from <path> [--force]
quay tags list --repo <repo_id>
```

`tags set-deployment` and `tags unset-deployment` operate on the deployment-scoped
vocabulary (no repo required). `tags apply-deployment` accepts `--from -` for stdin.
`tags import` reads a TOML file containing a `[tags.namespaces.*]` table; if the
deployment vocab is already non-empty and the desired state differs, it exits 1 with
`vocab_exists` unless `--force` is passed.

`tags list --repo <repo_id>` merges the deployment vocab with the per-repo vocab and
returns the result with an `enforced` boolean. `enforced` is true when the repo has
any per-repo vocabulary configured; deployment-only vocab never enforces.

## Enqueue

Manual brief:

```bash
quay enqueue \
  --repo <repo_id> \
  --brief-file <path> \
  [--ticket-snapshot-file <path>] \
  [--external-ref <ref>] \
  [--slack-thread-ref <channel:ts>] \
  [--tag <tag>]...
```

Linear:

```bash
quay enqueue \
  --repo <repo_id> \
  --linear-issue <identifier> \
  [--tag <tag>]...
```

`--linear-issue` is mutually exclusive with `--brief-file`, `--external-ref`,
and `--slack-thread-ref`.

## PR Review

```bash
quay review-pr --pr <repo>:<num> [--head-sha <sha>] [--tag <tag>]...
```

`review-pr` is the fire-and-forget CI entry point for the Quay reviewer. The
repo portion may be the configured `repo_id` or the owner/name derived from the
registered repo URL. The command prints one JSON object with `scheduled` and
`skipped_reason` so callers can distinguish new work from an idempotent no-op.

## Tick

```bash
quay tick
```

No flags are currently accepted.

## Handoffs

```bash
quay handoff list [--status <pending|claimed|completed|cancelled>] [--task <task_id>]
```

`handoff list` is the pull surface for orchestrator loops waiting to resume
tasks in `awaiting-next-brief`. It reads the durable handoff queue populated for
worker blockers, exhausted retry budgets, and ingested human replies. Without
`--status`, it lists only `pending` handoffs. Use `--status claimed`,
`--status completed`, or `--status cancelled` for recovery and forensics, and
`--task` to narrow the result to one task.

Output is a deterministic JSON array ordered by creation time and handoff ID.
Each row includes `handoff_id`, `task_id`, `reason`, `state_event_id`,
`idempotency_key`, `payload_json`, `status`, `claim_id`, `claimed_at`,
`completed_at`, `created_at`, and `updated_at`.

## Tasks

```bash
quay task list [--state <state>]... [--repo <repo_id>] [--external-ref <ref>]
quay task get <task_id>
quay task events <task_id>
quay task claim <task_id>
quay task release-claim <task_id> --claim-id <claim_id>
```

`task claim` only succeeds for `awaiting-next-brief` tasks.
`task get` includes `slack_thread_ref`, which is the enqueue-time Slack
`channel:thread_ts` route an orchestrator should prefer for human questions.

## Submit Brief

```bash
quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file <path> \
  --reason <blocker_resolved|advice_answered>
```

`blocker_resolved` consumes retry budget when promoted. `advice_answered` does
not.

## Escalate Human

```bash
quay escalate-human <task_id> \
  --claim-id <claim_id> \
  --question-file <path> \
  [--thread-ref <channel:ts>]
```

This records the question and moves the task to `waiting_human` while
preserving the orchestrator claim. Quay does not post to Slack; the
orchestrator owns routing, posting, waiting, and fallback channels. If
`--thread-ref` is omitted, the recorded thread metadata can remain empty.

## Record Human Reply

```bash
quay record-human-reply <task_id> \
  --claim-id <claim_id> \
  --reply-file <path> \
  [--thread-ref <channel:ts>] \
  [--message-ts <ts>] \
  [--author <name>]
```

This persists the human answer as a `slack_reply` artifact and returns the task
to `claimed-by-orchestrator`, so the same orchestrator claim can call
`submit-brief --reason advice_answered`.

## Cancel

```bash
quay cancel <task_id> [--close-pr] [--keep-worktree]
```

Unknown cancel flags are rejected. Boolean cancel flags do not accept values.

## Artifacts

```bash
quay artifact get <task_id> <kind> [--attempt <n>] [--path]
```

Without `--path`, stdout is the artifact body as raw bytes. With `--path`,
stdout is the on-disk artifact path.

## Validate Ticket

```bash
quay validate-ticket [--ticket-json <path|->] [--schema-file <path>] [--quiet]
```

If `--ticket-json` is omitted or set to `-`, input is read from stdin.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Valid ticket. |
| `1` | Ticket validation failed. |
| `2` | Usage or schema error. |
| `3` | Input read or JSON error. |

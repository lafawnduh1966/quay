# Configuration

Production configuration is TOML.

## Config File Resolution

Quay looks for the deployment config in this order:

1. `QUAY_CONFIG_FILE`
2. `QUAY_CONFIG_DIR/config.toml`
3. `QUAY_DATA_DIR/config.toml`
4. `~/.quay/config.toml`

A missing config file is allowed. An invalid TOML file or unknown config key is
a hard error.

## Example

```toml
data_dir = "/var/lib/quay"
repos_root = "/var/lib/quay/repos"
worktree_root = "/var/lib/quay/worktrees"
max_concurrent = 2
max_concurrent_reviewers = 2
retry_budget = 5
agent_invocation = "claude --permission-mode bypassPermissions --output-format json --debug --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json"
max_attempt_duration_seconds = 3600
staleness_threshold_seconds = 600
max_spawn_failures = 3
claim_timeout_seconds = 1800
max_claim_expirations = 3
max_non_budget_respawns = 20
tick_lock_path = "/var/lib/quay/tick.lock"
supervisor_lock_stale_seconds = 30

[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
max_thread_messages = 200

[reviewer]
enabled = false
gate_quay_owned_done = false
# gh_token_file = "/run/hermes/reviewer-gh-token"
```

## Keys

| Key | Default | Notes |
| --- | --- | --- |
| `data_dir` | `~/.quay` | Overridden by `QUAY_DATA_DIR` at runtime. |
| `repos_root` | `${data_dir}/repos` | Explicit paths must already exist. |
| `worktree_root` | `${data_dir}/worktrees` | Quay creates the derived default. |
| `max_concurrent` | `2` | Maximum running tasks promoted by tick. |
| `max_concurrent_reviewers` | `2` | Maximum running reviewer workers. Independent of `max_concurrent`. |
| `retry_budget` | `5` | Copied onto new tasks at enqueue time. |
| `agent_invocation` | `claude … --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json` (see `Agent Invocation` below) | Shell command used inside tmux. The default writes a `usage` envelope to `.quay-usage.json` and a `tool_trace` debug log to `.quay-tool-trace.log`; both are captured as per-attempt artifacts. |
| `max_attempt_duration_seconds` | `3600` | Live worker wall-clock kill threshold. |
| `staleness_threshold_seconds` | `600` | Live worker no-fresh-log kill threshold. |
| `max_spawn_failures` | `3` | Repeated spawn failures before `worktree_error`. |
| `claim_timeout_seconds` | `1800` | Time before a stale orchestrator claim expires. |
| `max_claim_expirations` | `3` | Claim expirations before `orchestrator_loop`. |
| `max_non_budget_respawns` | `20` | Review/conflict respawns before `non_budget_loop`. |
| `tick_lock_path` | `${data_dir}/tick.lock` | Supervisor lock path. |
| `supervisor_lock_stale_seconds` | `30` | Stale lock grace window. |

## Reviewer

```toml
[reviewer]
enabled = true
gate_quay_owned_done = false
# login = "quay-bot"
# gh_token_file = "/run/hermes/reviewer-gh-token"
```

`enabled` turns on the reviewer subsystem, including `quay review-pr` and the
reviewer spawn pass in `quay tick`. `gate_quay_owned_done` changes Quay-owned
PRs from the legacy `pr-open -> done` CI-green transition to `pr-open ->
pr-review -> done`, where the final transition requires an approved Quay
review. Synthetic PR reviews still work when the gate is false.

`login` is the gh login tick matches posted reviews against when it ingests a
finished reviewer attempt. Defaults to whatever `gh api user --jq .login`
returns in the tick process. Set it explicitly when the reviewer worker
authenticates as a different gh identity than tick (for example, when tick
runs as the deployment service account and the worker posts under a dedicated
bot account); leaving it unset in that setup will silently never match the
posted review and park the task in `non_budget_loop` after the infra-failure
retry budget runs out.

Both regular user accounts and GitHub App identities are supported. Use the
form that matches the reviewer's actual GitHub identity:

- `login = "<slug>"` (bare) for a regular user account.
- `login = "app/<slug>"` for a GitHub App identity (e.g. an installation
  token used by a bot account).

Tick distinguishes the two via the review author's account type as reported
by the GitHub API (`user.type` of `Bot` for App authors, `User` for regular
accounts) — not just the login string. This means a same-named regular user
*cannot* satisfy a gate configured against `app/<slug>`, and vice versa.

`gh_token_file` makes the reviewer tmux pane authenticate to GitHub as a
different identity than the worker that opened the PR. GitHub refuses
self-review, so a deployment where worker and reviewer share the same `gh`
auth cannot approve quay-opened PRs. When set, the file (expected mode `0600`,
contents read fresh on every reviewer spawn) is `cat`'d inside the pane and
exported as `GH_TOKEN`; the worker pane is unaffected and continues to use
the host's default `gh` auth. The path lands in the pane wrapper script — the
token bytes themselves never appear in any process argv, so `ps` on the host
cannot leak them. Rotation is transparent: write the new token to the file
and the next reviewer attempt picks it up. A missing or empty file is a hard
spawn failure (`spawn_substrate_failed`), so silent fall-back to the host
auth (and the resulting self-review block) is impossible. Pair this with an
out-of-band token minter (e.g. an `hermes-agent` systemd timer that refreshes
a GitHub App installation token).

## Agent Invocation

Quay writes the final prompt to `<worktree>/.quay-prompt.md` before spawning the
worker. If your command uses `{prompt_file}`, Quay replaces it with a
shell-quoted prompt path.

Examples:

```toml
agent_invocation = "claude --permission-mode bypassPermissions --output-format json --debug --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json"
agent_invocation = "my-agent run --prompt {prompt_file}"
```

The command runs inside the task worktree.

The default invocation writes two worktree-local files which Quay captures as
per-attempt artifacts:

- `.quay-usage.json` — the JSON envelope claude prints under `--output-format
  json`. Captured as the `usage` artifact (`quay artifact get <task_id> usage`).
- `.quay-tool-trace.log` — the debug stream from `--debug --debug-file`.
  Captured as the `tool_trace` artifact (`quay artifact get <task_id> tool_trace`).

If you replace the default with a different agent runtime, write the same two
filenames (or omit the redirects to skip those captures). Quay reads the files
by name, not by runtime.

## Repos Root Behavior

When `repos_root` is omitted, Quay creates `${data_dir}/repos`.

When `repos_root` is set explicitly, Quay does not create it. A missing explicit
path fails with `repos_root_missing`. This catches typos before enqueueing work.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `QUAY_DATA_DIR` | Runtime data directory override. |
| `QUAY_CONFIG_DIR` | Directory for `config.toml` and `ticket_schema.toml`. |
| `QUAY_CONFIG_FILE` | Direct config file path. |
| `LINEAR_API_KEY` | Default Linear bot token env var. |
| `SLACK_TOKEN` | Default Slack bot token env var. |
| `QUAY_LINEAR_TIMEOUT_MS` | Linear adapter HTTP timeout. |
| `QUAY_SLACK_TIMEOUT_MS` | Slack adapter HTTP timeout. |
| `QUAY_INTEGRATION_TESTS=1` | Enables network-backed adapter integration tests. |

## Ticket Schema Resolution

`quay validate-ticket` resolves the ticket schema in this order:

1. `--schema-file <path>`
2. `QUAY_CONFIG_DIR/ticket_schema.toml`
3. `$HOME/.quay/ticket_schema.toml`
4. The shipped default schema.

`validate-ticket` skips the dispatcher's adapter wiring for fast spawns. It
opens the Quay DB lazily — only when the ticket payload's `repo` is
registered and has per-repo tag vocab configured — to enforce the layered
deployment + per-repo namespaces. The deployment config IS read in that
case so `data_dir` from `~/.quay/config.toml` is honored. A missing data
dir or unconfigured repo degrades cleanly to "no enforcement".

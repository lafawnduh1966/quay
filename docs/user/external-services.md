# External Services Setup

Quay can run with only local git/tmux for demos, but real tasks need external
service setup. This page covers the GitHub, Slack, Linear, worker, and
scheduler pieces that must all be true at the same time.

Use this as a deployment checklist before enqueueing production work.

## Required Tools On The Host

Install these on the same host and user account that will run `quay tick`:

- `git`
- `tmux`
- `gh`
- The configured worker command, for example `claude`

Verify:

```bash
git --version
tmux -V
gh --version
quay --version
```

## GitHub

Quay uses GitHub in two ways:

- Quay itself shells out to `gh` to discover PRs, read PR state, read CI checks,
  fetch inline review comments, and optionally close PRs during cancellation.
- The worker spawned by Quay must be able to push the `quay/<slug>` branch and
  open or update a PR.

### Authenticate `gh`

Interactive setup:

```bash
gh auth login
gh auth status
```

Headless setup:

```bash
export GH_TOKEN=...
gh auth status
```

GitHub CLI also recognizes `GITHUB_TOKEN`; for GitHub Enterprise use
`GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`.

If you authenticate with `gh auth login --with-token` using a classic personal
access token, GitHub CLI documents minimum scopes of `repo`, `read:org`, and
`gist`. If you use a fine-grained token through `GH_TOKEN`, grant access to the
target repository and make sure the token can read pull requests/checks and
write branches/pull requests.

### Verify Repo Access

Run these from the Quay host:

```bash
cd <any checkout or worktree for the target repo>
gh repo view
gh pr list --state open --json number
```

The worker also needs noninteractive git push access to the target remote:

```bash
git ls-remote <repo_url> HEAD
```

For SSH remotes, load the SSH key for the user that runs Quay. For HTTPS
remotes, configure a credential helper or token flow that works without a
prompt. A command that prompts interactively will hang or fail inside tmux.

### Bare Clone

Quay does not clone repos automatically. After `quay repo add`, materialize the
bare clone at `<repos_root>/<repo_id>.git`:

```bash
git clone --bare git@github.com:owner/repo.git <repos_root>/<repo_id>.git
```

## Slack

Slack is used for two paths:

- `quay enqueue --linear-issue` can fetch the source thread and include it in
  the worker brief.
- The orchestrator can use Slack for human questions, then record the answer
  through `quay record-human-reply`.

Claimless legacy `waiting_human` tasks with an existing `slack_thread_ref` can
still be completed by the old tick-owned Slack post/reply path.

### Create And Install A Slack App

Create a Slack app with a bot token, install it to the workspace, and export the
token for the Quay process:

```bash
export SLACK_TOKEN=xoxb-...
```

If you renamed the env var:

```toml
[adapters.slack]
enabled = true
bot_token_env = "QUAY_SLACK_TOKEN"
```

```bash
export QUAY_SLACK_TOKEN=xoxb-...
```

### Required Slack Capabilities

Grant scopes for the conversation types Quay will use:

- `chat:write` for posting escalation replies with `chat.postMessage`.
- The relevant history scopes for reading threads with `conversations.replies`:
  `channels:history`, `groups:history`, `im:history`, and/or `mpim:history`.

Slack channel access still matters. Invite the app to private channels and to
public channels where you expect it to read or write. Slack's posting docs note
that new apps do not automatically get permission to post in every public
channel; `chat:write.public` is only useful if you intentionally want public
channel posting without joining, and it does not remove the need for matching
read access when Quay fetches replies.

### Thread References

Quay stores Slack threads as:

```text
<channel_id>:<message_ts>
```

The Linear `quay-config` block should use a Slack permalink:

```yaml
slack_thread: https://example.slack.com/archives/C123456/p1712345678901234
```

Quay converts it to:

```text
C123456:1712345678.901234
```

## Linear

Linear is only used by `quay enqueue --linear-issue`. Quay reads the issue,
comments, and the `quay-config` block. Quay does not write Linear state.

### Create A Linear API Key

Create a personal API key in Linear account security/API settings and export it:

```bash
export LINEAR_API_KEY=...
```

If you renamed the env var:

```toml
[adapters.linear]
enabled = true
api_key_env = "QUAY_LINEAR_API_KEY"
```

```bash
export QUAY_LINEAR_API_KEY=...
```

Linear supports restricted personal API keys. For Quay's current adapter, grant
read access to the teams/issues the deployment will enqueue. If you restrict
the key to specific teams, tickets outside those teams will fail as not found or
as an adapter error.

### Ticket Requirements

Each Linear ticket used with `--linear-issue` must:

- Not be a draft.
- Contain exactly one `quay-config` fenced block.
- Include at least one author.
- Include at least one tag after schema validation.
- Optionally include a Slack permalink.

See [Ticket Authoring](ticket-authoring.md).

## Quay Config

Enable adapters in the config file loaded by the process:

```toml
[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
max_thread_messages = 200
```

Confirm the same environment is visible to Quay:

```bash
for v in LINEAR_API_KEY SLACK_TOKEN GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!v:-}" ]; then echo "$v is set"; fi
done
quay task list
```

## Scheduler Environment

Cron, systemd, and launchd often run with a different environment from your
interactive shell. Make sure the scheduled `quay tick` process has:

- `PATH` containing `git`, `gh`, `tmux`, and the worker command.
- `QUAY_DATA_DIR`, `QUAY_CONFIG_FILE`, or `QUAY_CONFIG_DIR` if you rely on them.
- `LINEAR_API_KEY` or your configured Linear token env var.
- `SLACK_TOKEN` or your configured Slack token env var.
- `GH_TOKEN`, `GITHUB_TOKEN`, or stored `gh` credentials.
- SSH agent/socket or HTTPS credentials for git push.

Prefer an explicit wrapper script for scheduled ticks:

```bash
#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export QUAY_DATA_DIR="/var/lib/quay"
export LINEAR_API_KEY="..."
export SLACK_TOKEN="..."
export GH_TOKEN="..."

exec /usr/local/bin/quay tick
```

## Smoke Tests

Before enqueueing real work:

```bash
# Quay can start and read its DB.
quay task list

# GitHub CLI is authenticated for the target repo.
cd <target repo checkout>
gh auth status
gh pr list --state open --json number

# Git can reach the remote noninteractively.
git ls-remote <repo_url> HEAD

# Linear token can read a candidate issue.
quay enqueue --repo <repo_id> --linear-issue <KEY-123> --tag smoke
```

For the final command, use a safe test repo or a disposable ticket. It performs
real enqueue substrate work once Linear/Slack validation succeeds.

## Official References

- [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login)
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)
- [GitHub CLI PR creation](https://cli.github.com/manual/gh_pr_create)
- [Slack `chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Slack `conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)
- [Linear GraphQL getting started](https://linear.app/developers/graphql)
- [Linear API keys](https://linear.app/docs/api-and-webhooks)

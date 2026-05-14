# Troubleshooting

Quay write-command errors are JSON objects on stderr:

```json
{"error":"bare_clone_missing","message":"...","repo_id":"myrepo"}
```

Read the `error` field first. The `message` is intended for humans and may
include the concrete recovery command or path.

## `repos_root_missing`

You configured an explicit `repos_root`, but that directory does not exist.
Quay creates the derived default `${data_dir}/repos`, but it does not create
operator-configured paths.

Fix:

```bash
mkdir -p /configured/repos_root
```

Then retry the command.

## `bare_clone_missing`

The repo is registered, but the expected bare clone is missing.

Fix:

```bash
git clone --bare <repo_url> <repos_root>/<repo_id>.git
```

Use `quay repo list` to inspect registered repo URLs and ids.

## `bootstrap_failed`

The repo's `install_cmd` exited non-zero during enqueue. Quay rolls back the new
task and worktree.

Fix the repo registration or dependency installation, then enqueue again:

```bash
quay repo update myrepo --install-cmd "bun install --frozen-lockfile"
```

## `adapter_not_enabled`

You called an adapter-backed path, usually `quay enqueue --linear-issue`, but
the adapter is not enabled in `config.toml`.

Fix:

```toml
[adapters.linear]
enabled = true
```

## `adapter_not_configured`

An enabled adapter tried to make an API call, but its token env var was empty.

Fix:

```bash
export LINEAR_API_KEY=...
export SLACK_TOKEN=...
```

Or update `api_key_env` / `bot_token_env` in config.

## `ticket_block_invalid`

The Linear ticket body is missing a valid `quay-config` block, has multiple
blocks, or has malformed block content.

Fix the ticket body and retry `quay enqueue --linear-issue`.

## `ticket_not_actionable`

The Linear issue exists but is a draft. Quay rejects draft tickets.

## `branch_collision_unresolvable`

Quay could not find an unused `quay/<slug>` branch for the task. Check local
branches, remote branches, and open PRs for the generated branch name.

## `repo_has_active_tasks`

`quay repo remove` refuses to archive a repo while active tasks still reference
it.

Finish, cancel, or park those tasks first. `repo remove` allows terminal and
parked tasks to keep their repo reference.

## `budget_exhausted`

The task has consumed its retry budget. `submit-brief --reason blocker_resolved`
is rejected in this state.

Use one of:

```bash
quay escalate-human <task_id> --claim-id <claim_id> --question-file ./question.md
quay cancel <task_id>
```

After asking a human, use `record-human-reply` to persist the answer, then
`submit-brief --reason advice_answered`; that reason is allowed because it does
not consume retry budget.

## `worktree_error`

Repeated spawn failures parked the task. Inspect:

```bash
quay task get <task_id>
quay task events <task_id>
quay artifact get <task_id> session_log --path
```

Manual recovery is currently cancellation:

```bash
quay cancel <task_id> --keep-worktree
```

## `orchestrator_loop`

The task was claimed repeatedly and the claims expired repeatedly. Inspect the
orchestrator process that owns `task claim` / `submit-brief` /
`escalate-human` / `record-human-reply`.

Manual recovery is cancellation.

## Stale `waiting_human` Claim

Human waits can legitimately outlive the normal claim timeout, so tick does not
auto-release `waiting_human` rows that still have a `claim_id`.

Inspect claimed handoffs:

```bash
quay handoff list --status claimed
quay task get <task_id>
```

If the owning orchestrator is known dead, use the `claim_id` from the handoff
row to reopen the handoff:

```bash
quay task release-claim <task_id> --claim-id <claim_id>
```

The task returns to `awaiting-next-brief`, and another orchestrator can claim it.

## `non_budget_loop`

The task exceeded the configured cap for review/conflict respawns. Inspect the
latest `review_comments` or `conflict_slice` artifact and decide whether to
cancel or recover manually.

## Tick Shows `tick_error`

Tick isolates errors per task and continues. Inspect:

```bash
quay task get <task_id>
quay task events <task_id>
```

Many tick errors clear automatically after the next successful observation.
Persistent tick errors usually point to adapter auth, GitHub CLI setup, missing
tmux, or repo/worktree state.

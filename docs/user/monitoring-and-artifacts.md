# Monitoring And Artifacts

Quay read commands emit deterministic JSON on stdout. Write-command failures
emit JSON on stderr.

## List Tasks

```bash
quay task list
quay task list --state queued
quay task list --state queued --state running
quay task list --repo myrepo
quay task list --external-ref ENG-1234
```

Output is a JSON array ordered by creation time and task id. Rows include:

- `task_id`
- `repo_id`
- `state`
- `external_ref`
- `branch_name`
- `attempts_consumed`
- `retry_budget`
- `budget_exhausted`
- `created_at`
- `updated_at`

## Get One Task

```bash
quay task get <task_id>
```

Output includes the task-list fields plus:

- `pr_number`
- `pr_url`
- `head_sha`
- `base_sha`
- `current_attempt`
- `recent_events`

`recent_events` is limited to the latest 20 events.

## Full Event Log

```bash
quay task events <task_id>
```

Output is the full append-only task event log, oldest first.

## Artifacts

Get the latest artifact of a kind:

```bash
quay artifact get <task_id> brief
quay artifact get <task_id> blocker
quay artifact get <task_id> session_log
```

Get an artifact for a specific attempt:

```bash
quay artifact get <task_id> brief --attempt 2
```

Print only the artifact path:

```bash
quay artifact get <task_id> final_prompt --path
```

Without `--path`, Quay streams raw artifact bytes to stdout. This preserves
binary and invalid UTF-8 artifacts such as `malformed_signal`.

## Common Artifact Kinds

| Kind | Meaning |
| --- | --- |
| `ticket_snapshot` | Snapshot of source ticket/context at enqueue time. |
| `brief` | Human/orchestrator brief for an attempt. |
| `final_prompt` | Worker preamble plus brief. |
| `session_log` | Captured tmux output. |
| `usage` | JSON envelope from the agent's `--output-format json` stdout (`.quay-usage.json`), captured per attempt. |
| `tool_trace` | Tool-call / debug stream from the agent's `--debug-file` (`.quay-tool-trace.log`), captured per attempt with a 4 MiB tail. |
| `blocker` | Valid `.quay-blocked.md` written by a worker. |
| `malformed_signal` | Invalid blocker signal bytes. |
| `ci_failure_excerpt` | CI failure details captured from GitHub checks. |
| `review_comments` | Snapshot of posted review body and inline comments. Used for review respawns and synthetic review forensics. |
| `review_blocker` | Reviewer blocker or infrastructure-failure diagnostic. |
| `conflict_slice` | Snapshot of merge-conflict observation. |
| `slack_escalation_post` | Human question body recorded by `escalate-human`. |
| `slack_reply` | Human Slack reply recorded by the orchestrator, or by legacy tick ingestion. |
| `last_failure` | Would-be retry brief when retry budget is exhausted. |

## Tick Errors

Tick isolates per-task failures. When one task fails during a tick, Quay records
a `tick_error` event and continues processing other tasks. A later successful
tick path clears the task's `tick_error` field.

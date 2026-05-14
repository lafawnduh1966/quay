# Concepts

Quay is a single-host CLI substrate for running coding tasks in isolated git
worktrees. It does not run a server or broker. An external scheduler runs
`quay tick` periodically, and each tick advances tasks by observing local
state, tmux sessions, git, GitHub, and Slack.

## Actors

- Operator: installs Quay, registers repos, runs tick scheduling, and recovers
  parked tasks.
- Orchestrator: calls Quay write commands, usually from another automation
  layer. It owns ticket policy and human escalation decisions.
- Quay: persists task state, creates worktrees, spawns workers, polls external
  state, stores artifacts, and enforces retry/capacity rules.
- Worker: the coding agent process spawned in tmux. It works inside one
  worktree and exits after opening/updating a PR, writing a blocker, or failing.

## Repositories

Quay stores repo metadata in SQLite, but it does not clone target repos for you.
Before enqueueing work, the operator must:

1. Register metadata with `quay repo add`.
2. Create a bare clone at `<repos_root>/<repo_id>.git`.

At enqueue time, Quay fetches the configured base branch, creates a local branch
named `quay/<slug>`, creates a worktree, runs the repo `install_cmd`, stores
the brief/final prompt artifacts, and creates the first pending attempt.

## Tasks And Attempts

A task is the durable unit of work. An attempt is one worker run for that task.

Every attempt has:

- A reason, such as `initial`, `ci_fail`, `crash`, `review`, or
  `blocker_resolved`.
- A brief artifact.
- A final prompt artifact, built from Quay's worker preamble plus the brief.
- Optional artifacts captured during or after the worker run.

Budget-consuming attempts increment `attempts_consumed` when tick promotes the
attempt from `queued` to `running`. Review and conflict respawns do not consume
retry budget.

## Tick

`quay tick` is a one-shot supervisor pass. It:

- Finalizes pending cancels.
- Observes running workers.
- Polls PR, CI, review, conflict, claim, and Slack states.
- Promotes queued tasks to running up to `max_concurrent`.
- Emits newline-delimited JSON, one action per processed task.

A supervisor lock prevents overlapping ticks and serializes side effects with
`quay cancel`.

## Artifacts

Artifacts are snapshots of data that crosses a boundary, such as:

- `ticket_snapshot`
- `brief`
- `final_prompt`
- `session_log`
- `blocker`
- `malformed_signal`
- `ci_failure_excerpt`
- `review_comments`
- `conflict_slice`
- `slack_escalation_post`
- `slack_reply`
- `last_failure`

Artifacts are stored under the data directory and indexed in SQLite.

## States

Common active states:

- `queued`: ready for a future tick to spawn.
- `running`: worker session is active or recently active.
- `pr-open`: worker opened or updated a PR; Quay is polling PR/CI.
- `done`: CI passed, but the PR is still open. This is not terminal.
- `awaiting-next-brief`: Quay needs orchestrator input.
- `claimed-by-orchestrator`: an orchestrator has claimed the task.
- `waiting_human`: an orchestrator-owned human question is awaiting an answer.

Parked states:

- `worktree_error`: repeated spawn/worktree failures.
- `orchestrator_loop`: repeated claim expirations.
- `non_budget_loop`: too many review/conflict respawns.

Terminal states:

- `merged`
- `closed_unmerged`
- `cancelled`

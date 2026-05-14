# Running Quay

Quay advances work through `quay tick`. The command is one-shot and should be
scheduled externally with cron, systemd, launchd, or another supervisor.

## Tick

```bash
quay tick
```

Output is newline-delimited JSON. Each line describes one task action:

```json
{"task_id":"...","action":"spawned"}
{"task_id":"...","action":"ci_pending"}
```

If another tick or cancel holds the supervisor lock, `quay tick` exits cleanly
without doing work.

## What Tick Processes

Each cycle:

1. Finalizes tasks with `cancel_requested_at`.
2. Observes `running` workers.
3. Polls `pr-open` tasks for PR state, conflicts, and CI.
4. Polls `done` tasks for PR state, conflicts, and review feedback.
5. Releases stale orchestrator claims.
6. Handles claimless legacy `waiting_human` rows, either through the old Slack
   path or by requeueing rows that have no thread.
7. Reaps and spawns `pr-review` reviewer attempts up to
   `max_concurrent_reviewers` when `[reviewer].enabled = true`.
8. Promotes `queued` tasks to `running` up to `max_concurrent`.

Tasks that become `queued` during a tick are not promoted until a later tick.

## Worker Contract

Quay writes the final prompt to `.quay-prompt.md` in the worktree, then starts a
tmux session. The worker should:

- Work inside the task worktree.
- Push the `quay/<slug>` branch.
- Open a PR if one does not already exist.
- Exit after opening/updating the PR.
- If blocked, write a non-empty UTF-8 `.quay-blocked.md` and exit.
- Avoid interactive tools.

Quay reserves `.quay-*` files except for `.quay-blocked.md`.

## Running State Outcomes

When the worker dies, tick collects the session log and checks:

- Valid `.quay-blocked.md`: stores `blocker`, transitions to
  `awaiting-next-brief`.
- Malformed `.quay-blocked.md`: stores `malformed_signal`, schedules a retry.
- PR exists and progress was made: transitions to `pr-open`.
- Existing PR but no trackable progress: schedules a crash retry.
- No PR and no blocker: schedules a crash retry.

Live workers are killed and retried when they exceed
`max_attempt_duration_seconds` or stop producing fresh log output past
`staleness_threshold_seconds`.

## PR And CI Outcomes

For `pr-open`:

- Merged PR: terminal `merged`.
- Closed unmerged PR: terminal `closed_unmerged`.
- Merge conflict: schedules a non-budget `conflict` respawn.
- CI pending: remains `pr-open`.
- CI passed: transitions to `done`, unless the reviewer gate is enabled; then
  tick schedules a `review_only` attempt and transitions to `pr-review`.
- CI failed: schedules a budget-consuming `ci_fail` retry.

For `pr-review`:

- Reviewer approval: transitions to `done`.
- Reviewer changes requested on a Quay-owned PR: schedules a non-budget
  `review` respawn and returns to `queued`.
- Reviewer changes requested on a synthetic PR: transitions to
  `waiting_external_changes` until CI calls `quay review-pr` for a new SHA.
- Reviewer infrastructure failures retry at the same SHA twice, then park in
  `non_budget_loop`.

For `done`:

- Merged PR: terminal `merged`.
- Closed unmerged PR: terminal `closed_unmerged`.
- Merge conflict: schedules a non-budget `conflict` respawn.
- Latest review decision `CHANGES_REQUESTED`: schedules a non-budget
  `review` respawn.

`done` means CI passed and Quay is waiting for human merge/review. It is not a
terminal state.

## Claims And Human Escalation

An orchestrator claims a task in `awaiting-next-brief`:

```bash
quay task claim <task_id>
```

Then it either submits a new brief:

```bash
quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file ./next-brief.md \
  --reason blocker_resolved
```

Or escalates to a human:

```bash
quay escalate-human <task_id> \
  --claim-id <claim_id> \
  --question-file ./question.md \
  --thread-ref C123456:1712345678.901234
```

After the orchestrator receives the human answer:

```bash
quay record-human-reply <task_id> \
  --claim-id <claim_id> \
  --reply-file ./reply.md \
  --thread-ref C123456:1712345678.901234

quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file ./next-brief.md \
  --reason advice_answered
```

`submit-brief --reason blocker_resolved` consumes retry budget when promoted.
`submit-brief --reason advice_answered` does not.

Stale claims return to `awaiting-next-brief`. Repeated stale claims park the
task in `orchestrator_loop`.

## Cancellation

```bash
quay cancel <task_id>
quay cancel <task_id> --close-pr
quay cancel <task_id> --keep-worktree
```

Cancel acquires the supervisor lock, writes durable cancel intent, kills a live
worker if needed, performs cleanup, and transitions the task to `cancelled`.

`--close-pr` asks GitHub to close the PR and deletes the remote branch.
Without `--close-pr`, Quay preserves the remote branch when it sees an open PR.

`--keep-worktree` detaches the worktree instead of removing it.

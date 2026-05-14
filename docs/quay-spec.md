# Quay — Specification (v1)

**Status:** Draft, frozen from design conversation 2026-04-25.
**Companion docs:** `didier-task-runner.md` (reference inventory of the Didier prototype), `agent-control-pane.md` (early design notes; superseded by this document where they conflict).

---

## 1. Overview

Quay is a CLI substrate for running coding tasks autonomously. An orchestrator agent (Hermes is the v1 caller; future orchestrators are anticipated) hands Quay a brief and a target repo. Quay creates an isolated git worktree, spawns a non-interactive coding agent inside a tmux session, and supervises the work across a cron-driven `quay tick` loop until the task reaches a terminal outcome (PR merged, PR closed, or task cancelled).

Two actors run the loop:

- **Orchestrator (Hermes):** owns business context — fetches tickets, gathers surrounding context, classifies complexity, composes briefs, talks to Linear, decides *when* to escalate to a human and *which* Slack route to use.
- **Quay (the CLI):** owns substrate — worktree creation, worker spawning, state persistence, transition logic, polling external truth (GitHub PR/CI, Slack threads), enforcement of capacity and retry budgets, and the actual Slack API calls (post + reply polling) once the orchestrator has decided to escalate.

A third actor exists per task:

- **Worker:** an ephemeral coding-agent subprocess inside a tmux session. Reads a non-interactive prompt, edits code, opens a PR, exits. No access to Linear, Slack, or any orchestrator state.

Quay is single-host (Mac or Linux VPS), one orchestrator at a time, one tmux backend in v1. Anything that would require remote workers, multiple orchestrators, or a non-tmux backend is a non-goal.

---

## 2. Goals and non-goals

### Goals

- Supervise the lifecycle of coding tasks from enqueue to terminal, including retry, escalation, conflict resolution, review feedback, and cancellation.
- Persist every artifact that crosses a task boundary (caller brief, preamble, final prompt, blocker, session log, CI excerpts, review comments, ticket snapshot, ingested human replies). Snapshot, not point-to, for anything that can change in the source system.
- Provide a stable CLI surface that any orchestrator can drive. Hermes is v1; the surface is not Hermes-specific.
- Run on Mac and Linux VPS deployments without external infrastructure (no broker, no centralized server, no daemon — just a SQL file, a filesystem, a cron entry).
- Preserve a clean separation: orchestrator owns reasoning and policy, CLI owns substrate, worker executes.

### Non-goals (v1)

- **Non-tmux worker backends.** No adapter abstraction. tmux is the only worker substrate.
- **Remote workers.** No RPC, no HTTP, no out-of-host coordination.
- **Auto-recovery from worktree corruption.** Failures are surfaced; a human resolves.
- **Owning approval policy.** "Should this task be spawned" is not a Quay decision — it lives in the orchestrator skill.
- **Owning ticket-system semantics.** Quay does not know what Linear is. The orchestrator passes a ticket snapshot at enqueue.
- **Owning escalation routing.** Quay does not decide when to involve a human. The orchestrator does, then calls Quay to transition the task to `waiting_human`.
- **Multiple orchestrators on one Quay deployment.** Forward-compatible at the CLI level (read commands are JSON, no auth coupling), but not exercised in v1.
- **Auto-merging or auto-approving PRs.** Quay never merges. Quay never approves. Carried forward from Didier as a hard constraint.
- **Training pipelines / orchestrator improvement loops.** Artifacts are stored in a shape that supports later training, but the training itself is out of scope.

---

## 3. Actors and boundaries

### Actors

- **External world** — Linear, Slack, GitHub, the humans behind them.
- **Orchestrator** — Hermes (v1). The only legitimate caller of Quay's write commands.
- **Quay** — the CLI and its tick loop.
- **Worker** — the coding-agent subprocess running inside a tmux session, against a worktree.

### Task boundary rule

An **artifact** is data that one actor hands to another, or observes from another. Internal-to-one-actor work is not an artifact and is not stored.

| Boundary crossing | Artifact? |
|---|---|
| External → Orchestrator (per task) | Yes — e.g. ticket snapshot, ingested Slack reply |
| Orchestrator → Quay | Yes — caller brief |
| Quay → Worker | Yes — protocol preamble, final prompt |
| Worker → Quay | Yes — signal file (`.quay-blocked.md`), session log, exit-code marker (`.quay-exit-code`), observed PR/CI state |
| Worker → External | Captured via Quay's observation (PR pointer + observed slices) |
| Quay → External (per task) | Yes — Slack escalation message |
| Orchestrator → Orchestrator (internal reasoning, tool calls) | No |
| Quay → Quay (polling, tick branching) | No |
| Worker → Worker (individual tool calls inside the session) | No — the aggregated session log is the crossing |

### Ownership

- **Orchestrator owns:** business context, complexity gating, approval policy, brief composition, knowledge research, decision to involve a human (when), Slack thread selection (where), ticket-system integration.
- **Quay owns:** worktree creation and cleanup, worker spawn/kill/observation, state persistence, transition logic, capacity caps, retry budget, polling external truth (GitHub PR/CI, Slack threads it has posted to), Slack API wire calls (posting and polling on threads the orchestrator selected), artifact store.
- **Worker owns:** the code change. Nothing else.

---

## 4. Task lifecycle

### State diagram

```
       enqueue
          │
          ▼
     ┌────────┐  capacity   ┌─────────┐  PR opened   ┌─────────┐  CI pass   ┌──────┐
     │ queued ├────────────►│ running ├─────────────►│ pr-open ├───────────►│ done │
     └────▲───┘             └────┬────┘              └────┬────┘            └──┬───┘
          │                      │                        │                    │
          │                      │ dead + signal file     │ CI fail / conflict │ merged / closed
          │                      │                        │ → schedule retry   │
          │                      │ dead, no PR, no signal │ → queued           ▼
          │                      │ → schedule retry       │              [terminal]
          │                      │                        ▼
          │                      │                   merged / closed → [terminal]
          │                      ▼
          │            ┌─────────────────────┐
          │            │ awaiting-next-brief │ ◄── legacy waiting_human requeue
          │            └──────────┬──────────┘     claim timeout
          │                       │ orchestrator pulls + claims
          │                       ▼
          │            ┌────────────────────────┐
          │            │ claimed-by-orchestrator│
          │            └──┬───────────────────┬─┘
          │  submit-brief │                   │ escalate-human
          └───────────────┘                   ▼
                                        ┌──────────────┐
                                        │ waiting_human│
                                        └──────────────┘

  Every respawn (orchestrator-driven via submit-brief, Quay-driven for ci_fail/crash/stale/wall_clock/
  malformed_signal/review/conflict) transitions the task to `queued`. Tick promotes `queued → running`
  as the single spawn point. Capacity caps and budget consumption both live there.

  claim age > claim_timeout × max_claim_expirations  →  orchestrator_loop (parked, manual)
  non_budget_respawns_consumed > cap (post-increment) →  non_budget_loop   (parked, manual)
  spawn_failures_consecutive >= cap                  →  worktree_error    (parked, manual)

Terminal:    merged, closed_unmerged, cancelled
Parked:      worktree_error, orchestrator_loop, non_budget_loop  (manual recovery via quay cancel)
Flag:        budget_exhausted (set on awaiting-next-brief; orchestrator reads via pull)
```

### State table

| State | Meaning | Worker alive? | Tick activity |
|---|---|---|---|
| `queued` | Registered, waiting for a concurrent slot. | No | Capacity check; spawn when slot opens. |
| `running` | Worker session active. | Yes (or recently) | Liveness, staleness, dead-with-PR, dead-with-signal, crash detection. |
| `pr-open` | PR opened by worker; awaiting CI. | No (worker exits after PR) | Poll PR state (merged / closed transitions to terminal); poll `mergeable`; poll CI. |
| `done` | CI passed; awaiting human review/merge. **Not terminal.** | No | Poll PR state, review decision, `mergeable`. |
| `awaiting-next-brief` | Blocker ingested, human reply ingested, or retry budget exhausted; awaiting orchestrator pickup. | No | Inert; orchestrator pulls + claims. Tick auto-releases stale claims (see `claimed-by-orchestrator`). |
| `claimed-by-orchestrator` | Orchestrator has claimed the task and is composing a brief or deciding to escalate. | No | Tick auto-releases the claim back to `awaiting-next-brief` if the claim age exceeds `claim_timeout_seconds`. After `max_claim_expirations` consecutive expirations, transitions to `orchestrator_loop`. |
| `orchestrator_loop` | Orchestrator has crash-looped on this task (`max_claim_expirations` consecutive `claim_expired` events). Parked. | No | None. Manual recovery via `quay cancel`. |
| `waiting_human` | Orchestrator-owned human question is awaiting an answer. | No | New flow is inert to tick; orchestrator records the reply and submits the next brief. Claimless legacy rows with a Slack thread may still use tick's old Slack post/reply path; claimless rows without a thread are requeued to `awaiting-next-brief`. |
| `worktree_error` | Filesystem or git error encountered; parked. | N/A | None. Manual recovery via `quay cancel`. |
| `non_budget_loop` | Post-increment `non_budget_respawns_consumed > max_non_budget_respawns`; parked. (With cap=20: scheduled 20 respawns, then parked on the 21st trigger.) | N/A | None. Manual recovery via `quay cancel`. |
| `budget_exhausted` (flag, not state) | Set on a task in `awaiting-next-brief` when retry budget hits cap. | N/A | None. Orchestrator sees the flag on pull, decides to escalate-human or cancel. |
| `merged` | **Terminal.** PR merged. | No | None. Cleanup per §5 "Branch cleanup rules per terminal". |
| `closed_unmerged` | **Terminal.** PR closed without merge. | No | None. Cleanup per §5 "Branch cleanup rules per terminal". |
| `cancelled` | **Terminal.** Operator-cancelled. | No | None. Worker killed; cleanup per §5 "Branch cleanup rules per terminal". |

### Non-obvious properties

1. **Worker-alive check precedes the PR check.** A live worker is left alone (subject to staleness); a dead worker is what triggers the PR/signal/retry cascade.
2. **`pr-open` is distinct from `running`.** CI green doesn't take a `running` task to `done` in one step.
3. **`done` is not terminal.** It means "awaiting human merge/review on GitHub." Terminal happens when the PR transitions to merged or closed.
4. **Review feedback and merge conflicts do not consume retry budget.** Both are external-state-changed events, not failures.
5. **Staleness is a separate trigger from exit.** A live worker that hasn't logged in N minutes is treated as stuck.
6. **Crash ≠ blocker.** Worker dead, no PR, no signal file → crash (generic retry). Worker dead, no PR, signal file present → blocker (handed to orchestrator).
7. **All transitions go through one chokepoint** that validates against the state machine, persists state, emits the event, and bundles integration side-effects.

---

## 5. Tick behavior

### Invocation

`quay tick` is a one-shot CLI invocation. The deployment configures the schedule (cron, systemd timer, launchd) externally. Default cadence: 5 minutes.

### Concurrency policy

**Supervisor lockfile.** All processes that perform supervisor side effects (tmux spawn/kill, GitHub API mutating calls like `gh pr close`, Slack API calls, worktree creation/removal, branch deletes) acquire the same lockfile (`tick_lock_path`, retained name for backwards compatibility — semantically the supervisor lock):

- `quay tick` acquires it at start, holds it for the entire cycle, and releases on exit. If the lock is already held when a tick fires, the new tick exits immediately without action; the next scheduled fire retries.
- `quay cancel` acquires it **before** writing `cancel_requested_at` and holds it through the entire cancel finalizer (including `gh pr close`, branch deletes, worktree removal, the SQL terminal transition). If the lock is held by an in-flight tick, `quay cancel` blocks until the tick finishes (worst case ~one tick duration). The lock is the primary mechanism that prevents tick-owned side effects from racing with cancel-owned side effects on the same task.
- `quay enqueue` does substrate work (`git fetch`, `git worktree add`, `install_cmd`) but only against a brand-new task that no concurrent tick or cancel can have observed yet. It does NOT acquire the supervisor lock; its substrate operations are safe against concurrent ticks because git's own object-store locks serialize bare-clone access. (This is a v1 simplification; if `enqueue` ever evolves to touch existing-task state, it must move under the supervisor lock too.) Note: enqueue does NOT clone; it validates that the bare clone already exists at `<repos_root>/<repo_id>.git` (via `bareCloneExists`) and errors with `bare_clone_missing` if the clone is absent. Materialization is the operator's responsibility.
- `quay submit-brief`, `quay escalate-human`, `quay record-human-reply`, `quay task claim`, and `quay task release-claim` perform SQL-only writes and rely on their ownership-fence predicates instead of the supervisor lock. They are safe against concurrent ticks because their writes are predicated on `state` + `claim_id` + `cancel_requested_at IS NULL`, which atomically reject any in-flight intent the SQL writer didn't see.

**Belt-and-suspenders SQL predicate.** Even with the supervisor lock, every tick-owned mutating SQL transaction includes `AND cancel_requested_at IS NULL` in its `WHERE` clause. This catches:
- Forced lock takeover by `quay cancel` (e.g., operator kills a hung tick and re-runs cancel — see "Lock recovery" below).
- Bug-class regressions where a future code change accidentally drops the lock acquisition in one tick code path.
- The narrow window where a tick's per-task transaction reads state, releases CPU briefly, and the SQL row is concurrently modified by something the tick didn't expect.

On rowcount=0 from any tick-owned mutating write, tick aborts processing of that task for the rest of this cycle (logs `tick_error`, continues to the next task). The next tick re-reads the task and applies the right behavior — which, if `cancel_requested_at` is set, is the top-of-loop cancel finalizer.

**Lock recovery.** The lockfile holds the PID of the owning process. If a stale lock is observed (PID is no longer alive), a new acquirer takes over after a short grace period (default 30 s). This keeps a hung-tick-then-killed scenario from indefinitely blocking cancel. The grace period is configurable via `supervisor_lock_stale_seconds`.

### Per-task error isolation

Each task is processed in its own try/except. A failing per-task check logs the error to the events table with `event_type = tick_error`, marks the task with a transient `tick_error` flag (cleared on the next successful tick), and tick continues to the next task. Tick never aborts a cycle because of one task.

### Per-cycle behavior (per task)

**Spawn path (canonical, single):**

- **All spawns happen at one point in the system: tick promoting `queued → running`.** Initial spawns and every kind of respawn alike. There is no other code path that creates a tmux session.
- `submit-brief` (orchestrator) and Quay-driven retry triggers (CI fail, crash, stale, wall-clock, malformed signal, review feedback, merge conflict) all **schedule a new attempt row** (with `spawned_at = NULL`) and transition the task to `queued`. Tick promotes when capacity allows by setting `spawned_at` and incrementing `attempts_consumed` iff `consumed_budget = 1`.
- Consequences:
  - `max_concurrent` is enforceable on every retry, not just initial spawns.
  - Budget is consumed at the unified promotion point (per the budget rules below), not at trigger-detection or scheduling.
  - Side-effect ordering is identical for every spawn (one set of recovery rules).
  - The added latency between trigger and respawn is at most one tick interval — acceptable for a minute-scale system.

**Budget rules (canonical):**

- The retry budget is consumed **at spawn time** — when tick promotes `queued → running`, never at trigger-detection time. Triggers (worker blocker, CI fail, crash, staleness, wall-clock, malformed signal, review feedback, merge conflict) only schedule what happens next; whether budget is consumed depends on the `attempts.reason` of the resulting spawn.
- Budget-consuming spawn/respawn reasons: `initial` (set internally by tick on the first spawn from `queued`), `submit-brief --reason blocker_resolved`, and Quay-driven deterministic retries (`ci_fail`, `crash`, `stale`, `wall_clock`, `malformed_signal`).
- Non-consuming respawn reasons: `submit-brief --reason advice_answered` (after an orchestrator-recorded human reply), `review` (CHANGES_REQUESTED), `conflict` (merge conflict).
- `task.budget_exhausted` is a flag set **whenever the task transitions into `awaiting-next-brief` while `attempts_consumed >= retry_budget`** (proactive computation). The orchestrator sees the flag on pull and picks `escalate-human` or `cancel`.
- Where the pseudocode below says **"schedule deterministic retry: reason = X"**, the actual semantics are: if `attempts_consumed < retry_budget`, schedule a new attempt row (`spawned_at = NULL`, `consumed_budget = 1` for budget-consuming reasons) and transition to `queued`. Tick later promotes the row, incrementing `attempts_consumed` iff `consumed_budget = 1`. If `attempts_consumed >= retry_budget` at scheduling time, do **not** schedule — persist the would-be retry brief as a `last_failure` artifact, set `budget_exhausted = true`, transition to `awaiting-next-brief`.
- Where the pseudocode below says **"schedule non-budget respawn: reason = X"** (only for `review` and `conflict`), the canonical semantics are **increment-then-compare-then-decide**, in a single SQL transaction. `max_non_budget_respawns` is the **count of allowed respawns**: with cap = N, the Nth respawn schedules; the (N+1)th parks.
  1. Increment `tasks.non_budget_respawns_consumed` by 1.
  2. If the **post-increment** value is **greater than** `max_non_budget_respawns`: do **not** schedule a new attempt — transition to `non_budget_loop` (parked) and write `non_budget_loop_parked` event. Do not persist a `last_failure` artifact (the trigger is external state, not a failure to retry). Note: the increment is still committed; the counter records the rejected attempt for forensics and prevents a tie/race from re-trying.
  3. Else (post-increment ≤ cap): schedule a new attempt row (`spawned_at = NULL`, `consumed_budget = 0`) with the given reason; record the dedupe key (`last_review_id_acted_on` / `last_conflict_observation`); transition to `queued`. Tick later promotes the row without touching `attempts_consumed`.
  - This rule is identical for `pr-open` and `done` — every site that uses non-budget respawns goes through the same routine.
  - Worked example with `max_non_budget_respawns = 20`: respawns #1 through #20 each pass step 3 (post-increment values 1..20, all ≤ 20). Respawn #21 fails step 2 (post-increment 21 > 20) and parks. Total respawns scheduled before parking: exactly 20.
- `quay submit-brief --reason blocker_resolved` errors if `budget_exhausted = true` (orchestrator must use `escalate-human` or `cancel`). `submit-brief --reason advice_answered` is allowed even when `budget_exhausted = true` (it doesn't consume).

```text
for each task in active states:
  # Top-of-loop cancel check. Cancel intent is a durable task-level field
  # (tasks.cancel_requested_at), so it is honored from every non-terminal
  # state — including done, pr-open, claimed-by-orchestrator, waiting_human,
  # awaiting-next-brief, and parked states — not just running.
  if task.cancel_requested_at IS NOT NULL AND task.state != 'cancelled':
    run cancel_finalizer(task)   # idempotent; converges to cancelled
    continue to next task

  switch task.state:

    case queued:
      if capacity_available():
        # The pending attempt row (spawned_at = NULL) was created when this task entered queued.
        # Promote it: set spawned_at = now(), increment attempts_consumed iff consumed_budget = 1,
        # transition tasks.state = running, then perform the substrate spawn.
        promote pending attempt; transition → running; (substrate spawn happens per §5 spawn rules)
      else:
        skip

    case running:
      # First: detect spawn-failure recovery state.
      # A previous tick may have committed queued → running and set spawned_at,
      # but crashed before recording tmux_session. In that case there is no usable handle —
      # but the worker may have already started, pushed, and even opened a PR before the
      # owning tick crashed. We must check for evidence of progress BEFORE writing off the
      # attempt as a spawn failure, otherwise we'd kill a productive worker, roll back its
      # budget, and lose the link between Quay's state and a real external PR.
      if attempt.tmux_session IS NULL:
        # Step A: kill any orphan tmux session matching the canonical name. The orphan,
        # if any, is the very worker we're about to evaluate; killing it lets us read its
        # session log and signal file deterministically.
        tmux kill-session -t quay-task-<task.tmux_id>-<attempt.attempt_number>   # idempotent
        collect_log(canonical_name) → persist as session log artifact (best-effort; the
                                       session may have buffered no log if it never logged)

        # Step B: gather evidence — the same checks the dead-worker classifier runs.
        if .quay-blocked.md exists in worktree and parses as a valid blocker:
          # Worker started, ran far enough to write a blocker, then died (or its tmux
          # was killed in Step A). Honor the blocker; do NOT mark spawn_failed.
          ingest blocker; if budget exhausted: set flag + last_failure
          mark attempts.exit_kind = 'blocker_written'; ended_at = now()
          transition → awaiting-next-brief
          continue to next task

        elif .quay-blocked.md exists but fails validation:
          persist bytes as malformed_signal artifact; delete file
          mark attempts.exit_kind = 'crashed' (with malformed-signal sub-reason); ended_at = now()
          schedule deterministic retry: reason = malformed_signal; transition → queued
          continue to next task

        # Fetch fresh remote state. The worker may have pushed even if we never recorded its tmux session.
        git -C <bare-clone> fetch origin <branch>
        remote_sha_at_exit = git -C <bare-clone> rev-parse origin/<branch>  (or NULL if absent)
        record attempts.remote_sha_at_exit = remote_sha_at_exit; attempts.ended_at = now()
        pr_exists_at_exit  = (gh pr view <branch> reports a PR — open or closed/merged)
        pr_existed_at_spawn = attempts.pr_existed_at_spawn

        # Same progress predicate as the dead-worker classifier (§14 "Idempotent PR contract").
        no_progress = (remote_sha_at_exit == attempts.remote_sha_at_spawn OR remote_sha_at_exit IS NULL)
                      AND NOT (pr_exists_at_exit AND NOT pr_existed_at_spawn)

        if pr_exists_at_exit AND not no_progress:
          # The worker started, made remote progress (push and/or PR creation), and died.
          # Treat exactly as a clean dead-with-PR exit — preserve budget, transition to pr-open.
          mark attempts.exit_kind = 'pr_opened'
          transition → pr-open
          continue to next task

        if pr_exists_at_exit AND no_progress:
          # PR is from a prior attempt; this attempt didn't advance the remote.
          # Treat as no_progress (consumes budget) — same as dead-worker classifier.
          mark attempts.exit_kind = 'no_progress'
          schedule deterministic retry: reason = crash; transition → queued (or budget-exhausted handling)
          continue to next task

        # Step C: no worker evidence and no progress → genuine spawn-substrate failure.
        # This is the original spawn-failed rollback path; budget is preserved (decremented).
        set attempts.exit_kind = 'spawn_failed'; ended_at = now()
        if attempts.consumed_budget = 1: decrement tasks.attempts_consumed
        increment spawn_failures_consecutive
        if spawn_failures_consecutive >= max_spawn_failures: → worktree_error
        else: insert fresh scheduled attempt; transition → queued
        continue to next task

      handle = attempt.tmux_session
      alive = is_alive(handle)
      if alive:
        if attempt.kill_intent IS NOT NULL:
          # Previous tick (or quay cancel) wrote the intent but the kill didn't land.
          tmux kill(handle)   # idempotent retry; no SQL change
          continue to next task
        if (now - attempt.spawned_at) > max_attempt_duration_seconds:
          # Order: SQL kill-intent first, then tmux kill.
          set attempts.kill_intent = 'wall_clock' (in a single SQL transaction; no state change)
          tmux kill(handle)
          continue to next task   # the dead-worker branch on the next tick performs the transition
        elif log_freshness(handle) older than staleness_threshold:
          set attempts.kill_intent = 'stale'
          tmux kill(handle)
          continue to next task
        else:
          skip   # leave the worker alone this tick
      else:
        # worker dead
        collect_log(handle) → persist as session log artifact

        # Honor kill_intent before the dead-worker classifier — a kill we intended runs the
        # scheduled transition rather than re-detecting "no progress" or "no PR".
        if attempt.kill_intent = 'wall_clock':
          mark attempts.exit_kind = 'killed_wall_clock'; clear kill_intent
          schedule deterministic retry: reason = wall_clock; transition → queued (or budget-exhausted handling)
          continue to next task
        if attempt.kill_intent = 'stale':
          mark attempts.exit_kind = 'killed_stale'; clear kill_intent
          schedule deterministic retry: reason = stale; transition → queued (or budget-exhausted handling)
          continue to next task
        if attempt.kill_intent = 'cancel':
          # Note: in normal operation this branch is unreachable — the top-of-loop
          # cancel check runs the finalizer first whenever cancel_requested_at is set.
          # It survives only as a defensive backstop for the (impossible-by-construction)
          # case where kill_intent='cancel' was set without cancel_requested_at.
          run cancel_finalizer(task)
          continue to next task
        # Fetch fresh remote state — worker may have pushed; we need to know.
        git -C <bare-clone> fetch origin <branch>
        remote_sha_at_exit = git -C <bare-clone> rev-parse origin/<branch>  (or NULL if ref absent)
        record attempts.remote_sha_at_exit = remote_sha_at_exit; attempts.ended_at = now()
        # Read PR state at exit. The "did a PR exist at spawn time?" snapshot was recorded at promotion (see §5 spawn rules).
        pr_exists_at_exit  = (gh pr view <branch> reports a PR — open or closed/merged)
        pr_existed_at_spawn = attempts.pr_existed_at_spawn  -- bool, captured at promotion

        # Progress = the *remote* (PR) branch advanced *or* a brand-new PR was opened against it during this attempt.
        # Without the second clause, an attempt that crashes after `git push` but before `gh pr create`
        # would push the branch (advancing the remote), and the *next* attempt — which only opens the PR
        # without further pushes — would have remote_sha_at_exit == remote_sha_at_spawn and get
        # misclassified as no_progress. PR creation itself counts as progress.
        no_progress = (remote_sha_at_exit == attempts.remote_sha_at_spawn OR remote_sha_at_exit IS NULL)
                      AND NOT (pr_exists_at_exit AND NOT pr_existed_at_spawn)

        if .quay-blocked.md exists in worktree and parses as a valid blocker:
          ingest blocker; if budget exhausted: set flag + last_failure
          mark attempts.exit_kind = 'blocker_written'
          transition → awaiting-next-brief

        elif .quay-blocked.md exists but fails validation:
          persist bytes as malformed_signal artifact; delete file
          mark attempts.exit_kind = 'crashed' (with malformed-signal sub-reason)
          schedule deterministic retry: reason = malformed_signal; transition → queued

        elif pr_exists_at_exit AND not no_progress:
          # Either the worker pushed new commits this attempt, or it opened the PR for the first time
          # (or both). Either way, a real PR is now live and reflects the latest work.
          mark attempts.exit_kind = 'pr_opened'
          transition → pr-open

        elif pr_exists_at_exit AND no_progress:
          # Worker did not advance the remote this attempt and the PR is from a prior attempt.
          # Includes "committed locally but never pushed" — local commits do not update the PR.
          mark attempts.exit_kind = 'no_progress'
          schedule deterministic retry: reason = crash; transition → queued

        else:
          # No PR, no signal file: classic crash.
          mark attempts.exit_kind = 'crashed'
          schedule deterministic retry: reason = crash; transition → queued

    case pr-open:
      pr = gh pr view
      check state: merged → cleanup, transition → merged
                   closed → cleanup, transition → closed_unmerged
      check mergeable: CONFLICTING and (head_sha:base_sha) != last_conflict_observation
                       → snapshot conflict slice;
                         schedule non-budget respawn: reason = conflict
                         (canonical rule: increment non_budget_respawns_consumed; if cap reached,
                          park → non_budget_loop instead of scheduling; else record observation,
                          schedule attempt, transition → queued)
      check CI (per §5 "CI status rules"):
        pass → done
        fail → snapshot CI excerpt;
               schedule deterministic retry: reason = ci_fail; transition → queued (or budget-exhausted handling)
        pending → skip

    case done:
      pr = gh pr view
      check state: merged → cleanup, transition → merged
                   closed → cleanup, transition → closed_unmerged
      check mergeable: CONFLICTING and (head_sha:base_sha) != last_conflict_observation
                       → snapshot conflict slice;
                         schedule non-budget respawn: reason = conflict
                         (canonical rule applies; record last_conflict_observation in the same txn)
      check review: CHANGES_REQUESTED and latest_review_id != last_review_id_acted_on
                    → snapshot comments;
                      schedule non-budget respawn: reason = review
                      (canonical rule applies; record last_review_id_acted_on in the same txn)
      else: skip

    case awaiting-next-brief:
      # no polling; orchestrator pulls and claims via quay task claim
      skip

    case claimed-by-orchestrator:
      if claim_age > claim_timeout_seconds:
        # Auto-release in one SQL transaction: clear claim_id (fencing out the stale claimant),
        # clear claimed_at, increment claim_expirations_consecutive, write claim_expired event,
        # transition to either orchestrator_loop (cap reached) or awaiting-next-brief.
        emit claim_expired event
        increment task.claim_expirations_consecutive
        clear task.claim_id
        clear task.claimed_at
        if task.claim_expirations_consecutive >= max_claim_expirations:
          transition → orchestrator_loop
        else:
          transition → awaiting-next-brief
      else:
        skip

    case waiting_human:
      # New flow: rows with claim_id are orchestrator-owned and inert to tick.
      # Legacy claimless rows may still use the old Slack post/reply path.
      if task.claim_id IS NOT NULL:
        skip
      art = slack_escalation_post (latest for this attempt)

      # Step 1: capture the pre-post fence if we haven't yet (CLI did not capture it).
      if art.slack_pre_post_fence_ts IS NULL:
        fence = conversations.replies(slack_thread_ref) → latest ts on thread
        on read failure: log tick_error and skip; continue to next task
        set art.slack_pre_post_fence_ts = fence (one SQL txn)

      # Step 2: try to recover the bot-post ts from Slack if we don't have it yet.
      # Handles the case where a prior tick posted but crashed before persisting ts.
      if art.slack_recovered_post_ts IS NULL:
        replies = conversations.replies(slack_thread_ref)
        match = first bot-authored message in `replies` whose text contains art.escalation_nonce
        if match:
          set art.slack_recovered_post_ts = match.ts (also slack_post_ts if NULL); one SQL txn; never updated again

      # Step 3: post only if no Slack message exists for this escalation yet.
      if art.slack_post_ts IS NULL AND art.slack_recovered_post_ts IS NULL:
        post to Slack via API using the artifact body verbatim (nonce footer included)
        on success: set art.slack_post_ts = returned_ts, art.slack_recovered_post_ts = returned_ts (one SQL txn)
        on failure: log tick_error and skip
        continue to next task

      # Step 4: ingest replies. Lower bound is the recovered ts when known; else the fence.
      lower_bound = art.slack_recovered_post_ts if art.slack_recovered_post_ts IS NOT NULL else art.slack_pre_post_fence_ts
      poll Slack thread for non-bot replies with ts > lower_bound
      first matching reply → ingest as artifact (content_hash set); transition → awaiting-next-brief
      no matching reply → skip

    case worktree_error / orchestrator_loop / non_budget_loop / merged / closed_unmerged / cancelled:
      skip
```

### Observability

- **Events table:** every transition writes a row `(task_id, attempt_id, event_type, from_state, to_state, payload_ref, occurred_at)`. `payload_ref` points at the artifact (CI excerpt, blocker, review comments, conflict slice) that drove the transition. No large blobs in the events table itself.
- **Structured stdout:** `quay tick` emits one JSON line per task touched: `{task_id, action, took_ms, error?}`. Greppable. Pipeable to whatever log collector the deployment uses. No metrics endpoint. No tracing in v1.

### Transition chokepoint and side-effect ordering

The "single chokepoint" referenced in §4 invariant 7 guarantees **SQL atomicity** for state, attempts, artifacts, and events writes — they happen in one transaction. Side effects (tmux spawn/kill, GitHub API calls, Slack posts, worktree cleanup, file writes) are **not** part of that transaction. They follow explicit ordering rules and are eventually-consistent via tick recovery.

**Rules per side-effect class:**

- **Spawn (always `queued → running`; respawns transition through `queued` first):**

  Attempt rows have a two-phase lifecycle: **scheduled** (created when a respawn is queued; `spawned_at = NULL`, `tmux_session = NULL`) and **spawned** (filled in by tick at promotion). The "pending attempt" for a task in `queued` is the most recent attempt row with `spawned_at = NULL`.

  1. **Schedule** (at every respawn trigger — submit-brief, deterministic retry detection, review/conflict respawn): within one SQL transaction, insert `attempts` row with `spawned_at = NULL`, `tmux_session = NULL`, `consumed_budget` set per the reason, `template_id` and brief artifact written, transition `tasks.state = queued`. (Enqueue follows this exact pattern for attempt #1.)
  2. **Promote** (tick, when capacity allows): refresh the remote ref with `git -C <bare-clone> fetch origin <branch>` (handles the case where a prior attempt or external pusher advanced the remote). Read the remote SHA: `git -C <bare-clone> rev-parse origin/<branch>` if the ref exists; NULL otherwise (first attempt for a brand-new branch). Snapshot whether a PR currently exists for the branch via `gh pr view <branch>` (returns 0 → exists; non-zero / "no pull requests" → does not exist); store as `pr_existed_at_spawn` (1 or 0). On `gh` failure, log `tick_error` and skip promotion this tick (the PR-existence snapshot is required for correct progress detection). Within one SQL transaction, set `attempts.spawned_at = now()`, `attempts.remote_sha_at_spawn = <remote SHA or NULL>`, `attempts.pr_existed_at_spawn = <0|1>`, increment `tasks.attempts_consumed` iff `attempts.consumed_budget = 1`, update `tasks.state = running`, write `spawned` event.
  3. **Substrate work** (outside the transaction): write `.quay-prompt.md` to the worktree, create the tmux session, send the agent invocation.
  4. **Record session**: update `attempts.tmux_session` with the session name.

  - **Recovery — evidence-first, then spawn-failed rollback only as the no-evidence default.** If step 3 fails (tmux create error) or step 4 fails (DB unreachable after tmux started), the next tick observes a `running` attempt with `tmux_session = NULL`. The recovery is **NOT** an unconditional spawn-failed write — between step-3 success and step-4 commit, the worker may have started, run, pushed, opened a PR, or written a blocker. Recovery must classify that work before writing it off. The recovery sequence:
    1. **Kill any orphan tmux session** matching the canonical name `quay-task-<tmux_id>-<attempt_number>` (idempotent). The `tmux_id` is the per-task tmux identifier on `tasks.tmux_id` (see §13), so recovery has a deterministic name to match without reading the never-set `attempts.tmux_session`.
    2. **Collect the session log** at `<worktree>/.quay-session.log` (best-effort).
    3. **Run the dead-worker evidence classifier** — the same one used by the `running`-case dead-worker branch (per §5 tick pseudocode and §14 "Idempotent PR contract"):
       - If `.quay-blocked.md` is present and valid → ingest blocker, mark `exit_kind = 'blocker_written'`, transition → `awaiting-next-brief`. Budget is **preserved** at promotion's accounting (no decrement); a `blocker_resolved` respawn later will consume budget normally.
       - If `.quay-blocked.md` is present but malformed → persist `malformed_signal` artifact, mark `exit_kind = 'crashed'` (malformed sub-reason), schedule a deterministic `malformed_signal` retry, transition → `queued`. Budget is preserved at promotion's accounting; the `malformed_signal` retry consumes one unit at its own promotion (same rule as crash).
       - Else, fetch `remote_sha_at_exit`, read `pr_exists_at_exit` via `gh pr view`, and apply the canonical progress predicate (`pr_existed_at_spawn` recorded at promotion is the spawn-time PR existence). If a PR exists at exit and progress was made → `exit_kind = 'pr_opened'`, transition → `pr-open` (budget preserved at promotion's accounting; this is a healthy outcome).
       - Else if a PR exists but no progress this attempt → `exit_kind = 'no_progress'`, schedule deterministic `crash` retry, transition → `queued` (or budget-exhausted handling). Budget is preserved at promotion's accounting; the retry consumes one unit at its own promotion.
       - Else (no PR, no signal file) → continue to step 4 (the genuine substrate-failed default).
    4. **Substrate-failed default (no worker evidence).** Set `attempts.exit_kind = 'spawn_failed'`, `ended_at = now()`. **Roll back budget**: if `attempts.consumed_budget = 1`, decrement `tasks.attempts_consumed` by 1 to offset the increment from step 2. (Non-budget respawns are not decremented.) Increment `tasks.spawn_failures_consecutive`. If `spawn_failures_consecutive >= max_spawn_failures` (default 3), transition task to `worktree_error` (parked, manual recovery). Otherwise, insert a fresh scheduled `attempts` row with the same `reason`, `consumed_budget`, and brief content (clean retry of the same logical attempt), transition the task back to `queued`. The failed `spawn_failed` row is retained for forensics.
    - **Why budget is preserved on the evidence-found paths.** The whole point of the §5 budget rule is that a successful (or productive) spawn consumes one unit of budget at promotion time. If recovery finds that the worker actually started and did real work — opened a PR, advanced the remote, wrote a blocker — that's a productive (or at least observable) attempt, and budget accounting should match the equivalent dead-worker outcome. Only the genuine "tmux never came up, nothing happened" case rolls budget back, because there was no real attempt to charge for.
    - `spawn_failures_consecutive` resets to 0 on any successful spawn (i.e., the next attempt's worker actually starts logging) **and** on any evidence-found recovery outcome (since a worker provably started).

- **Kill (stale, wall-clock, cancel):** **SQL kill-intent write first, tmux kill second.**
  1. Within one SQL transaction: set `attempts.kill_intent = <'stale' | 'wall_clock' | 'cancel'>` on the running attempt. For `cancel`, the same transaction also persists the operator-supplied flags (`cancel_close_pr`, `cancel_keep_worktree`) on the task row — see "Cancel finalizer" below for why this matters. (No state transition yet — the task stays in `running` until the finalizer runs.)
  2. Outside: `tmux kill-session` (idempotent — missing session is OK).
  3. **Run the finalizer for the corresponding `kill_intent`:**
     - `stale` / `wall_clock` finalizer: collect the session log artifact (best-effort), mark `attempts.exit_kind = 'killed_stale'` or `'killed_wall_clock'`, clear `kill_intent`, schedule the deterministic retry (`reason = stale` or `wall_clock`), transition `tasks.state → queued` (or budget-exhausted handling).
     - `cancel`: kill-intent on the attempt only ensures the worker dies; terminal convergence is driven by the task-level `tasks.cancel_requested_at` recovery path described in "Cancel intent" / "Cancel finalizer" below.
  - **Recovery:** if step 2 fails, if the finalizer is interrupted by a crash, or if the process exits between steps:
    - For `stale` / `wall_clock`: the next tick sees `kill_intent` set on the running attempt with a live or dead handle. If alive: re-issue the kill. If dead: re-run the corresponding finalizer, ignoring the no-progress / no-PR / no-signal classifier ladder.
    - For `cancel`: the next tick's top-of-loop check observes `tasks.cancel_requested_at` and runs the cancel finalizer regardless of state. (The attempt-level `kill_intent = 'cancel'` is just an extra signal for the running-case kill; even if it's lost, the task-level field carries cancel intent forward.)
    The finalizers are idempotent on a task already in their target terminal state, so partial run + retry converges. This guarantees stale/wall-clock paths consume budget exactly once and cancel never accidentally respawns or leaves the task stuck in any non-terminal state.

- **Cancel intent (durable, task-level).** Cancellation is supported from many non-terminal states (`running`, `pr-open`, `done`, `awaiting-next-brief`, `claimed-by-orchestrator`, `waiting_human`, parked states). The recovery trigger therefore cannot live on the *attempt* row — most cancellable states have no live worker and no current `attempts.kill_intent` to inspect. Instead, cancellation uses a durable task-level field:

  - `tasks.cancel_requested_at TEXT` — UTC ISO-8601 timestamp; NULL until cancel is requested. Once set, never cleared (a `cancelled` task retains the timestamp for forensics).
  - `tasks.cancel_close_pr` and `tasks.cancel_keep_worktree` — operator flags persisted alongside the request, already in the schema.

  `attempts.kill_intent = 'cancel'` is retained but its role is narrowed: it is the **worker-kill mechanism for `running`** (so the running-case classifier in tick honors the kill instead of reclassifying), not the recovery driver. The recovery driver is `tasks.cancel_requested_at`.

- **Cancel finalizer (single canonical sequence).** Both `quay cancel` (synchronous path) and tick recovery (asynchronous, driven by `tasks.cancel_requested_at IS NOT NULL` on any non-terminal task) call this finalizer. There is exactly one implementation; both call sites use the same code path. The finalizer is **idempotent**: re-running on a task already in `cancelled` is a no-op success; running on any non-`cancelled` non-terminal state proceeds.

  Steps, in order:
  1. **Ensure no live worker.** If the task currently has an attempt with `tmux_session` set and `tmux has-session -t <session>` returns alive, issue `tmux kill-session -t <session>`. (Idempotent — missing session is OK; not-alive is OK.) For attempts where `tmux_session` is NULL (spawn-failure window), kill any session matching the canonical `quay-task-<tmux_id>-<attempt_number>` name. For tasks in states where no attempt is alive (`pr-open`, `done`, `awaiting-next-brief`, `claimed-by-orchestrator`, `waiting_human`, parked), this step is a no-op.
  2. **Collect the session log (best-effort).** Copy `<worktree>/.quay-session.log` into the artifact store as a `session_log` artifact, if the latest attempt has not already produced one. If the worktree is gone or the file is missing, log and continue.
  3. **Apply branch/worktree/PR cleanup per the §5 matrix** for the `cancelled` row, using the persisted `cancel_close_pr` / `cancel_keep_worktree` flags. With `cancel_close_pr = true`, also call `gh pr close` for any open PR before deleting the remote branch. Each substrate operation (worktree removal, branch delete, gh API call) is attempted under try/except — failures are logged but do **not** prevent the SQL terminal transition (consistent with §5 "best-effort" worktree cleanup).
  4. **Atomic SQL terminal transition (one transaction):** set `attempts.exit_kind = 'killed_cancel'` *and* `attempts.ended_at = now()` on the latest attempt only if its `ended_at IS NULL` (so a prior `pr_opened` exit_kind on a task in `done` is preserved as the historical exit and a *new* cancellation row is not synthesized — the task's terminal-event log records the cancellation via the `cancelled` event below); clear `attempts.kill_intent` if set; transition `tasks.state = 'cancelled'`; write `cancelled` event referencing the latest attempt. If the task was in `claimed-by-orchestrator`, `tasks.claim_id` and `tasks.claimed_at` are cleared as part of the same transaction (any stale claimant's subsequent calls fail with `cancelled` because `cancel_requested_at IS NOT NULL`). `tasks.cancel_requested_at` is **not** cleared — it is retained as the durable record of when cancel was requested.
  5. **Reset transient counters** that no longer apply: `tick_error`, `claim_expirations_consecutive`, `spawn_failures_consecutive`.

  **Idempotency contract:**
  - If invoked when `tasks.state = 'cancelled'` already: steps 1–3 are safe to re-run (`tmux kill-session` is idempotent; the session-log artifact is content-hash-deduped; cleanup operations are forgiving). Step 4's transition is a no-op (rowcount=0 on `WHERE state != 'cancelled'`). Return success.
  - If invoked when `tasks.state` is some other terminal state (`merged`, `closed_unmerged`): error with `wrong_state`, do not modify anything. The CLI translates this into `cancel: task is already terminal as <state>` for the operator.
  - Crash between any two steps: the next tick observes `tasks.cancel_requested_at IS NOT NULL` (durable) and re-enters at step 1, naturally idempotent through to step 4.

  **Tick check (canonical placement).** Before per-state handling, tick checks each non-terminal task: if `cancel_requested_at IS NOT NULL AND state != 'cancelled'`, run `cancel_finalizer(task)` and skip the per-state branch for this cycle. This applies uniformly to every non-terminal state — `running`, `pr-open`, `done`, `awaiting-next-brief`, `claimed-by-orchestrator`, `waiting_human`, `worktree_error`, `orchestrator_loop`, `non_budget_loop`. The `running`-case kill-intent branch still exists and still kills the worker (so the kill happens promptly inside the running-handler logic), but its primary job is now "kill the worker so this task can terminate"; the finalizer at the top of the tick takes responsibility for terminal convergence regardless of state.

  **Relationship to `attempts.kill_intent`:**
  - `quay cancel` on a `running` task writes both `tasks.cancel_requested_at` *and* `attempts.kill_intent = 'cancel'` on the running attempt, in the same SQL transaction. The kill-intent ensures the running-loop's classifier kills the worker; the task-level field is what drives terminal convergence on subsequent ticks.
  - `quay cancel` on any non-`running` cancellable state writes only `tasks.cancel_requested_at` (there is no live attempt). The finalizer's step 1 is a no-op; steps 2–5 still execute.

- **Human advice ownership.** `quay escalate-human` is a SQL/artifact boundary, not a Slack transport. It records the question as `slack_escalation_post`, mints `escalation_seq`/`escalation_nonce`, transitions the task to `waiting_human`, and preserves the live `claim_id`. The orchestrator owns Slack routing, fallback channels, posting, waiting for replies, and deciding the follow-up brief. After a human answers, the orchestrator calls `quay record-human-reply` to persist a `slack_reply` artifact and return the task to `claimed-by-orchestrator`, then calls `quay submit-brief --reason advice_answered`.

  Because human waits can legitimately exceed the normal claim timeout, tick does not auto-release claim-held `waiting_human` rows. Operational recovery is explicit: monitor claimed handoffs and `waiting_human` tasks, and if the owning orchestrator is known dead, use the handoff's `claim_id` with `quay task release-claim` to reopen the handoff for another orchestrator.

  Tick only handles legacy claimless `waiting_human` rows. If such a row has `slack_thread_ref`, tick may use the old Slack post/reply recovery loop. If it has no thread, tick requeues it to `awaiting-next-brief` with a durable `manual_resume` handoff so the orchestrator can apply deployment-owned fallback routing.

- **GitHub API reads (CI status, PR state, review decision, mergeable):** read-only, safe to retry. On failure, log `tick_error` and skip that task this cycle.

- **Worktree cleanup (terminal transitions):** best-effort. SQL state update first; worktree removal after. If removal fails (permissions, FS error), log and leave the worktree on disk. A future `quay cancel` or manual cleanup handles it. The task is terminal regardless of cleanup success.

**Invariant:** every side effect is either idempotent natively (tmux kill, GitHub reads, file delete) or guarded by a "did this already complete?" check on the next tick (spawn, Slack post, blocker ingestion). No side effect requires a partial-failure rollback.

### CI status rules

CI status is computed from the GitHub CLI / API per tick. Concrete data sources:

- `gh pr view <num> --json headRefOid` → returns the PR's current head SHA (`headRefOid`). Quay records this and refuses to act on stale check data: if the SHA changes between fetch and decision, Quay logs `tick_error` and retries on the next tick.
- `gh pr checks <num>` → returns checks against the latest commit as structured plain text. Quay reads the status column for normalized state: `pass` / `fail` / `pending` / `skipping`.
- `gh pr checks <num> --required` → filtered to required checks only. This is how Quay determines required-check status without touching the branch protection API while remaining compatible with gh versions that predate `pr checks --json`.

Determination rules:

- **All reported checks are authoritative for failure detection.** `repos.ci_workflow_name` is retained for compatibility but no longer filters the decision.
  - **fail** = any reported check has `bucket = fail` or `bucket = cancelled`, including non-required checks.
  - **pending** = any reported check has `bucket = pending` and none have `fail` / `cancelled`.
  - **pass** = all reported checks have `bucket = pass` or `bucket = skipping`.
  - **No reported checks at all** (empty `gh pr checks` rows): treated as **pass**. Documented no-CI behavior.
- **`gh` errors / unparseable check output / SHA changed mid-fetch:** treated as **pending**; log `tick_error`; retry next tick. Does not consume budget (no spawn happens, no transition fires).

Reviewer approval uses the same current-head CI gate before `pr-review -> done`;
an approved Quay-owned review cannot make the task durable `done` while the
current head has failing checks.

### Branch cleanup rules per terminal

"Branch" disambiguation: throughout the spec, **local branch** means the ref inside the bare clone at `~/.quay/repos/<repo_id>.git`; **remote branch** means the ref on the upstream GitHub repo.

| Terminal | Local branch | Remote branch | Worktree |
|---|---|---|---|
| `merged` | Delete (`git -C <bare> branch -D <branch>`). | Usually auto-deleted by GitHub on merge if "delete branch on merge" is configured; Quay does NOT explicitly delete it (`merged` PRs already represent a clean handoff). | Remove. |
| `closed_unmerged` | Delete. | Delete (`git -C <bare> push origin --delete <branch>`). The human chose to discard the work. | Remove. |
| `cancelled` (default) | Delete. | **Retain IF a PR is currently open** for the branch (preserves the human's option to take over the work). Otherwise delete. | Remove. |
| `cancelled --close-pr` | Delete. | Delete. The operator explicitly asked to close everything. | Remove. |
| `cancelled --keep-worktree` | Same as `cancelled` for branches. | Same as `cancelled`. | **Retain** for inspection. |
| `worktree_error` / `orchestrator_loop` / `non_budget_loop` | None. Parked for human inspection. | None. | Retain. |

When human cancels via `quay cancel` and one of the parked states applies, the cancel command applies the `cancelled` rules above (overriding the parked retention).

### Tick duration budget

A tick is expected to comfortably finish in well under the cron cadence (default 5 min). If a tick legitimately runs long (slow GitHub API, large CI log fetch), the supervisor lockfile prevents overlap with the next fire (which exits immediately) and also prevents `quay cancel` from running until the long tick completes (cancel blocks on the same lock). Operators who observe long ticks should investigate the underlying slowness rather than relying on the lock-stale-takeover path.

---

## 6. Worker contract

### Prompt structure

The worker receives a single non-interactive prompt composed of two layers:

1. **Protocol preamble** (Quay-owned, versioned, stable across all spawns).
2. **Brief** (orchestrator-supplied, task-specific).

The CLI concatenates `preamble + "\n\n" + brief` and writes the result to the worktree as `.quay-prompt.md`. The tmux spawn helper invokes the coding agent with that file as the prompt source.

### Protocol preamble (canonical, v1)

The preamble tells the worker **eight things and nothing else**:

1. **Blocker contract.** If you cannot make progress, write `.quay-blocked.md` containing prose explaining what happened, then exit cleanly.
2. **Exit expectations.** Exit when (a) you've opened a PR, (b) you've written a blocker file, or (c) you've decided you cannot complete the task. Do not loop indefinitely. Do not sleep waiting for input — there is no input channel.
3. **Workspace boundary.** Work inside `<worktree path>`. `.quay-*` files are reserved for orchestrator ↔ worker communication, with two exceptions: you may **write** `.quay-blocked.md` (per rule 1), and you may **read but not modify** `.quay-prompt.md` (your own input). Do not touch any other `.quay-*` file. Do not push to branches other than the one you are on.
4. **PR contract (idempotent).** When done, push the branch. Then check whether a PR already exists for this branch (e.g. `gh pr list --head <branch_name>`). If none exists, open one via `gh pr create` against `<base branch>` and include the ticket reference in the title or body. **If a PR already exists, do NOT create a duplicate — your push has already updated it.** Exit after the push (and PR creation, if applicable).
5. **Repo conventions pointer.** Follow the repo's contribution guide at `<contribution_guide_path>` if present.
6. **No interactive prompts.** Do not call any tool requiring interactive input (no editor opens, no `gh auth login`, no shell `read`).
7. **Tooling environment.** Dependencies are already installed by Quay. Do not re-run install commands.
8. **Guess-questions go to blocker.** If you would normally ask a clarifying question, write that question into `.quay-blocked.md` and exit. Do not guess.

### What the preamble explicitly does not contain

- The original brief, the ticket text, or any task-specific facts. Those live in the brief.
- Repo-specific commands (build, test). Those live in the brief or are invoked by the orchestrator.
- Retry-attempt awareness. The worker always behaves as if this is its only shot. Retry context, when applicable, is folded into the brief by the orchestrator.
- Information about budgets, attempts, statuses, or capacity. The worker has no concept of these.

### Preamble versioning

The preamble is stored in SQL in a `preambles` table. A change is a new row, append-only. Each attempt records the `preamble_id` it ran under. The versioning scheme (auto-increment, hash, timestamp) is an implementation detail.

### Signal file: `.quay-blocked.md`

- **Filename is fixed.** No per-attempt suffix. At most one blocker file exists in the worktree at any time, representing the current attempt's unconsumed blocker.
- **Single reason: `retry`.** Implicit — the file's existence means the worker is blocked. No reason vocabulary, no classification by the worker. The worker writes prose; the orchestrator reads it and decides what to do.
- **Validation rules** (referenced as "valid blocker" by §5 pseudocode). A `.quay-blocked.md` is **valid** iff all of the following hold:
  1. The file is readable (no FS error).
  2. The bytes decode as UTF-8 (no replacement character substitution; strict decode).
  3. After Unicode whitespace trim, the body is non-empty.
  4. File size on disk is ≤ `64 KiB` (65,536 bytes). Larger files are treated as malformed.
  Anything that fails any of these rules is **malformed**. Malformed files are persisted as a `malformed_signal` artifact (raw bytes, capped at 64 KiB so the artifact store is never blown up by a runaway file) and routed through the deterministic-retry path with template `malformed_signal` (consumes budget, same as crash). The malformed file is then deleted from the worktree as part of the same crash-safe ingestion sequence (artifact write → SQL commit → file delete).
- **Routing decision lives in the orchestrator.** When tick ingests a blocker, it transitions the task to `awaiting-next-brief`. The orchestrator picks it up via its own pull loop, claims the task, then either composes a new brief and submits it via `quay submit-brief` (consumes retry budget), or calls `quay escalate-human` to transition to `waiting_human` (does not consume budget), or calls `quay cancel` to fail the task.
- **Unknown / malformed signal file → treated as a deterministic retry trigger** (template `malformed_signal`), not as a worker blocker. There's no readable prose for the orchestrator to consume, so Quay composes the retry brief itself. Budget is consumed on the resulting respawn (same rule as crash/stale/wall-clock).

### PR contract

- The worker pushes its branch and opens a PR via `gh pr create` against the repo's configured `base_branch`.
- Quay does not approve, merge, or close PRs autonomously. The PR's terminal state (merged, closed-unmerged) is decided externally by humans.
- Force-push and rebase on the PR branch are supported — the next tick's CI poll picks up the most recent run.

---

## 7. Retry, escalation, and brief composition

### Retry paths

| Path | Trigger | Brief composition | Budget |
|---|---|---|---|
| **Deterministic failure** | CI fail, crash (dead worker, no PR, no signal), staleness (live worker, stale log), wall-clock cap exceeded, malformed signal file | Template + observed context (CI excerpt / "died without PR" / staleness diagnostics / "wall-clock exceeded" diagnostics / malformed-file content) + most-recent brief. **Quay-side.** | Consumes |
| **Worker blocker** | Worker writes `.quay-blocked.md` | Tick ingests; transitions to `awaiting-next-brief`. Orchestrator pulls, claims, reads prose, returns new brief via `quay submit-brief`. | Consumes at tick promotion of the resulting `blocker_resolved` attempt (per the canonical rule: budget is consumed when `queued → running` runs, never at trigger time or at `submit-brief`) |
| **Human-required** | Orchestrator decides the blocker needs a human (calls Quay to record the question and transition to `waiting_human`) | Orchestrator posts/waits in Slack, records the answer through `record-human-reply`, then submits the next brief via `submit-brief --reason advice_answered`. | Does NOT consume |
| **Review feedback** | `gh pr view` reports `reviewDecision = CHANGES_REQUESTED` | Template + review comments + most-recent brief. **Quay-side, deterministic.** | Does NOT consume |
| **Merge conflict** | `gh pr view` reports `mergeable: CONFLICTING` (in `pr-open` or `done`) | Template + conflict slice (mergeable status, conflicting files) + most-recent brief. **Quay-side, deterministic.** | Does NOT consume |
| **Budget pause** | (Reserved.) Daily or per-task cap engine. Not exercised in v1. | Unchanged from what would compose anyway. | Orthogonal |

### Common mechanics

- **Worktree persists across retries.** Respawn = new tmux session against the same worktree. Branch persists. Prior commits, uncommitted changes, installed deps — all preserved.
- **All transitions go through the chokepoint** — no path writes state directly.
- **"Most-recent brief" semantics:** Quay's deterministic retry briefs wrap the most recent brief used to spawn a worker — including any orchestrator-composed briefs from prior `submit-brief` calls. Each new retry layers on top of the previous brief, not on the initial enqueue brief. The chain accumulates context implicitly through nesting.
- **Retry templates live in SQL** in a `retry_templates` table, append-only and versioned (same model as `preambles`). One template per `kind` (`ci_fail`, `crash`, `stale`, `wall_clock`, `malformed_signal`, `review`, `conflict`). Each attempt records the `template_id` it used.
- **Non-budget respawn dedup.** Review feedback and merge conflict respawns don't consume budget, but they must not loop on the same observation. Quay records what it last acted on per task:
  - `last_review_id_acted_on` — the most recent review id Quay respawned against. Tick only triggers a `review` respawn if `gh pr view` reports a *newer* review id. Stale CHANGES_REQUESTED on a SHA Quay already addressed does not re-trigger.
  - `last_conflict_observation` — encodes the `(head_sha, base_sha)` pair Quay last respawned against. Tick only triggers a `conflict` respawn if either has advanced. Polling the same conflict over and over does not re-trigger.
  - `advice_answered` is orchestrator-owned: each recorded human answer leads to one follow-up brief submission under the same claim.
- **Non-budget safety cap.** A separate counter `non_budget_respawns_consumed` (default cap `max_non_budget_respawns = 20`) catches cases the dedupe keys miss. If exceeded, task transitions to `non_budget_loop` (parked, manual recovery via `quay cancel`).
- **Retry budget rules:**
  - Consumed by deterministic failures (CI fail, crash, staleness, wall-clock) and worker-written blockers handed back to the orchestrator.
  - Not consumed by review feedback, merge conflicts, or human-required escalation.
  - Default cap: **5 attempts per task.** Configurable per deployment.
  - Exhausted budget → Quay does not respawn. Sets `task.budget_exhausted = true`, transitions to `awaiting-next-brief`, persists the would-be retry brief as a `last_failure` artifact. Orchestrator pulls, sees the flag, decides to escalate-human or cancel.

### Brief composition responsibility split

| Path | Composer |
|---|---|
| Deterministic failure | Quay (template) |
| Worker blocker | Orchestrator (prose-aware, may research) |
| Human-required | Orchestrator asks the human, records the answer in Quay, and folds it into the next brief |
| Review feedback | Quay (template) |
| Merge conflict | Quay (template) |

Quay-composed briefs are deterministic templates. Orchestrator-composed briefs may involve reasoning and research. The worker cannot tell the difference — it just reads a brief.

---

## 8. Artifact store

### Boundary rule

Snapshot anything that crosses a task boundary. Internal-to-one-actor work is not stored.

### Artifact kinds

| Kind | Captured when | Source | Storage |
|---|---|---|---|
| `ticket_snapshot` | Enqueue | Orchestrator passes the ticket body as fetched at enqueue time. Task-level (no `attempt_id`). | File in artifact dir |
| `brief` | One per attempt, written when the attempt row is created | Orchestrator-composed for `attempts.reason ∈ {initial, blocker_resolved, advice_answered}`; Quay-composed (deterministic template) for `attempts.reason ∈ {ci_fail, crash, stale, wall_clock, malformed_signal, review, conflict}`. The `attempts.reason` column tells you which composer. | File |
| _(preamble)_ | _Not in `artifacts`._ Preambles live in their own `preambles` SQL table and are referenced via `attempts.preamble_id`. Listed here for completeness only — preamble persistence and lookup do not go through the artifact store. | — | — (SQL only) |
| `final_prompt` | One per attempt, written when the attempt row is created | Quay concatenates `preamble + "\n\n" + brief`. | File |
| `blocker` | Worker writes `.quay-blocked.md` | Worker | File (after ingest, the worktree copy is deleted) |
| `session_log` | Worker exits (clean or killed) | tmux pane pipe | File |
| `ci_failure_excerpt` | Tick observes CI fail | `gh run view --log-failed` at moment of detection | File |
| `review_comments` | Tick observes `CHANGES_REQUESTED` | `gh pr view` review comment thread at moment of detection | File |
| `conflict_slice` | Tick observes `mergeable: CONFLICTING` | `gh pr view` mergeable status + file list at moment of detection | File |
| `slack_escalation_post` | Orchestrator asks for human advice | Question body + optional thread metadata | File |
| `slack_reply` | Orchestrator records a human answer, or legacy tick ingests a non-bot reply | Slack reply body + author + ts | File |
| `last_failure` | Retry budget exhausted | Captured at any transition into `awaiting-next-brief` where `attempts_consumed >= retry_budget`. Contents depend on path: for deterministic-retry exhaustion (CI fail / crash / stale / wall-clock / malformed-signal) → the retry brief Quay would have spawned with (template + diagnostics + most-recent brief). For worker-blocker exhaustion (final-attempt blocker) → the blocker prose + a note that no respawn was attempted + a reference to the most-recent brief. Either way, gives the orchestrator everything it needs to decide between `escalate-human` and `cancel`. | File |
| `malformed_signal` | Tick observes `.quay-blocked.md` that fails validation (empty / unreadable / unparseable) | Raw bytes of the rejected file, captured for forensics before deletion. | File |
| `usage` | Worker exits (clean or killed) and `<worktree>/.quay-usage.json` exists | Spawn wrapper redirects the agent's `--output-format json` (claude — equivalent flags for Codex / Cursor / etc.) to `.quay-usage.json`. Captured verbatim as the JSON envelope; downstream consumers parse `input_tokens`, `output_tokens`, `total_cost_usd`, `duration_ms`, model id, etc. NULL-output rows (worker killed before write, malformed JSON, agent that doesn't emit a structured envelope) simply have no `usage` artifact — the row's absence is the signal. | File |
| `tool_trace` | Worker exits (clean or killed) and `<worktree>/.quay-tool-trace.log` exists | Spawn wrapper passes `--debug --debug-file .quay-tool-trace.log` (claude — equivalent debug-output flags for other runtimes). The file streams tool-dispatch events (`tool_dispatch_start tool=Bash`, `tool_dispatch_end tool=Write outcome=ok`, `[API:request] ...`) as the worker runs, so even a killed-mid-run attempt typically produces a useful trace. Captured verbatim; v1 is bytes (parsing is claude-internal and may shift). Tail-read past 4 MiB so a runaway worker can't bloat the artifact store. | File |

### What is NOT an artifact

- Orchestrator's internal tool calls (QMD queries, code searches, learnings retrieval, reasoning).
- Quay's internal polling loops, tick branching logic, SQL queries.
- Worker's individual tool calls inside its session (the aggregated session log is the artifact, not the slices).

### PR (special case)

- **Pointer in SQL:** `pr_number`, `pr_url`, `head_sha`, `base_sha`, `branch_name`. Persists through terminal.
- **Observed slices stored:** CI excerpts at fail time, review comments at `CHANGES_REQUESTED` time, conflict slices at conflict time. Not full PR snapshots.
- **The PR itself is retrievable on demand** via `gh pr view <pr_number>` as long as the repo exists. No reason to duplicate GitHub's source of truth.

### Storage layout

- **SQL row per artifact:** `(artifact_id, task_id, attempt_id, kind, file_path, captured_at)`.
- **Files in a persistent per-task directory:** `~/.quay/artifacts/<task_id>/<attempt_id>/<kind>-<seq>.<ext>` (or similar — exact path scheme is implementation detail; the SQL row is canonical).
- **Independent of the worktree.** Worktree is ephemeral; the artifact directory survives `cleanup`.

---

## 9. Persistence layer

### SQL schema (sketch)

```sql
-- Persistent per-deployment configuration
CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  package_manager TEXT NOT NULL,
  install_cmd TEXT NOT NULL,
  test_cmd TEXT,
  ci_workflow_name TEXT,
  contribution_guide_path TEXT,
  archived_at TEXT,                   -- soft-delete marker. Set by `quay repo remove`. Tasks already in terminal states are preserved (their repo_id remains valid). New enqueues are rejected.
  created_at TEXT NOT NULL
);

-- Append-only versioning of the protocol preamble
CREATE TABLE preambles (
  preamble_id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Append-only versioning of Quay's deterministic retry brief templates
CREATE TABLE retry_templates (
  template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- ci_fail / crash / stale / wall_clock / malformed_signal / review / conflict
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per task
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  external_ref TEXT,                  -- e.g. "ITRY-900"; opaque to Quay
  state TEXT NOT NULL,                -- queued / running / pr-open / done / ...
  branch_name TEXT NOT NULL,
  tmux_id TEXT NOT NULL,              -- per-task tmux identifier derived from external_ref via the §13 tmux-id rules. Combined with attempt_number to form `quay-task-<tmux_id>-<n>` session names. Stored at enqueue so spawn-failure recovery has a deterministic kill target.
  worktree_path TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  base_sha TEXT,
  attempts_consumed INTEGER NOT NULL DEFAULT 0,
  retry_budget INTEGER NOT NULL,      -- copied from config at enqueue
  budget_exhausted INTEGER NOT NULL DEFAULT 0,  -- 0/1 flag
  tick_error TEXT,                    -- transient; cleared on next successful tick
  slack_thread_ref TEXT,              -- optional channel + ts metadata for human escalation; may be NULL when the orchestrator uses fallback routing outside Quay.
  claimed_at TEXT,                    -- set on quay task claim; cleared on submit-brief / release-claim / claim timeout / terminal transition.
  claim_id TEXT,                      -- opaque ownership token (UUID v4) returned by `quay task claim` and required by every subsequent claim-scoped write. Set atomically on each successful claim; preserved across orchestrator-owned waiting_human; cleared whenever the claim ends (release-claim, submit-brief, claim timeout, or terminal transition). A new claim mints a fresh value, fencing out any stale claimant whose previous claim was timed out and re-claimed by someone else.
  claim_expirations_consecutive INTEGER NOT NULL DEFAULT 0,  -- reset on successful submit-brief or escalate-human
  last_review_id_acted_on TEXT,       -- dedupe key for review-feedback respawns
  last_conflict_observation TEXT,     -- dedupe key for merge-conflict respawns; format "head_sha:base_sha"
  non_budget_respawns_consumed INTEGER NOT NULL DEFAULT 0,
  next_escalation_seq INTEGER NOT NULL DEFAULT 1,  -- monotonic; minted (and incremented) when `escalate-human` records a question, alongside the per-escalation nonce. Distinguishes a legitimate second escalation from a recovery-path retry.
  cancel_requested_at TEXT,                        -- UTC ISO-8601; NULL until cancel is requested. Set by `quay cancel` *before* any cleanup. The durable, task-level recovery trigger for the cancel finalizer — works for cancel from any non-terminal state (running, pr-open, done, awaiting-next-brief, claimed-by-orchestrator, waiting_human, parked). Once set, retained for forensics even after the task terminates as `cancelled`.
  cancel_close_pr INTEGER NOT NULL DEFAULT 0,      -- 0/1; persisted by `quay cancel` so the cancel finalizer (whether run synchronously or via tick recovery) honors the operator's --close-pr choice.
  cancel_keep_worktree INTEGER NOT NULL DEFAULT 0, -- 0/1; persisted by `quay cancel` so the cancel finalizer honors --keep-worktree across crash-recovery.
  spawn_failures_consecutive INTEGER NOT NULL DEFAULT 0,  -- reset on any successful spawn
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per attempt (scheduled + spawned phases share a single row)
CREATE TABLE attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_number INTEGER NOT NULL,    -- 1, 2, 3, ...
  preamble_id INTEGER NOT NULL REFERENCES preambles(preamble_id),
  template_id INTEGER REFERENCES retry_templates(template_id),  -- NULL for orchestrator-composed briefs
  reason TEXT NOT NULL,               -- initial / ci_fail / blocker_resolved / review / conflict / stale / crash / wall_clock / malformed_signal / advice_answered
  consumed_budget INTEGER NOT NULL,   -- 0 or 1; whether promoting this attempt to running consumes one unit of retry_budget
  tmux_session TEXT,                  -- e.g. "quay-task-ITRY-900-a3f2c8b1-3" (tmux_id always ends in -<task_id_short> for cross-task uniqueness; see §13); NULL while attempt is scheduled but not yet spawned
  spawned_at TEXT,                    -- NULL while scheduled; set by tick at queued → running promotion
  remote_sha_at_spawn TEXT,           -- SHA of origin/<branch> at promotion time (after a fresh git fetch). NULL if remote branch did not yet exist.
  remote_sha_at_exit TEXT,            -- SHA of origin/<branch> at observed-dead time (after fresh git fetch). NULL if remote branch still does not exist.
                                      -- "Progress" = remote_sha_at_exit advanced beyond remote_sha_at_spawn (or remote went from NULL to a SHA, i.e., first push)
                                      -- OR (NOT pr_existed_at_spawn AND a PR exists at exit) — opening the PR itself counts as progress.
                                      -- Local HEAD is NOT used: a worker that committed locally without pushing did not advance the PR.
  pr_existed_at_spawn INTEGER NOT NULL DEFAULT 0,  -- 0/1; whether a PR (open or closed/merged) existed for this branch at promotion time. Used together with the post-exit PR check to detect "PR was created during this attempt" without further remote-SHA churn.
  ended_at TEXT,
  exit_kind TEXT,                     -- pr_opened / blocker_written / killed_stale / killed_wall_clock / killed_cancel / crashed / clean_no_pr / spawn_failed / no_progress
  kill_intent TEXT,                   -- NULL while the worker is supposed to keep running. Set inside the SQL chokepoint *before* the tmux kill for any ordered-kill path: 'stale' / 'wall_clock' / 'cancel'. Read by the next tick: if the worker is dead and kill_intent is set, complete the originally-scheduled transition (deterministic retry for stale/wall_clock; cancellation cleanup for cancel) instead of running the dead-worker classifier. Cleared on the resulting transition.
  agent_identity TEXT,                -- "<runtime>/<runtime_version>/<model_id>", e.g. "claude/2.1.132/unknown". Captured at spawn time by probing the agent binary's `--version`. NULL on rows that pre-date the slice; populated for every successful spawn thereafter. Lets retro analysis slice attempts by which agent runtime executed them (preamble v2 vs v1 on the same model, opus vs sonnet cost/quality tradeoff, etc.).
  exit_code INTEGER,                  -- OS-level exit code (0–255) when the worker pane exited without a signal. NULL when the process was signaled, when the row pre-dates this slice, when no real process ever ran (spawn_failed), or when the worker shell was itself killed before its post-block could record `$?` (e.g. tick's wall_clock kill, cancel finalizer kill). Quay's `exit_kind` is the classification; this is the raw substrate observation.
  exit_signal TEXT,                   -- Canonical signal name (e.g. "SIGINT", "SIGKILL", "SIGPIPE") when the worker pane was terminated by signal; NULL otherwise. Same NULL semantics as `exit_code`. Captured by wrapping the agent invocation in `<agent>; printf '%d' "$?" > .quay-exit-code` and decoding the 128+N shell convention — works on every tmux version (tmux's `#{pane_dead_status}` / `#{pane_dead_signo}` formatters are unreliable for signaled exits on tmux 3.6a / macOS).
  diff_summary TEXT                   -- JSON: lines-changed metadata between `remote_sha_at_spawn` and `remote_sha_at_exit` (`{files_changed, insertions, deletions, files: [{path, status, ins, del}]}`). Computed once on the `pr_opened` transition via `git diff --no-renames --numstat` + `--name-status` against the bare clone. NULL on rows pre-dating this slice, on attempts that never reached `pr_opened`, on attempts whose remote SHA didn't change (no diff to capture), and on best-effort capture failures (also recorded as a `tick_error` event with `event_data.capture = 'diff_summary'`).
);

-- Append-only artifact store pointer
CREATE TABLE artifacts (
  artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id INTEGER REFERENCES attempts(attempt_id),
  kind TEXT NOT NULL,                 -- ticket_snapshot / brief / final_prompt / blocker / session_log / ci_failure_excerpt / review_comments / conflict_slice / slack_escalation_post / slack_reply / last_failure / malformed_signal / usage / tool_trace
  file_path TEXT NOT NULL,
  content_hash TEXT,                  -- used for crash-safe ingestion idempotency (set on blocker / slack_reply / malformed_signal / slack_escalation_post). For slack_escalation_post the hash covers (question_body || escalation_seq || escalation_nonce) so a fresh escalation cannot dedupe against a prior one.
  escalation_seq INTEGER,             -- only set on slack_escalation_post artifacts; copied from tasks.next_escalation_seq when the question is recorded.
  escalation_nonce TEXT,              -- only set on slack_escalation_post artifacts; opaque per-escalation identifier. Legacy tick Slack recovery embeds it in the Slack post body.
  slack_pre_post_fence_ts TEXT,       -- legacy tick-owned Slack path only.
  slack_post_ts TEXT,                 -- legacy tick-owned Slack path only.
  slack_recovered_post_ts TEXT,       -- legacy tick-owned Slack path only.
  captured_at TEXT NOT NULL
);

-- Append-only transition log
CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id INTEGER REFERENCES attempts(attempt_id),
  event_type TEXT NOT NULL,           -- spawned / pr_opened / ci_failed / ci_passed / merged / closed / changes_requested / conflict / blocker_ingested / malformed_signal_ingested / no_progress / crashed / spawn_failed / stale_detected / stale_killed / wall_clock_exceeded / wall_clock_killed / slack_reply_ingested / claimed / claim_expired / orchestrator_loop_parked / non_budget_loop_parked / brief_submitted / human_escalated / budget_exhausted / cancelled / worktree_error / tick_error
  from_state TEXT,
  to_state TEXT,
  payload_artifact_id INTEGER REFERENCES artifacts(artifact_id),
  occurred_at TEXT NOT NULL,
  event_data TEXT                     -- nullable JSON; per-event-type "why" payload (no schema enforced). NULL on rows pre-dating the slice and on event types this slice doesn't populate. See "Event data convention" below for examples.
);
```

#### Event data convention

`events.event_data` is a per-event-type JSON document carrying the
context the `(event_type, from_state, to_state)` triple can't express.
Schema is convention-only in v1. Examples for the event types
populated today:

```jsonc
// crashed / no_progress (classifier dead-worker path)
{
  "exit_code": 137,                  // null when signaled
  "exit_signal": "SIGKILL",          // null when normal exit
  "remote_unchanged": true,          // remote_sha_at_exit matched spawn-time SHA (or both NULL)
  "pr_existed_at_spawn": false,
  "pr_exists_at_exit": false
}

// blocker_ingested (classifier valid-blocker path)
{
  "exit_code": 0,
  "exit_signal": null,
  "blocker_bytes": 423,              // size of the ingested .quay-blocked.md
  "blocker_content_hash": "abc..."   // sha256 of the blocker bytes
}

// wall_clock_exceeded / stale_detected (kill-intent commit)
{
  "intent": "wall_clock",            // or "stale"
  "spawned_seconds_ago": 3601,
  "last_log_at": "2026-05-10T14:00:00.000Z"   // stale_detected only
}
```

Adding new keys to an existing event type is backwards-compatible
(consumers parse-or-default). Rename or remove a key only behind a
deliberate migration of consumers.

### Schema constraints and transaction predicates

The schema sketch above is the canonical column list. The constraints below are required for the spec's invariants to hold and must be enforced via DB constraints, indexes, or transaction predicates (not application-only checks).

**Constraints:**

- `UNIQUE(task_id, attempt_number)` on `attempts` — attempt numbers are dense and unique per task.
- **Recovery-path artifact idempotency.** Crash-safe ingestion uses content_hash to detect "already ingested." Recovery-path artifact kinds (`blocker`, `slack_reply`, `malformed_signal`, `slack_escalation_post`, future similar) MUST always be linked to a specific attempt and MUST set `content_hash`. Encoded as a **partial unique index**: `CREATE UNIQUE INDEX artifact_recovery_idempotency ON artifacts(task_id, attempt_id, kind, content_hash) WHERE content_hash IS NOT NULL AND attempt_id IS NOT NULL`. The dual-NOT-NULL predicate matters because SQLite (and ANSI SQL) treats NULL as distinct from NULL inside UNIQUE — without the predicate, two recovery-path rows with `attempt_id = NULL` would both pass the constraint and silently duplicate. `slack_escalation_post` is included so step 3 of the Slack post recovery (§5) is idempotent on retry: re-running the SQL transaction with the same body hash collides on the index and reuses the existing row. **Per-escalation, not per-question:** the hash for `slack_escalation_post` is computed over `(question_body || escalation_seq || escalation_nonce)`, where `escalation_seq` is minted (and `tasks.next_escalation_seq` incremented) inside the step-1 SQL transaction and `escalation_nonce` is generated alongside it. So a recovery retry of the *same* escalation produces the same hash and reuses the same row, but a *new* `escalate-human` call against the same attempt mints a fresh seq + fresh nonce, hashes to a different value, and writes a new row — preventing silent dedupe of legitimate re-escalations (e.g. after a Slack reply was ingested and the orchestrator escalates again on the same attempt). Non-recovery kinds (`brief`, `final_prompt`, `ticket_snapshot`, `last_failure`, `session_log`, `ci_failure_excerpt`, `review_comments`, `conflict_slice`) don't set content_hash and don't participate in the index. The only task-level kind (no attempt_id) is `ticket_snapshot`, which is captured exactly once at enqueue and doesn't need idempotency.
- **At most one pending attempt per task:** enforce via partial unique index `CREATE UNIQUE INDEX one_pending_attempt_per_task ON attempts(task_id) WHERE spawned_at IS NULL`. Scheduling a new attempt while one is already pending is a programmer error; the index makes it a hard failure.
- `CHECK(consumed_budget IN (0, 1))` on `attempts`.
- `CHECK(budget_exhausted IN (0, 1))` on `tasks`.
- `FOREIGN KEY` clauses as listed in the schema (reject orphan attempts, artifacts, events).

**Transaction predicates (write commands must use these `WHERE` clauses):**

- **`quay task claim <id>`:** mints a fresh `claim_id` (UUID v4) and writes it atomically with the state transition. `UPDATE tasks SET state = 'claimed-by-orchestrator', claimed_at = now(), claim_id = <new_uuid> WHERE task_id = ? AND state = 'awaiting-next-brief' AND cancel_requested_at IS NULL`. The atomic claim depends on this `WHERE` predicate — concurrent claims arbitrate at the DB level. If `rowcount = 0`, the claim failed (someone else got there, the task isn't in the right state, or the task has been cancelled). On `rowcount = 1`, the CLI returns `{"task_id": "...", "claim_id": "<uuid>"}` on stdout. The orchestrator stores the `claim_id` and passes it back on every subsequent claim-scoped write.
- **`quay task release-claim <id> --claim-id <claim_id>`:** atomic and ownership-fenced. Implemented as a two-step transaction (or equivalent CTE):
  1. `SELECT state, claim_id FROM tasks WHERE task_id = ?`. If no row → error `unknown_task`.
  2. Branch on the observed `state`:
     - `claimed-by-orchestrator` AND DB `claim_id` matches the supplied one → `UPDATE tasks SET state = 'awaiting-next-brief', claimed_at = NULL, claim_id = NULL WHERE task_id = ? AND state = 'claimed-by-orchestrator' AND claim_id = ?`. `rowcount = 1` expected.
     - `claimed-by-orchestrator` but DB `claim_id` differs → error `claim_lost` (the prior claim was timed out and re-claimed by someone else; the caller is operating on a stale claim_id). Do not modify state.
     - `awaiting-next-brief` → idempotent no-op success (the canonical "already released" case; the supplied `claim_id` is not validated since there's no live claim to fence — release of an already-released task is benign).
     - any other state → error `wrong_state` with the observed state in the payload. Do not silently succeed.
  - `rowcount = 0` is no longer overloaded as "success." Each of "unknown task," "already released," "claim lost," and "wrong state" returns a distinct outcome.
- **`quay submit-brief <id> --claim-id <claim_id>` / `quay escalate-human <id> --claim-id <claim_id>`:** must include the full ownership-fence predicate on the task update: `WHERE task_id = ? AND state = 'claimed-by-orchestrator' AND claim_id = ? AND cancel_requested_at IS NULL`. The `claim_id` clause fences out a stale claimant whose claim was timed out and re-issued. The `cancel_requested_at IS NULL` clause fences out cancellation in flight. On `rowcount = 0`, return a structured error: `claim_lost` if the row exists with a different `claim_id` or is in `awaiting-next-brief` (the orchestrator's claim was auto-released by tick); `cancelled` if `cancel_requested_at IS NOT NULL`; `wrong_state` otherwise (e.g., the task moved through to a terminal). Treat each distinctly so the orchestrator can recover correctly (re-claim vs. abandon). On success, both commands clear `claim_id` (the orchestrator's responsibility for this task ends with the action) and reset `claim_expirations_consecutive` to 0.
- **Tick promotion `queued → running`:** must include `WHERE state = 'queued' AND cancel_requested_at IS NULL`; the increment of `attempts_consumed` (when `consumed_budget = 1`) and the `attempts.spawned_at` set happen in the same transaction. On rowcount=0 (cancel slipped in between read and write), tick aborts substrate spawn for this task this cycle and continues; the next tick's top-of-loop cancel check runs the finalizer.
- **Spawn-failure rollback:** `attempts_consumed` decrement happens atomically with the `attempts.exit_kind = 'spawn_failed'` write and the fresh scheduled-attempt insert. All in one transaction. Predicate: `WHERE task_id = ? AND cancel_requested_at IS NULL`. On rowcount=0, the cancel finalizer will pick up the partially-spawned attempt on the next tick (orphaned tmux session is killed by the finalizer's step 1).
- **All other tick-owned mutating writes** must include `AND cancel_requested_at IS NULL` in their `WHERE` clause:
  - Dead-worker classifier transitions (`running → pr-open`, `running → queued` for retry, `running → awaiting-next-brief` for blocker, etc.).
  - `pr-open` PR-state transitions (`pr-open → merged`, `pr-open → closed_unmerged`, `pr-open → done`).
  - `done` PR-state transitions (`done → merged`, `done → closed_unmerged`).
  - Non-budget respawn scheduling (`pr-open` / `done` → `queued` for review/conflict).
  - Claim auto-release (`claimed-by-orchestrator → awaiting-next-brief` on timeout).
  - `waiting_human` reply ingestion (`waiting_human → awaiting-next-brief`).
  - `waiting_human` Slack post-recovery writes (fence capture, `slack_post_ts`/`slack_recovered_post_ts` updates).
  Each follows the same rule: rowcount=0 → log `tick_error`, abort this task this cycle, continue.

**Indexes (for tick performance):**

- `INDEX(state)` on `tasks` — tick iterates by state.
- `INDEX(task_id, occurred_at)` on `events` — `quay task events` query path.
- `INDEX(task_id, kind, attempt_id)` on `artifacts` — `quay artifact get` query path.

### Filesystem layout

```
~/.quay/
  quay.db                           # SQLite (or equivalent) — single file
  tick.lock                         # process lockfile for tick concurrency control
  repos/
    <repo_id>.git/                  # bare clone per repo; persistent, refreshed via git fetch
  worktrees/
    <task_id>/                      # ephemeral; cleaned on terminal
  artifacts/
    <task_id>/
      ticket_snapshot.md            # task-level, captured at enqueue (no attempt_id)
      <attempt_id>/
        brief.md
        final_prompt.md
        blocker.md
        session_log.txt
        ci_failure_excerpt.txt
        review_comments.json
        conflict_slice.json
        slack_escalation_post.json
        slack_reply.json
        last_failure.md             # only when budget_exhausted set during this attempt
```

The exact location of `~/.quay/` is configurable per deployment.

### Crash-safe ingestion (locked invariants)

When the tick ingests a `.quay-blocked.md` from the worktree:

1. Persist the file's contents as an artifact (write to artifact dir, then insert the SQL row pointing at the path).
2. Write the corresponding row to `events` and update the task state.
3. **Only after the SQL commit succeeds**, delete `.quay-blocked.md` from the worktree.

If the tick crashes between step 1 and step 3, the file remains on disk; the next tick **completes the missing steps** rather than no-opping. The recovery logic is:

1. Compute `content_hash` of the on-disk file.
2. Check for an existing `artifacts` row matching `(task_id, attempt_id, kind, content_hash)`. If found, **reuse** that row's `artifact_id` (do not insert a duplicate). If not found, write a new row.
3. Check whether the corresponding `events` row and task-state transition were already written for this `artifact_id`. If not, write them now.
4. Delete `.quay-blocked.md` from the worktree (idempotent — missing file is fine).

This way, regardless of which step the previous tick crashed in, the next tick converges to the correct post-condition.

### Spawn-side worktree sweep

Before each new spawn, the spawn helper deletes any leftover `.quay-*` files in the worktree. Belt-and-suspenders defense for partial-crash residue or manual intervention.

### Timestamps

All timestamps are stored in UTC, ISO-8601 format with millisecond precision and a `Z` suffix (e.g. `2026-04-25T14:23:01.123Z`).

---

## 10. CLI surface

Commands are organized into write (mutate state) and read (query only). Idempotency is per-command and detailed in the "Idempotency guarantees" subsection — there is no blanket guarantee.

**Output shape (canonical):**

- **Read commands that return a collection** (`task list`, `task events`, `repo list`) emit a single JSON array on stdout. Empty results emit `[]`.
- **Read commands that return a single record** (`task get`) emit a single JSON object on stdout.
- **`artifact get`** emits raw file contents on stdout by default, or a path string with `--path`.
- **Write commands** emit a single JSON object on stdout describing the result (e.g., `{"task_id": "...", "state": "queued"}` for `enqueue`, `{"ok": true}` for idempotent no-ops). Errors go to stderr in the same JSON-object shape with an `error` field, plus a non-zero exit code.
- **`quay tick`** emits one JSON object **per line** on stdout (NDJSON), one line per task touched, as defined in §5 Observability.

No `--json` flag exists or is needed; JSON is the only output format. The pull-loop example in §11 reflects this contract.

### Write commands

| Command | Purpose | Caller |
|---|---|---|
| `quay enqueue --repo <id> --brief-file <path> --ticket-snapshot-file <path> [--external-ref <id>] [--slack-thread-ref <channel:ts>]` | Register a new task in `queued`. **Synchronously bootstraps the worktree:** validates the bare clone exists at `<repos_root>/<repo_id>.git` (operator-materialized; quay does not clone), runs `git fetch origin <base_branch>`, creates the worktree via `git worktree add`, runs `install_cmd`. Snapshots the ticket and captures the brief. Optionally records a default Slack thread for future escalations. **Does not spawn the worker.** The next `quay tick` promotes the task to `running` when capacity allows. Errors and aborts (no task created) if any bootstrap step fails. | Orchestrator |
| `quay task claim <task_id>` | Atomically transition `awaiting-next-brief` → `claimed-by-orchestrator` and **mint a fresh `claim_id`** (UUID v4). Predicate: `state = 'awaiting-next-brief' AND cancel_requested_at IS NULL`. Returns `{"task_id": "...", "claim_id": "<uuid>"}` on stdout. The orchestrator MUST store `claim_id` and pass it back as `--claim-id <claim_id>` on every subsequent claim-scoped write. Errors if the task is not in `awaiting-next-brief` or has been cancelled. | Orchestrator |
| `quay task release-claim <task_id> --claim-id <claim_id>` | Ownership-fenced release: predicate is `state IN ('claimed-by-orchestrator', 'waiting_human') AND claim_id = ?`. On match: clears `claim_id` and transitions to `awaiting-next-brief`. On mismatch: errors with `claim_lost` (the prior claim was timed out and re-claimed by someone else; the caller must abandon and re-claim). Releasing a task already in `awaiting-next-brief` is an idempotent no-op success (no claim_id check needed for that case). | Orchestrator |
| `quay submit-brief <task_id> --claim-id <claim_id> --brief-file <path> --reason <blocker_resolved\|advice_answered>` | Submit a new brief. **Requires `--claim-id` matching the live `tasks.claim_id`** (ownership fence) and `cancel_requested_at IS NULL`. On `claim_id` mismatch: errors with `claim_lost`. On `cancel_requested_at IS NOT NULL`: errors with `cancelled`. On wrong state otherwise: `wrong_state`. On success: persists the brief as an artifact, transitions the task to `queued`, clears `claim_id`, resets `claim_expirations_consecutive` to 0. Tick promotes `queued → running` on its next cycle when capacity allows; budget is consumed at that promotion (unless reason is `advice_answered`). Errors with `budget_exhausted` if `task.budget_exhausted = true` and reason is `blocker_resolved`; orchestrator must use `escalate-human` or `cancel` instead. **Note:** there is no `--reason initial`; the initial brief is supplied at `enqueue` and `attempts.reason = 'initial'` is set internally by Quay on the first spawn. | Orchestrator |
| `quay escalate-human <task_id> --claim-id <claim_id> --question-file <path> [--thread-ref <channel:ts>]` | Record a human question and transition to `waiting_human`. **Requires `--claim-id` matching the live `tasks.claim_id`** (ownership fence) and `cancel_requested_at IS NULL`; same error taxonomy as `submit-brief`. **The CLI does NOT post to Slack** — it persists the `slack_escalation_post` artifact (with `escalation_seq`, `escalation_nonce`, `content_hash` set) and preserves the claim so the orchestrator owns routing, posting, waiting, and reply handling. `--thread-ref` is optional metadata; missing thread refs are allowed so deployments can use fallback routing outside Quay. Does not consume budget. | Orchestrator |
| `quay record-human-reply <task_id> --claim-id <claim_id> --reply-file <path> [--thread-ref <channel:ts>] [--message-ts <ts>] [--author <name>]` | Persist a human answer as a `slack_reply` artifact and transition `waiting_human` → `claimed-by-orchestrator` under the same ownership fence. The orchestrator then calls `submit-brief --reason advice_answered`, which completes the original handoff without a second Quay-created handoff round-trip. | Orchestrator |
| `quay cancel <task_id> [--close-pr] [--keep-worktree]` | Cancel the task from any non-terminal state. Implementation: **(1) acquire the supervisor lockfile** (the same one `quay tick` holds; blocks if a tick is in flight, up to ~one tick duration); **(2)** in one SQL transaction, write `tasks.cancel_requested_at = now()`, persist `cancel_close_pr` / `cancel_keep_worktree` flags, and — only if the task is in `running` — set `attempts.kill_intent = 'cancel'` on the running attempt; **(3)** still under the lock, tmux-kill the worker if applicable and **run the §5 cancel finalizer synchronously** (ensure no live worker, collect log, branch/worktree/PR cleanup per the §5 matrix, atomic terminal transition to `cancelled`); **(4) release the lock** on completion or error. Acquiring the lock first is what guarantees no in-flight tick is concurrently performing supervisor side effects (Slack post, gh promote, tmux spawn, branch update) on this or any other task — see §5 "Concurrency policy." If the synchronous finalizer is interrupted between intent-write and terminal transition (process crash, lost shell, network failure during `gh pr close`), the next tick's top-of-loop check observes `cancel_requested_at IS NOT NULL` and re-runs the finalizer to convergence. Idempotent on tasks already in `cancelled`. Errors with `wrong_state` if the task is in `merged` or `closed_unmerged`. Default flags: `cancel_close_pr=false` (leaves PR open), `cancel_keep_worktree=false` (cleans worktree). | Operator or orchestrator |
| `quay tick` | Run one cycle of the supervision loop. | Cron / scheduler |
| `quay repo add --id <id> --url <url> --base-branch <branch> --package-manager <pm> --install-cmd <cmd> [...flags]` | Register a repo. Errors on duplicate `id`. | Operator |
| `quay repo update --id <id> [...flags]` | Edit fields on an existing repo row. Errors if `id` is unknown. | Operator |
| `quay repo remove <id>` | **Soft-delete** the repo: sets `repos.archived_at = now()`. Fails if any non-terminal, non-parked task references it (states checked: `queued`, `running`, `pr-open`, `done`, `awaiting-next-brief`, `claimed-by-orchestrator`, `waiting_human`). Terminal (`merged`, `closed_unmerged`, `cancelled`) and parked (`worktree_error`, `orchestrator_loop`, `non_budget_loop`) tasks are preserved with their `repo_id` intact for forensics; the FK remains satisfied. After archival, `quay enqueue --repo <id>` rejects with "repo archived." `quay repo add` with the same id reactivates by clearing `archived_at` (idempotent restore for `quay repo import`). | Operator |
| `quay repo export [--out <path>] [--active]` | Export the `repos` table as JSON for backup. Default includes archived rows so a roundtrip restore is full-fidelity. Pass `--active` to dump only rows with `archived_at IS NULL`. | Operator |
| `quay repo import --in <path>` | Import a `repos` JSON dump. Upserts (idempotent for restore use). | Operator |

### Read commands

| Command | Purpose |
|---|---|
| `quay task get <id>` | Full task state, `slack_thread_ref`, current attempt, recent events. |
| `quay task list [--state <s>]... [--repo <id>] [--external-ref <ref>]` | Filtered list. `--state` is repeatable for OR-filtering across states (e.g. `--state awaiting-next-brief --state waiting_human`). Output is a single JSON array on stdout, with one task object per element. Empty result is `[]`. |
| `quay task events <id>` | Append-only event log for a task. |
| `quay artifact get <task_id> <kind> [--attempt <n>]` | Fetch artifact contents (or path with `--path`). |
| `quay repo list [--active]` | Registered repos. Default returns every row, archived included, so operators debugging "where did my repo go?" still see soft-deleted rows. Pass `--active` to filter to rows with `archived_at IS NULL` — the common consumer question ("which repos are in service?"). |

### Idempotency guarantees

- `quay enqueue` is **not** idempotent on its own — duplicate enqueues create duplicate tasks. The orchestrator is responsible for de-duplicating (e.g., checking via `quay task list --external-ref <id>` before enqueue).
- `quay task claim` is atomic and mints a fresh `claim_id` on every successful claim. Concurrent claims arbitrate at the DB level: one succeeds, the rest error cleanly with `wrong_state` (task isn't in `awaiting-next-brief`) or `cancelled` (`cancel_requested_at` set). The `claim_id` is returned on stdout and MUST be passed back as `--claim-id` on every subsequent claim-scoped write.
- `quay task release-claim --claim-id <id>` is ownership-fenced. Releasing a task in `awaiting-next-brief` is an idempotent no-op success (the fence is irrelevant when there's no live claim). Releasing a `claimed-by-orchestrator` task with a mismatched `claim_id` errors with `claim_lost`. Releasing an unknown task errors (`unknown_task`). Other states error (`wrong_state`).
- `quay submit-brief --claim-id <id>` on a task not in `claimed-by-orchestrator` or with mismatched `claim_id` returns a structured error (`wrong_state`, `claim_lost`, `cancelled`). There is no skip-claim form: the orchestrator must claim first and supply the `claim_id` it received.
- `quay escalate-human --claim-id <id>` follows the same ownership-fence rules. The CLI does not call Slack — it persists the artifact and transitions; tick performs the post.
- `quay cancel` on a task already in `cancelled` is an idempotent no-op success (no second `cancelled` event, no SQL writes). On other terminal states (`merged`, `closed_unmerged`), it errors with `wrong_state` and the observed terminal state in the payload — the operator should not be silently told "cancel succeeded" for a task that actually merged.
- `quay cancel` on a task in `claimed-by-orchestrator` succeeds; the claim is implicitly cleared.
- `quay tick` is idempotent across crashes (see §9 crash-safe ingestion).
- `quay repo add` errors on duplicate `id`. `quay repo import` upserts.

---

## 11. Hermes ↔ Quay seam

### Transport: pull only

**Quay never initiates outbound communication to the orchestrator.** There is no push channel, no webhook, no signal file written by tick for Hermes to watch. The orchestrator drives its own cadence by polling Quay's read commands. (Quay does still talk to GitHub and Slack as part of its substrate role — see §11.x. The "no outbound" rule is orchestrator-specific, not a blanket statement.)

This is a deliberate choice over push:

- No HTTP server in the orchestrator. Hermes stays a client of Quay, not a server.
- No "what if the orchestrator is down" complexity. If Hermes is down, tasks sit in `awaiting-next-brief` until Hermes comes back. State *is* the signal.
- Crash-safe by construction: the SQL state is the source of truth.
- Symmetric with how Quay polls external state (GitHub, Slack). Hermes polls Quay; Quay polls everything else.

The latency floor is the orchestrator's poll interval (typically minutes). For coding tasks operating on minute-scale, that's irrelevant.

### The orchestrator pull loop (deployment glue, not Quay)

The pull loop lives **outside Quay** as a small, deterministic, code-level script. The script is **not** an LLM operation — it does not invoke Hermes for the act of polling.

Sketch:

```bash
#!/bin/bash
# Runs every N minutes via cron / systemd timer / launchd.
quay task list --state awaiting-next-brief | \
  jq -r '.[].task_id' | \
  while read task_id; do
    # Atomically claim before invoking the LLM.
    if quay task claim "$task_id"; then
      hermes invoke --skill orchestrator --task-id "$task_id"
      # Hermes ends with submit-brief or escalate-human, transitioning
      # the task out of claimed-by-orchestrator. If Hermes crashes,
      # tick auto-releases the claim after claim_timeout_seconds.
    fi
    # If claim fails, another instance got there first; skip.
  done
```

Quay ships this as an example in `examples/orchestrator-pull.sh`. The deployment is free to translate it to its language of choice.

### Atomic claim-and-release

To prevent two orchestrator pulls from racing on the same task (which would burn LLM tokens on duplicate work), Quay enforces atomic claiming via a dedicated state.

- The orchestrator pull script calls `quay task claim <id>` after seeing a task in `awaiting-next-brief` and **before** invoking Hermes.
- The claim atomically transitions `awaiting-next-brief` → `claimed-by-orchestrator`. Concurrent claim attempts: one wins; the rest error cleanly.
- The orchestrator's terminal action (`submit-brief` or `escalate-human`) transitions the task out of `claimed-by-orchestrator`.
- If Hermes crashes mid-work, the task sits in `claimed-by-orchestrator` until tick auto-releases it (claim age > `claim_timeout_seconds`, default 30 min).
- Pulls of `awaiting-next-brief` do not see claimed tasks (different state), so the race is naturally closed.

### Read commands as the orchestrator API

The orchestrator may call read commands at any time, for any reason — status reports, deduplication checks (`quay task list --external-ref <id>`), training-data export, debugging, Slack-bot status answers. Read commands have no side effects, no token cost, and no concurrency constraints. Output is JSON.

### Orchestrator responsibilities (not in Quay)

- Fetching tickets from external systems (Linear, Jira, GitHub Issues).
- Classifying complexity, applying approval policy, deciding whether to enqueue.
- Composing the initial brief at enqueue time.
- Running the pull loop (deployment glue).
- Composing follow-up briefs after claiming a task in `awaiting-next-brief`.
- Deciding when a blocker needs a human (calling `quay escalate-human`).
- Knowing what to put in a Slack escalation question.
- Picking which Slack thread (typically the originating ticket's thread) to escalate into; passing the thread ref to Quay at escalation time.

### Quay responsibilities (not in the orchestrator)

- Worktree creation and cleanup.
- Worker spawn, supervision, kill.
- All polling of GitHub PR / CI / review state.
- All polling of Slack threads Quay has posted to.
- Persistence of all artifacts.
- Enforcement of capacity caps and retry budgets.
- The transition state machine, including atomic claim arbitration, claim timeout, and orchestrator-loop parking.

### Slack integration (minimal scope; details deferred to implementation)

Slack is a contained sub-component of Quay's substrate role. The contract:

- Quay holds a Slack bot token, sourced from the `SLACK_TOKEN` env var.
- New human-advice flow does not require Quay to call Slack. The orchestrator chooses the route, posts the question, waits for the answer, then records the reply through `record-human-reply`.
- On `quay escalate-human`, Quay persists the question as a `slack_escalation_post` artifact, transitions the task to `waiting_human`, and preserves the claim. The thread ref is optional metadata. **No Slack API call happens during the CLI command.**
- Claimless legacy `waiting_human` rows with `slack_thread_ref` may still be completed by tick's old Slack post/reply recovery path. Claimless legacy rows without a thread are requeued to `awaiting-next-brief` with a durable handoff.
- Auth, retries, rate-limit handling, credential rotation: implementation detail, not specified here.
- The orchestrator picks the thread or fallback route. Quay does not decide where to post.

---

## 12. Worker spawning (tmux + coding agent)

### Repo bootstrap and worktree lifecycle

Quay creates the worktree at enqueue time, **before** the task enters `queued`. By the time the task is in the queue, the worktree is fully bootstrapped and ready for the first spawn whenever tick promotes it. The worker never touches git plumbing (clone, fetch, branch creation, install commands).

**Bootstrap timing — at enqueue, synchronously:**

`quay enqueue` runs all of these before returning, in order. If any step fails, enqueue errors and **no task row is created** (atomic from the orchestrator's perspective).

1. **Validate bare clone exists:** Check that `<repos_root>/<repo_id>.git` exists (via `bareCloneExists`); if missing, throw `QuayError("bare_clone_missing")` with the expected path and a copy-pasteable `git clone --bare <repo_url> <expected_path>` remediation hint. Quay never runs `git clone` — materialization is the operator's responsibility.
2. **Fetch:** `git fetch origin <base_branch>` against the bare clone to refresh the base.
3. **Branch name resolution:** compute the branch slug from `external_ref` per the §13 git-safe slug rules (or fall back to `task-<task_id_short>` if no `external_ref`); the candidate branch name is `quay/<slug>`. Check for collisions against **both** the local bare clone *and* the remote (the cancellation rules at §5 retain the remote branch when a PR is open, even though the local branch is always deleted, so a local-only check is insufficient — a stale remote PR could otherwise be reused by an unrelated task):
   - Local check: `git -C <bare> show-ref --verify refs/heads/<branch>`.
   - Remote check: `git -C <bare> ls-remote --exit-code origin refs/heads/<branch>` (already-cached after step 2's fetch of `base_branch`; for a non-base branch, run `git ls-remote origin <branch>` once here).
   - Open-PR check: `gh pr list --head <branch> --state open --json number` returns non-empty (catches the "remote branch deleted by GitHub on merge but PR closed_unmerged" cases too — open PRs with a re-pushable branch).
   If any of the three reports the branch as taken, append `-<task_id_short>` to disambiguate (e.g. `quay/ITRY-900-a3f2c8b1`). The disambiguated form is then re-checked against the same three sources; if it still collides (extremely unlikely — the task_id_short suffix is per-UUID), abort enqueue with `branch_collision_unresolvable`. Compute the tmux identifier separately per the §13 tmux-id rules (used at promotion time, not here).
4. **Worktree:** `git worktree add -b <branch_name> <worktree_path> origin/<base_branch>`, where `worktree_path` is `~/.quay/worktrees/<task_id>`.
5. **Install:** run `install_cmd` (from per-repo config) inside the worktree. Output is captured but not surfaced as an artifact in v1 (it's deterministic and rarely interesting); failures abort.
6. **Schedule attempt #1 + persist artifacts (one SQL transaction):** insert the `tasks` row (`state = queued`, `branch_name = quay/<resolved_slug>`, `tmux_id = <resolved tmux identifier per §13>`), insert the **scheduled** `attempts` row #1 (`reason = initial`, `consumed_budget = 1`, `tmux_session = NULL`, `spawned_at = NULL`, `preamble_id` = current preamble), insert artifact rows: `ticket_snapshot` (task-level), `brief` (linked to attempt 1), `final_prompt` (linked to attempt 1). On any DB or filesystem failure during this step, run cleanup (see "Enqueue rollback" below) and abort.

**Why attempt #1 is scheduled at enqueue:** every attempt has exactly one `brief` and `final_prompt` artifact, including the initial one. Creating the (scheduled) attempt row at enqueue keeps that invariant clean — there's no special-case "task-level brief that gets copied to attempt 1 at promotion." Tick's `queued → running` promotion just **promotes** the pending attempt row by filling in `spawned_at` and (after the substrate work) `tmux_session`, and incrementing `tasks.attempts_consumed`. Same lifecycle as every subsequent respawn.

**Why at enqueue, not at promotion:**
- Tick stays fast. Promoting `queued → running` is just creating the tmux session, not 30 seconds of `git fetch`.
- Failure surface is simpler: enqueue errors, the orchestrator handles it. No half-bootstrapped `queued` task to recover.
- The orchestrator is already waiting synchronously on the CLI return; a slow first-enqueue against a large repo is acceptable.

**Enqueue rollback (per-step recovery on failure):**

| Failed step | Rollback action |
|---|---|
| 1 (validate bare clone) | No rollback needed — quay never creates the bare clone, so there is nothing to undo. |
| 2 (fetch) | Read-only against the bare clone; no rollback needed. |
| 3 (branch resolution) | In-memory; can't fail destructively. |
| 4 (worktree add) | `git worktree add` is atomic — partial worktree shouldn't exist. If a stray worktree from a prior crash exists, `git worktree prune` first. |
| 5 (install_cmd fails) | `git worktree remove --force <worktree_path>`; `git branch -D <branch_name>` against the bare clone. Bare clone stays. |
| 6 (artifact write or SQL insert fails) | `git worktree remove --force <worktree_path>`; `git branch -D <branch_name>`; delete any partial artifact files (`~/.quay/artifacts/<task_id>/`). SQL transaction rolled back automatically (no committed task row). |

After rollback, enqueue exits with a structured error describing which step failed. The Quay deployment is left in the same state it was in before the failed enqueue.

**Worktree per task, ephemeral:**
- Created at enqueue (above).
- Removed via `git worktree remove --force` on terminal transitions (`merged`, `closed_unmerged`, `cancelled`).
- Worktrees are never reused across tasks. Bare-clone caching is what saves network cost; worktrees are cheap to create from a warm bare clone.

**Branch naming (canonical):**
- `quay/<branch_slug>` where `branch_slug` is the §13 git-safe normalization of `external_ref` (e.g. `quay/ITRY-900`, `quay/feat/ABC.123`).
- `quay/task-<task_id_short>` (first 8 chars of UUID) if no `external_ref` or if the slug normalizes to empty.
- On collision: append `-<task_id_short>`: `quay/ITRY-900-a3f2c8b1`.
- Tmux session names are derived independently (`quay-task-<tmux_id>-<attempt_number>`); see §13.

**Install command:**
- Runs **once at enqueue** (step 5 above). Installed dependencies persist for the worktree's lifetime; subsequent retries on the same worktree do not re-run install.
- This is what justifies preamble rule 7 ("dependencies are already installed; do not re-run install commands").

### tmux session naming

`quay-task-<tmux_id>-<attempt_number>`, where `tmux_id` is the per-task tmux identifier derived from `external_ref` per §13. The `tmux_id` always ends in `-<task_id_short>` so it is **globally unique by construction** across active tasks — no dependence on branch-slug uniqueness. Example: for a task with `external_ref = "ITRY-900"` and `task_id_short = "a3f2c8b1"`, the third attempt's session is `quay-task-ITRY-900-a3f2c8b1-3`. The `tmux_id` is stored on `tasks.tmux_id` at enqueue so spawn-failure recovery and the cancel finalizer can compute the canonical name deterministically; the attempt number disambiguates within a task.

### Prompt delivery

1. Quay writes `<worktree>/.quay-prompt.md` containing `preamble + "\n\n" + brief`.
2. Quay creates the tmux session: `tmux new-session -d -s <session_name> -c <worktree>`.
3. Quay configures pane piping to the session log: `tmux pipe-pane -t <session_name> -o "cat >> <worktree>/.quay-session.log"`.
4. Quay sends the agent invocation as keys to the pane, **wrapped in `exec sh -c '<...>'`** so the pane exits when the agent process exits. **The prompt is delivered as a file path, never inline-quoted.** Shell-quoting prompts of arbitrary content via `tmux send-keys` is fragile (newlines, quotes, backticks all break in subtle ways). The wrapper also captures the agent's exit status (`$?`) to `<worktree>/.quay-exit-code` after the agent exits and before the wrapper itself returns; the dead-worker classifier reads this on transition and persists it as an `exit_status` artifact (absence vs. presence is what discriminates "wrapper observed the agent exit" from "wrapper itself was reaped"). Canonical pattern (after substituting `{prompt_file}` into `agent_invocation`):

    ```
    tmux send-keys -t <session_name> "exec sh -c '<agent_invocation_with_prompt_file> ; printf %s \"\$?\" > <worktree>/.quay-exit-code'" C-m
    ```

    The `exec` is load-bearing: without it, the configured agent runs as a child of the session's interactive shell, and when the agent exits the shell remains, so `tmux has-session` would report the session as alive *forever* — turning every successful completion into a staleness or wall-clock kill on the next tick. With `exec sh -c`, the `sh` process replaces the login shell; when the agent inside it exits, the wrapper writes the exit-code file and `sh` exits, and tmux destroys the pane (and session, since the pane is the only one). `is_alive(handle)` flipping to false is then the canonical "worker has finished" signal that drives the dead-worker branch in §5. The post-agent step adds milliseconds and is a no-op for the liveness contract; if the whole pane is killed (cgroup reap, OOM, `tmux kill`) the wrapper never reaches the post-agent step and `.quay-exit-code` stays absent.

    Quoting: Quay constructs the keystroke string by substituting `{prompt_file}` (a Quay-controlled path with no shell metacharacters by construction — see §13 worktree paths) into the operator-configured `agent_invocation`, then wrapping the result in `sh -c '...'`. The single-quoted `sh` command runs `agent_invocation` through `/bin/sh` (matching Quay's documented command-execution model in §13). If the operator's `agent_invocation` already contains a literal single quote, the operator escapes it per standard `sh -c` rules; Quay does not transform `agent_invocation` beyond the `{prompt_file}` substitution.

The exact agent invocation (Claude Code, Codex, other) is configurable per deployment via `agent_invocation`. v1 ships with a tested invocation pattern for at least one coding-agent CLI; the choice is a deployment knob, not a Quay decision.

**Liveness contract:** the pane exits iff the agent process exits. Quay relies on this for every "is the worker still running?" check. Operators must not configure `agent_invocation` strings that fork the agent into the background or otherwise outlive themselves; doing so will mis-trigger staleness / wall-clock kills.

### The five primitives, implemented against tmux

| Primitive | Implementation |
|---|---|
| `spawn(worktree, prompt, env) → handle` | Write `.quay-prompt.md`, create tmux session, configure pane pipe, send keys to invoke the agent **wrapped in `exec sh -c '...'`** so the pane exits when the agent exits (see "Prompt delivery"). Return the session name as the handle. |
| `is_alive(handle) → bool` | `tmux has-session -t <handle>` exit code. Relies on the `exec` wrapping above — without it, the session would outlive the agent process and corrupt liveness detection. |
| `log_freshness(handle) → timestamp` | `stat -f %m <worktree>/.quay-session.log` (or equivalent). For a freshly spawned worker with no log bytes yet, returns the spawn timestamp. |
| `kill(handle) → void` | `tmux kill-session -t <handle>`. Idempotent: missing session is not an error. |
| `collect_log(handle) → path` | Returns the path to `.quay-session.log`. Quay copies the file into the artifact store. |

### No adapter abstraction in v1

The five primitives are direct functions in the CLI, not an interface. Tmux is the only backend. If/when a second backend is needed (direct subprocess, remote worker), the abstraction is lifted at that point.

### Staleness threshold

Default: **10 minutes** of no log bytes. Configurable per deployment. Tuned against real workloads — too low produces false-positive kills on busy workers running long builds; too high lets hung workers waste a tick cycle or two.

---

## 13. Configuration

### Deployment-level config

Single config file (location configurable; default `~/.quay/config.toml`). Loaded once per `quay tick` and per CLI invocation.

| Key | Default | Purpose |
|---|---|---|
| `data_dir` | `~/.quay` | Where SQL, artifacts, lockfile live. |
| `repos_root` | `${data_dir}/repos` | Where bare clones for registered repos live. Override to share the bare-clone cache across multiple agent tools. |
| `worktree_root` | `~/.quay/worktrees` | Where per-task worktrees are created. |
| `max_concurrent` | `2` | Max tasks in `running`. |
| `max_total` | `5` | Max tasks not in a terminal state. |
| `retry_budget` | `5` | Default retry budget per task. |
| `staleness_threshold_seconds` | `600` | Log-quietness window after which a live worker is considered stale. |
| `max_attempt_duration_seconds` | `3600` | Absolute wall-clock cap on a single attempt. A worker exceeding this is killed regardless of staleness; counts against retry budget. |
| `claim_timeout_seconds` | `1800` | Max age of an orchestrator claim before tick auto-releases the task back to `awaiting-next-brief`. |
| `max_claim_expirations` | `3` | Consecutive `claim_expired` events before the task is parked in `orchestrator_loop`. |
| `max_non_budget_respawns` | `20` | Count of allowed review-feedback + merge-conflict respawns per task (the two paths that can loop on stale GitHub signals). The Nth respawn schedules normally; the (N+1)th parks the task in `non_budget_loop`. **`advice_answered` is NOT counted** — it's bounded by human availability (one respawn per Slack reply) and is not a runaway-loop risk. |
| `max_spawn_failures` | `3` | Consecutive substrate-side spawn failures (tmux create errors, DB write failures during spawn) before the task is parked in `worktree_error`. Substrate spawn failures do not consume retry budget. |
| `tick_lock_path` | `${data_dir}/tick.lock` | **Supervisor lockfile** — held by `quay tick` for the duration of a cycle and by `quay cancel` for intent-write + finalizer. Name retained for compatibility; semantically protects all supervisor side effects (tmux, gh mutations, Slack, FS, branch ops). |
| `supervisor_lock_stale_seconds` | `30` | Grace period after which a lockfile whose owning PID is no longer alive is considered stale and reclaimable. Prevents a hung-then-killed tick from indefinitely blocking `quay cancel`. |
| `agent_invocation` | (e.g. `claude --prompt-file {prompt_file}`) | The CLI invocation pattern for spawning the worker. The literal token `{prompt_file}` is substituted with the path to `.quay-prompt.md` at spawn time. |

### Repo materialization

Quay is a **consumer** of bare clones, not a manager. It never runs `git clone`.

- The operator (or a sibling tool) is responsible for materializing `<repos_root>/<repo_id>.git` before the first `quay enqueue` for that repo.
- The required bootstrap command is `git clone --bare <repo_url> <repos_root>/<repo_id>.git`. No additional `git config` is needed — quay uses an explicit `<src>:<dst>` refspec on its fetches, which works on a vanilla bare clone without `remote.origin.fetch` configured.
- A missing clone causes `bare_clone_missing` from `quay enqueue`; the error body includes the expected path and the exact `git clone --bare` command as a copy-pasteable remediation hint.
- See the README's "Bootstrapping a repo" section for the operator-facing workflow.

### Per-repo config (`repos` table)

Set via `quay repo add`. Required fields: `repo_id`, `repo_url`, `base_branch`, `package_manager`, `install_cmd`. Optional: `test_cmd`, `ci_workflow_name`, `contribution_guide_path`. Edited via `quay repo update` (separate write command). `quay repo import` also upserts as part of bulk-restore.

### Input normalization and command execution

**Slugification (`external_ref` → identifiers):**

The branch slug and the tmux identifier are derived from `external_ref` via **two separate normalizations**, run independently. They do not need to match each other; each must satisfy the constraints of its own substrate. The original `external_ref` is preserved verbatim in `tasks.external_ref` for display and queries (`quay task list --external-ref <ref>` matches the verbatim form).

**Branch slug (must satisfy `git check-ref-format refs/heads/quay/<slug>`):**

The rules apply **per-component** (split on `/`) for anything that's a component-local constraint (`.lock` suffix, leading/trailing `.`), and globally for anything that isn't (overall length, character set). A final `git check-ref-format` call is the canonical gate; if it rejects, fall back to the task-id form.

1. **Character substitution.** Any character outside `[A-Za-z0-9._/-]` is replaced with `-`. (`@{` cannot survive this.)
2. **Run collapse.** Collapse runs of `/` → single `/`, runs of `.` → single `.`, runs of `-` → single `-`.
3. **Per-component normalization.** Split on `/`. For each component (independently):
   - Strip leading and trailing characters from the set `.-`. (After step 2 there are no internal runs to worry about.)
   - If the component ends with `.lock`, strip the trailing `.lock` and re-strip trailing `.-`.
   - If the component is now empty, mark it for removal.
   Drop any components marked for removal, then rejoin with `/`.
4. **Strip leading/trailing `/`** (which can appear after step 3 dropped edge components).
5. **Truncate to 64 characters.** If truncation lands inside a component such that the trailing character is `/`, `.`, or `-`, re-run step 3 against the truncated form. (One fixed-point pass is sufficient.)
6. **Empty fallback.** If the result is empty (e.g., `external_ref` was `...`, `////`, or `..foo../.lock` whose only component normalized away), use `task-<task_id_short>`.
7. **Final ref-format gate.** Run `git check-ref-format refs/heads/quay/<slug>`. If it rejects (covering any pathological case the rules above missed — e.g. a control char that snuck through, or a future rule change in `git check-ref-format`), fall back to `task-<task_id_short>` and re-validate. This is a **hard gate, not advisory**: enqueue refuses to proceed past step 3 (worktree creation) without a passing slug.
8. Final branch name: `quay/<slug>`.

Examples (annotated to show why the per-component rules matter):
- `foo/.bar` — step 3 strips the leading `.` from the second component → `foo/bar`.
- `foo/bar.lock/baz` — step 3 strips `.lock` from the second component → `foo/bar/baz`.
- `foo/bar.` — step 3 strips the trailing `.` from the second component → `foo/bar`.
- `..foo..bar..` — step 2 collapses `..` to `.`, step 3 strips the leading and trailing `.` → `foo.bar`.
- `feat//ABC` — step 2 collapses `//` to `/` → `feat/ABC`.
- `///` — every component empties, step 6 kicks in → `task-<task_id_short>`.

**Tmux identifier (must be safe for tmux session names, log filenames, and shell paths; must be globally unique across active tasks by construction):**

The tmux identifier is a per-task value derived independently of the branch slug. It is **not** routed through the branch-slug collision-suffix logic — a `task_id_short` suffix is appended unconditionally so uniqueness holds even when two distinct `external_ref`s collapse to the same human-readable tmux slug while producing different branches (e.g., `foo.bar` and `foo/bar` both collapse to tmux slug `foo-bar` but branch as `quay/foo.bar` vs `quay/foo/bar` — branch-collision logic would not catch this, so tmux must guarantee its own uniqueness).

1. **Character substitution.** Any character outside `[A-Za-z0-9_-]` is replaced with `-`. (`/`, `.`, and other punctuation are folded to `-`.)
2. **Collapse runs** of `-` to a single `-`; strip leading/trailing `-`.
3. **Reserve suffix room.** Truncate the human-readable part to **38 characters** (this leaves room for the `-<task_id_short>` suffix below within the overall 48-char tmux-id budget; `task_id_short` is 8 hex chars plus a leading `-`). After truncation, re-strip any trailing `-`.
4. **Empty fallback for the human part.** If the result is empty after the steps above (e.g., `external_ref` was `...`, `////`, or absent), use `task` as the human-readable part.
5. **Append the per-task suffix.** The final `tmux_id` is `<human_part>-<task_id_short>`. `task_id_short` is the first 8 hex chars of `task_id` (the same value used by the branch-slug fallback). The result is at most 47 chars (`38 + 1 + 8`), well within tmux's 256-char session-name limit.
6. **Final tmux session name** (per attempt): `quay-task-<tmux_id>-<attempt_number>`.

Examples:
- `ITRY-900` (task_id_short `a3f2c8b1`) → branch `quay/ITRY-900`, tmux `quay-task-ITRY-900-a3f2c8b1-<n>`.
- `feat/ABC.123` (task_id_short `b1c2d3e4`) → branch `quay/feat/ABC.123`, tmux `quay-task-feat-ABC-123-b1c2d3e4-<n>`.
- `..foo..bar..` (task_id_short `99887766`) → branch `quay/foo-bar` (steps 2–5 collapse `..` and strip leading/trailing `.`), tmux `quay-task-foo-bar-99887766-<n>`.
- `evil; rm -rf /` (task_id_short `cafe1234`) → branch `quay/evil-rm-rf` (after collapse + strip), tmux `quay-task-evil-rm-rf-cafe1234-<n>`.
- **Collision example.** Two enqueues with `external_ref = "foo.bar"` (task_id_short `aaaaaaaa`) and `external_ref = "foo/bar"` (task_id_short `bbbbbbbb`): both collapse to tmux human-part `foo-bar`, but the suffix differentiates → `quay-task-foo-bar-aaaaaaaa-1` and `quay-task-foo-bar-bbbbbbbb-1`. No collision.

Collisions across distinct `external_ref` values that slug to the same branch are handled by the §12 branch-naming collision-suffix rule. Tmux identifiers handle their own uniqueness via the unconditional `task_id_short` suffix above; **cross-task tmux collisions are not possible by construction**, regardless of how branch slugs land.

**Command execution (`agent_invocation`, `install_cmd`):**

- Both run via `/bin/sh -c <command>`. Shell expansion (`$VAR`, pipes, redirects, `&&`) is intentional — operators want to compose commands inline.
- Quay does not parse, validate, or rewrite these strings beyond substituting `{prompt_file}` (in `agent_invocation` only) at spawn time.
- These are **operator-controlled deployment config**, not user-controlled input. The deployment is responsible for the contents being non-malicious. Quay does not defend against an operator who configures a malicious `install_cmd` against their own machine.
- External-input fields (`external_ref`, ticket snapshots, briefs) are never interpolated into shell commands. The slugification rule above is the only normalization that touches user-influenced input flowing into shell-level identifiers.

### What configuration does not include

- Approval policy, complexity thresholds, "which tickets to enqueue" rules. Those live in the orchestrator skill.
- **Linear credentials, ticket source mapping.** Orchestrator concern — Quay never talks to Linear directly.
- **Slack credential (`SLACK_TOKEN`) is a Quay runtime env concern.** Quay performs the Slack API calls (post + reply polling), so Quay needs the token. The orchestrator decides *when* and *which thread*, but doesn't carry the token.
- Worker model selection beyond the agent invocation pattern. The orchestrator is free to vary the prompt; the invocation itself is one knob.

---

## 14. Edge cases and invariants

| Topic | Locked behavior |
|---|---|
| **Supervisor side-effect serialization** | A single supervisor lockfile (`tick_lock_path`) serializes every process that performs supervisor side effects: `quay tick` holds it for the entire cycle; `quay cancel` acquires it before writing `cancel_requested_at` and holds it through the finalizer. A second `tick` invoked while the lock is held exits without action; `cancel` blocks until acquisition (or a stale-PID takeover after `supervisor_lock_stale_seconds`). The lock is the primary mechanism that prevents tick-owned and cancel-owned side effects from racing on the same task. As belt-and-suspenders, every tick-owned mutating SQL write also predicates on `cancel_requested_at IS NULL` and aborts on rowcount=0. |
| **Per-task tick errors** | Logged as `tick_error` event; tick continues to next task; transient `tick_error` flag on the task is cleared on next successful tick. |
| **Force-push / rebase on PR branch** | Relies on `gh pr checks` reflecting the most recent SHA. Captured as a v1 test case. |
| **PR closed without merge** | Terminal status `closed_unmerged`, distinct from `merged` and `cancelled`. |
| **Merge conflict on PR (`mergeable: CONFLICTING`)** | Polled in both `pr-open` and `done`. Triggers re-queue with a deterministic conflict brief. Does not consume retry budget. If the worker can't resolve and writes `.quay-blocked.md`, falls through the regular blocker path. |
| **Worktree corruption** | Tick wraps worktree-touching operations in error handling. Transitions task to `worktree_error`. Stops ticking that task. Recovery is manual (`quay cancel`). No auto-rebuild. |
| **Multiple signal files across attempts** | Filename is fixed (`.quay-blocked.md`). Tick ingests then deletes (artifact write → SQL commit → file delete). Spawn-side sweep removes any leftover `.quay-*` files before each new spawn. |
| **Unknown / malformed signal file** | Treated as a deterministic retry path (template `malformed_signal`), not as a worker blocker. Budget consumed on the resulting respawn. |
| **`quay cancel` on missing worktree** | Forgiving — proceeds to mark `cancelled` even if cleanup steps fail. |
| **Timestamps** | UTC, ISO-8601 with millisecond precision and `Z` suffix. |
| **PR pointer persistence** | The `pr_number`, `pr_url`, etc. on the task row persist past terminal. Only the worktree and (sometimes) the branch are cleaned up. |
| **Worker never told about retries** | Each spawn presents to the worker as a clean shot. Retry context, when applicable, is folded into the brief by the orchestrator. |
| **tmux pane exits with the agent process** | The agent invocation is sent as `exec sh -c '<agent_invocation>'`, so when the agent exits the `sh` exits, tmux destroys the pane, and `tmux has-session` flips to false. Without this, a successful completion would leave the interactive shell alive and Quay would mis-detect it as staleness or wall-clock. Operators must not configure `agent_invocation` strings that fork the agent into the background. |
| **Single cancel finalizer, durable task-level intent** | One canonical sequence (§5 "Cancel finalizer") drives every transition into `cancelled`. Cancel intent is recorded as `tasks.cancel_requested_at` — a **task-level** durable field — so recovery works from every non-terminal state (`running`, `pr-open`, `done`, `awaiting-next-brief`, `claimed-by-orchestrator`, `waiting_human`, parked). Tick checks the field at the **top of every per-task iteration**, before per-state handling. `attempts.kill_intent = 'cancel'` is retained only as the worker-kill mechanism for `running`, never as the recovery trigger. Operator flags (`--close-pr`, `--keep-worktree`) are persisted at intent-write time so the asynchronous path honors them. Idempotent: re-entry on `cancelled` is a no-op success. A crash anywhere between `cancel_requested_at` and the finalizer's terminal transition — including after irreversible side effects like `gh pr close` — is recovered on the next tick. |
| **Quay never merges or approves PRs** | Hard constraint. PR terminal state is decided externally by humans. |
| **Quay never initiates outbound communication to the orchestrator** | Pull-only model. The orchestrator drives its own cadence by polling read commands. State is the signal. |
| **Atomic orchestrator claims with ownership fence** | `quay task claim` is the only entry into orchestrator-side LLM work. It mints a fresh `tasks.claim_id` (UUID v4) and returns it on stdout. Every claim-scoped write (`submit-brief`, `escalate-human`, `release-claim`) requires `--claim-id <claim_id>`; the SQL predicate is `state = 'claimed-by-orchestrator' AND claim_id = ? AND cancel_requested_at IS NULL`. Mismatched `claim_id` → `claim_lost` (the prior claim was timed out and re-issued; caller must re-claim). Pending cancellation → `cancelled`. Concurrent claims arbitrate atomically. **A stale claimant cannot mutate a re-claimed task** — the ownership fence is durable across timeouts, claim re-issuance, and crashes. |
| **Claim timeout** | A claim older than `claim_timeout_seconds` (default 30 min) is auto-released by tick. Recovers from orchestrator crashes within at most one tick cycle past the timeout. |
| **Orchestrator-loop parking** | After `max_claim_expirations` consecutive `claim_expired` events on a task, tick parks it in `orchestrator_loop`. Caps token waste from a crash-looping orchestrator. The counter resets to 0 on any successful `submit-brief` or `escalate-human`. |
| **Wall-clock cap per attempt** | A worker running longer than `max_attempt_duration_seconds` (default 1 hour) is killed regardless of log activity. Triggers a deterministic retry path (consumes budget). Catches chatty-but-unproductive workers. |
| **Budget-exhausted handoff** | Quay never forces a task into a terminal-failed state on budget exhaustion. The task parks in `awaiting-next-brief` with `budget_exhausted = true`. The orchestrator decides between `escalate-human` and `cancel`. Quay never owns "this task is hopeless" judgment. |
| **Budget consumed at spawn/respawn time, not at trigger time** | Worker blockers, CI failures, etc. don't decrement budget on detection — only the act of spawning a new attempt does. The first spawn (tick promoting `queued → running` with `reason = initial`) also consumes one unit. `submit-brief --reason advice_answered`, `review`, and `conflict` respawns do not consume. `submit-brief --reason blocker_resolved` errors when `budget_exhausted = true`. |
| **Enqueue does not spawn** | `quay enqueue` registers a task in `queued`; the next `quay tick` promotes to `running` when capacity allows. Capacity logic lives in tick only. |
| **Bootstrap is atomic at enqueue** | All git/install work happens synchronously inside `quay enqueue`. Any bootstrap failure aborts enqueue cleanly with no task row created. By the time a task is in `queued`, its worktree is fully ready for spawn. |
| **SQL atomicity, side-effect eventual consistency** | The transition chokepoint guarantees one SQL transaction per state change. Side effects (tmux, gh, Slack, FS) happen outside the transaction with explicit ordering and idempotent recovery on the next tick. See §5 "Transition chokepoint and side-effect ordering." |
| **Non-budget respawns are deduplicated** | Review feedback dedupes by `last_review_id_acted_on`; merge conflict by `last_conflict_observation`. A safety cap (`max_non_budget_respawns`, default 20) parks the task in `non_budget_loop` if the dedupe keys ever miss. Stale GitHub signals do not cause infinite respawns. |
| **`pr-open` polls PR state** | `pr-open` checks for merged/closed PR state on every tick, not just CI. Humans merging or closing while CI is pending transitions to terminal cleanly. |
| **Single spawn point: `queued → running` in tick** | All respawns (orchestrator-driven via submit-brief, Quay-driven for any retry path) transition to `queued` first; tick promotes to `running`. Capacity caps enforced uniformly; retry paths cannot bypass `max_concurrent`. |
| **Substrate spawn failures don't consume budget — only on the no-evidence path** | tmux create errors and DB write failures during spawn that produce *no worker evidence* (no signal file, no remote progress, no PR opened during this attempt) roll back the budget increment and re-queue. The recovery's evidence-first classifier (see "Spawn-failure recovery is evidence-first") detects when a worker actually started and made observable progress despite a substrate or DB hiccup, in which case the attempt is treated as the equivalent dead-worker outcome (`pr_opened` / `blocker_written` / `no_progress` / `crashed`) and budget is **not** rolled back — those are real attempts. After `max_spawn_failures` *consecutive* no-evidence failures, parked in `worktree_error`. The counter resets on any successful spawn or any evidence-found recovery. |
| **Slack reply cursor** | Tick ingests Slack replies with `ts > lower_bound`, where `lower_bound = slack_recovered_post_ts` when set (the actual bot-post ts, recovered from Slack via the per-escalation nonce) and `slack_pre_post_fence_ts` as a fallback until recovery succeeds. Pre-existing thread chatter is excluded by the fence; chatter that lands between fence-read and bot-post visibility is excluded by the recovered ts. |
| **Every attempt has one brief and one final_prompt artifact** | Whether composed by the orchestrator (`initial`, `blocker_resolved`, `advice_answered`) or by Quay (deterministic templates). Initial attempt is created at enqueue with `tmux_session = NULL`; tick fills it in on promotion. |
| **CI status semantics** | Defined precisely in §5 "CI status rules": stale-SHA filtering, any reported failure blocks, no reported checks = pass, unparseable = pending. |
| **Read commands return JSON** | Collections → JSON array. Single records → JSON object. NDJSON only for `quay tick`. No `--json` flag. |
| **Idempotent PR contract** | The worker creates a PR only if none exists for its branch; otherwise it pushes updates to the existing PR. Tick uses per-attempt `remote_sha_at_spawn` vs. `remote_sha_at_exit` (the **remote** branch SHA, fetched fresh) to detect "no progress." It also snapshots `pr_existed_at_spawn` at promotion: if no PR existed at spawn but one exists at exit, the attempt counts as progress even when the remote SHA didn't change during *this* attempt (handles the case where attempt N pushed but crashed before `gh pr create`, and attempt N+1 only opens the PR). Local-only commits do not count as progress; the PR is only updated by a successful push. |
| **Spawn-failure recovery is evidence-first** | If a task is in `running` with `spawned_at` set but `tmux_session = NULL`, that's a crash mid-spawn. Tick recovery is **NOT** an unconditional spawn-failed write — between substrate-step success and DB-step commit, the worker may have started, run, pushed, opened a PR, or written a blocker. Recovery (1) kills any orphan canonical-name tmux session, (2) collects the session log, (3) runs the same dead-worker evidence classifier as the normal `running` branch (blocker → `awaiting-next-brief`; PR with progress → `pr-open`; PR no progress → `crash` retry; no PR no signal → `spawn_failed` rollback). Budget is preserved on every evidence-found path; budget rollback applies only to the genuine no-evidence case. This guarantees that a real PR opened during the spawn-step-3-to-4 crash window is never killed and never causes false `no_progress` or budget-loss. |
| **Recovery-path artifacts always have an attempt_id** | `blocker`, `slack_reply`, `malformed_signal`, `slack_escalation_post` are linked to a specific attempt and set `content_hash`. The partial unique index excludes NULL `attempt_id` values to avoid SQLite NULL-non-distinct duplicates. For `slack_escalation_post` the hash also incorporates `escalation_seq` so a recovery retry collides while a legitimate second escalation on the same attempt does not. |
| **Human advice is orchestrator-owned** | `escalate-human` records the question and preserves the claim; `record-human-reply` records the answer and returns the task to `claimed-by-orchestrator`; `submit-brief --reason advice_answered` schedules the next worker and completes the original handoff. Tick does not need workspace-specific Slack routing policy for the new flow. |
| **Legacy Slack recovery is isolated** | Claimless `waiting_human` rows with a thread can still use the old tick-owned nonce/fence/reply path. Claimless rows without a thread are requeued to `awaiting-next-brief` so they are not stranded. |
| **CI source: pinned `gh` commands** | `gh pr view --json headRefOid` for SHA; plain-text `gh pr checks` rows, plus `--required` only to annotate which rows GitHub marks required. State is derived from every reported check row. SHA-changed-mid-fetch → pending + retry. |
| **Branch cleanup per terminal** | `merged`: local deleted, remote left to GitHub. `closed_unmerged`: both deleted. `cancelled`: local deleted; remote retained iff PR open (or always deleted with `--close-pr`). Parked states: no cleanup until cancel. |
| **`advice_answered` not counted toward non-budget cap** | Human-input respawns are bounded by human availability and not a runaway-loop risk. The cap exists to safety-net stale GitHub signals; humans aren't a stale signal. |
| **External-input slugification** | `external_ref` is normalized via **two separate derivations** (see §13). The branch slug applies per-component rules (no leading/trailing `./-` per component, no `.lock`-suffix per component, no `..`, ≤64 chars overall) and is **gated by a final `git check-ref-format` call** — pathological inputs that survive the rules fall back to `task-<task_id_short>`. The tmux identifier applies a stricter charset (`[A-Za-z0-9_-]` only, human part ≤38 chars) and **always appends `-<task_id_short>`**, guaranteeing per-task uniqueness even when two distinct `external_ref`s collapse to the same human-readable tmux slug while producing different branches. The two derivations do not need to match. Verbatim form preserved in SQL for queries. |
| **Operator-controlled commands run via `/bin/sh -c`** | `agent_invocation` and `install_cmd` are deployment config; shell expansion is intentional and supported. Quay doesn't parse them beyond `{prompt_file}` substitution. External user-influenced input never feeds shell commands. |

---

## 15. Test plan

The v1 test suite must cover the following cases. Each is a state-machine integration test that drives Quay through one path and asserts the resulting state, artifacts, and events.

### Happy path

1. **Enqueue → queued → tick promotes → running → PR → CI pass → merged.** Single attempt, no retries. Asserts: enqueue lands in `queued` without spawning; first tick promotes to `running`; ticket snapshot, brief, preamble, final prompt, session log, and PR pointer all persisted; terminal state `merged`; worktree cleaned up; bare clone retained at `~/.quay/repos/<repo_id>.git`.

### Worker outcomes

2. **Worker writes `.quay-blocked.md` mid-task.** Tick ingests, transitions to `awaiting-next-brief`. Asserts: blocker artifact persisted, file deleted from worktree after SQL commit, content-hash recorded, no outbound communication to orchestrator (pull-only).
3. **Worker dies without a PR and without a blocker.** Generic crash retry. Asserts: budget consumed, new attempt spawned, same worktree.
4. **Worker stuck (alive, log not moving).** Stale kill. Asserts: `kill` called, retry with staleness diagnostics, budget consumed.

### CI / PR

5. **CI fails on the PR.** Asserts: CI excerpt artifact, retry with deterministic brief, budget consumed.
6. **CI passes, PR sits, human merges.** Transition through `done` → `merged`.
7. **CI passes, PR sits, human closes without merge.** Transition through `done` → `closed_unmerged`.
8. **Reviewer marks `CHANGES_REQUESTED`.** Asserts: review comments artifact, re-queue with deterministic review brief, budget **not** consumed.
9. **Merge conflict appears in `done`.** Asserts: conflict slice artifact, re-queue with deterministic conflict brief, budget **not** consumed.
10. **Force-push to PR branch mid-task.** Tick picks up the new SHA's CI run cleanly without confusion.

### Escalation

11. **Orchestrator claims, then calls `quay escalate-human`.** Asserts: claim transition, `slack_escalation_post` artifact written with `escalation_seq` and `escalation_nonce`, transition to `waiting_human`, `claim_id` preserved, **no Slack API call made by the CLI or tick for that claim-held row**.
11a. **Orchestrator records a human reply and submits a brief.** Asserts: `record-human-reply` writes `slack_reply`, transitions `waiting_human` → `claimed-by-orchestrator` with the same `claim_id`, and `submit-brief --reason advice_answered` transitions to `queued` while completing the original handoff.
11b. **Legacy waiting_human without a thread is not stranded.** Setup: claimless `waiting_human` row with `slack_thread_ref IS NULL`. Asserts: tick transitions it to `awaiting-next-brief` and enqueues a `manual_resume` handoff.
12. **Legacy tick polls `waiting_human`, ingests a Slack reply.** Setup: claimless legacy row with a thread. Asserts: reply artifact, transition to `awaiting-next-brief` (no push; orchestrator picks up via its own pull).
13. **Retry budget already exhausted at blocker ingest.** Worker on the final allowed attempt writes `.quay-blocked.md`. Asserts: tick ingests blocker, sets `budget_exhausted = true`, persists `last_failure` artifact, transitions to `awaiting-next-brief`. Orchestrator's pull surfaces the flag. Calling `submit-brief --reason blocker_resolved` errors. `submit-brief --reason advice_answered` is still permitted. `escalate-human` and `cancel` succeed normally.

### Pull and claim semantics

14. **Orchestrator pulls `awaiting-next-brief`, claims, submits brief.** Happy path. Asserts: claim transition, claim cleared on submit, retry budget consumed, `claim_expirations_consecutive` reset to 0.
15. **Two concurrent `quay task claim` calls on the same task.** One succeeds; the other errors cleanly. Asserts: only one orchestrator instance proceeds; task stays in `claimed-by-orchestrator` exactly once.
16. **Orchestrator claims, then crashes without calling submit-brief or release-claim.** Asserts: tick auto-releases the claim back to `awaiting-next-brief` after `claim_timeout_seconds`; `claim_expired` event is logged; `claim_expirations_consecutive` increments; next pull surfaces the task again.
17. **Orchestrator claims, then explicitly releases via `quay task release-claim`.** Asserts: task returns to `awaiting-next-brief`; idempotent on repeated release.
18. **`quay task list --state awaiting-next-brief` does not return claimed tasks.** Asserts: pull naturally excludes in-flight work.
19. **`quay submit-brief` on a task in `awaiting-next-brief` (not claimed).** Asserts: errors with "must be claimed first." Skip-claim is rejected.
20. **Orchestrator crash-loops on a task: claim, expire, claim, expire, claim, expire.** Asserts: after `max_claim_expirations` (default 3), task transitions to `orchestrator_loop`; `orchestrator_loop_parked` event logged; tick stops cycling.
20a. **Stale claimant cannot mutate a re-claimed task (claim_id ownership fence).** Setup: orchestrator A claims task → receives `claim_id_A`. A stalls (does not call submit-brief). Tick auto-releases the claim after timeout, clearing `tasks.claim_id`. Orchestrator B claims the same task → receives a fresh `claim_id_B != claim_id_A`. A wakes up and calls `quay submit-brief --claim-id <claim_id_A>`. Asserts: A's call errors with `claim_lost`; the task is unchanged from B's claim; A is told to abandon and re-claim. Same assertion for `quay escalate-human --claim-id <claim_id_A>` and `quay task release-claim --claim-id <claim_id_A>` issued by A.
20b. **Cancellation in flight fences out claim-scoped writes.** Setup: orchestrator claims task → receives `claim_id`. Operator runs `quay cancel`. Orchestrator (unaware) calls `submit-brief --claim-id <claim_id>`. Asserts: the call errors with `cancelled` (not `claim_lost`, not `wrong_state`) — distinguishable from claim-loss so the orchestrator knows to abandon entirely. Same for `escalate-human`.
20c. **Cancel cannot acquire a claim that races against it.** Setup: task in `awaiting-next-brief`; operator runs `quay cancel` (writes `cancel_requested_at`). A racing `quay task claim` errors with `cancelled` because the claim predicate includes `cancel_requested_at IS NULL`. Asserts: no claim is issued; the cancel finalizer proceeds to terminal without orchestrator interference.
20d. **`release-claim` with mismatched claim_id is distinguishable from already-released.** Setup: orchestrator A claims (receives `claim_id_A`); claim times out and is auto-released; orchestrator B claims (receives `claim_id_B`); A calls `release-claim --claim-id <claim_id_A>`. Asserts: A's release errors with `claim_lost` (NOT idempotent no-op success); B's claim is unaffected. Contrast: `release-claim` on a task already in `awaiting-next-brief` (no live claim at all) is the canonical no-op success and does NOT validate `claim_id`.

### Budget exhaustion and wall-clock

21. **Retry budget consumed on every attempt up to cap.** Asserts: at attempt `retry_budget`, Quay does not respawn; sets `budget_exhausted = true`; transitions to `awaiting-next-brief`; persists `last_failure` artifact; orchestrator's pull surfaces the flag.
22. **Worker runs longer than `max_attempt_duration_seconds` while logging actively.** Asserts: tick kills the worker; emits `wall_clock_exceeded` event; retries with deterministic wall-clock template; consumes budget.
23. **Quay's deterministic retry brief on attempt N includes the most recent brief, not the initial brief.** Asserts: orchestrator-composed brief from a prior `submit-brief` is preserved through subsequent CI-fail retries.

### Cancellation

24. **`quay cancel` on a `running` task.** Worker killed, worktree cleaned, PR (if any) left alone, branch retained iff PR is open. Terminal `cancelled`.
25. **`quay cancel --close-pr` on a `done` task.** PR closed via `gh`, worktree cleaned. Terminal `cancelled`.
26. **`quay cancel` on a terminal task.** Two sub-cases: (a) on `cancelled` → idempotent no-op success, no second `cancelled` event, no SQL writes. (b) on `merged` or `closed_unmerged` → errors with `wrong_state` and the observed terminal state in the error payload; no SQL writes; no side effects.
27. **`quay cancel` on a task whose worktree is missing.** Forgiving — task transitions to `cancelled` regardless.
28. **`quay cancel` on a `claimed-by-orchestrator` task.** Cancellation succeeds; claim is implicitly cleared as part of the terminal transition.
29. **`quay cancel` on an `orchestrator_loop` task.** Cancellation succeeds; standard cleanup runs.
29a. **`quay cancel` crash on `running` between intent write and finalizer.** Inject a process kill immediately after `cancel_requested_at` and `kill_intent = 'cancel'` are committed and `tmux kill-session` returns, but before the synchronous finalizer's terminal transition. State observed: task in `running`, `cancel_requested_at` set, attempt has `kill_intent = 'cancel'`, tmux session dead. Asserts: next `quay tick`'s top-of-loop check observes `cancel_requested_at IS NOT NULL`, calls `cancel_finalizer`, drives the task to `cancelled`; the task is **never** left stuck in `running`.
29b. **Cancel finalizer is idempotent on `cancelled`.** Re-invoking the finalizer (or running `quay cancel` again) on a task already in `cancelled` returns success without modifying state. Asserts: no second `cancelled` event; no second `session_log` artifact (content-hash idempotent); no errors.
29c. **`quay cancel --close-pr` on `done` survives crash after irreversible side effects.** Setup: task in `done` with an open PR; CI passing. Operator runs `quay cancel --close-pr`. The CLI commits `cancel_requested_at = now()`, `cancel_close_pr = 1`. The finalizer's step 3 calls `gh pr close` (the PR is now closed on GitHub) and `git push --delete origin <branch>` (remote branch is gone) — then a process kill is injected before step 4 (the SQL terminal transition). Asserts: next tick's top-of-loop check observes `cancel_requested_at IS NOT NULL` and re-enters the finalizer regardless of `tasks.state` still being `done`; step 1 is a no-op (no live worker); step 2 collects no new log (already done); step 3 re-runs cleanup idempotently (`gh pr close` on an already-closed PR is a no-op success; `git push --delete` on an already-deleted branch returns "remote ref does not exist," logged but not fatal); step 4 transitions `state → cancelled`, writes `cancelled` event. Regression-asserts that the operator's terminal intent is preserved across crash even after irreversible external state changes — *no path leads to the task being mis-classified as `closed_unmerged`* (which would have happened under the prior design's running-only recovery, since the next tick's `done` handler observed the closed PR and would have routed it through the closed-PR branch).
29d. **`quay cancel` from `claimed-by-orchestrator`.** Operator cancels while the orchestrator holds the claim. Asserts: `cancel_requested_at` persisted; finalizer runs; task reaches `cancelled`; the claim is implicitly cleared as part of the terminal transition (no separate `release-claim` needed). On a subsequent crash injection between intent write and finalizer completion, the next tick recovers via the top-of-loop check; the orchestrator's still-pending `submit-brief` / `escalate-human` against this task errors with `wrong_state`.
29e. **`quay cancel` from `waiting_human`.** Operator cancels while a Slack escalation is pending. Asserts: `cancel_requested_at` persisted; finalizer runs; the pending `slack_escalation_post` artifact is preserved (no rollback) and the Slack thread is left as-is (Quay does not "un-post" the question — that's a human-readable record of what was asked); task reaches `cancelled`. Crash recovery same as above.
29f. **`quay cancel` on a parked state (`worktree_error` / `orchestrator_loop` / `non_budget_loop`).** Asserts: `cancel_requested_at` persisted; finalizer runs; state transitions to `cancelled` (overriding the parked retention per §5 cleanup matrix); branch/worktree cleanup applies per the `cancelled` row of the matrix.
29g. **`quay cancel` on `merged` / `closed_unmerged` errors with `wrong_state`.** Asserts: no SQL writes; CLI returns a structured error with the observed terminal state; operator can distinguish "already done, no action needed" from a real failure.

### Crash safety

30. **Tick crash between blocker artifact write and file delete.** Next tick re-ingests; content-hash idempotency prevents duplicate artifact rows.
31. **Tick concurrency: second `quay tick` invoked while first is running.** Second exits cleanly without action (supervisor lockfile held by the first).
31a. **`quay cancel` blocks on an in-flight tick.** A `quay tick` is mid-cycle holding the supervisor lock. Operator runs `quay cancel <task_id>`. Asserts: `quay cancel` blocks on lock acquisition until the tick releases; once acquired, cancel writes `cancel_requested_at` and runs the finalizer; the in-flight tick's transitions on the same task either committed before cancel acquired (acceptable: cancel still runs the finalizer afterward and converges to `cancelled`) or were rejected by the tick-owned `cancel_requested_at IS NULL` predicate (unreachable here since cancel hadn't yet acquired the lock or written intent — included for completeness against the next-tick re-entry).
31b. **Cancel races a legacy `waiting_human` Slack post (regression for the original race).** Setup: tick holds the lock and is in the legacy `waiting_human` handler for task T; it has captured the pre-post fence and is about to call the Slack API. Operator runs `quay cancel <task_id>`. Asserts: `quay cancel` blocks on the lock; tick completes its `waiting_human` step (fence + post + reply-poll) under the lock; cancel acquires after tick releases and runs the finalizer. The Slack post is *not* re-issued by cancel (cancel doesn't post). The task transitions to `cancelled`; the `slack_escalation_post` artifact is preserved for forensics; the Slack thread retains the question (Quay does not unpost). Specifically asserts: there is exactly one Slack post for this escalation, regardless of which side won the race; tick's reply-poll on a *now*-cancelled task is impossible because the lock blocked it from running concurrently with the finalizer.
31c. **Cancel races `queued → running` mid-spawn.** Setup: tick holds the lock and is in the `queued` handler for task T; it has just committed the SQL promotion (`spawned_at = now()`, `state = running`) and is about to perform substrate work (write `.quay-prompt.md`, `tmux new-session`, `tmux send-keys`). Operator runs `quay cancel <task_id>`. Asserts: cancel blocks on the lock; tick completes the substrate spawn under the lock (so the worker actually starts); tick releases; cancel acquires and runs the finalizer, which kills the freshly-spawned tmux session at step 1 and proceeds through to `cancelled`. The task is *never* observed in a half-spawned state by any other process. Alternative scenario (pure SQL race, the belt-and-suspenders case): tick has read state but has not yet committed the promotion transaction; cancel somehow holds the lock (e.g., test injects a stale-lock takeover). Tick's promotion `WHERE state = 'queued' AND cancel_requested_at IS NULL` returns rowcount=0; tick aborts substrate spawn for this task this cycle and continues to the next; cancel's finalizer runs without contention.
31d. **Stale lock recovery.** Inject a tick that crashes (kill -9) while holding the lockfile. Operator runs `quay cancel`. Asserts: `cancel` observes the stale PID (lockfile holds a now-dead PID), waits for `supervisor_lock_stale_seconds` (default 30 s), reclaims, and proceeds. Without the stale-lock recovery, this would be a permanent block.
31e. **Tick rowcount=0 on cancel-in-flight aborts the task for the cycle.** Inject the lock acquisition order: tick acquires, reads task T's state (`pr-open`), is about to commit a `pr-open → done` transition; before the commit fires, simulate concurrent intent (test-only: insert `cancel_requested_at` directly into the row, bypassing the supervisor lock). Tick's update `WHERE state = 'pr-open' AND cancel_requested_at IS NULL` returns rowcount=0. Asserts: tick logs `tick_error` for this task, continues to the next; the next tick observes `cancel_requested_at IS NOT NULL` at the top of the loop and runs the cancel finalizer. (This test exercises the SQL predicate directly; in real operation the lock prevents the simulated condition.)
32. **Per-task error in tick (e.g., GitHub API 500 on one task).** Other tasks continue to be processed; failing task gets `tick_error` event; next tick clears and retries.

### Substrate

33. **`quay enqueue` against a repo not registered.** Errors cleanly.
34. **`quay submit-brief` on a task in `running` (not `claimed-by-orchestrator`).** Errors cleanly.
35. **Capacity cap (`max_concurrent` reached).** New task registered as `queued`; tick promotes when a slot opens.
36. **Total cap (`max_total` reached).** `quay enqueue` errors with the current task list.
37. **First enqueue against a repo whose bare clone is missing throws `bare_clone_missing` with the expected path; subsequent enqueues with the clone present succeed.** Asserts: enqueue without a pre-materialized bare clone at `<repos_root>/<repo_id>.git` errors with `QuayError("bare_clone_missing")`, includes the expected path and a remediation hint; once the clone is materialized by the operator (or test setup), enqueue completes successfully.
38. **`install_cmd` runs once per worktree, not once per attempt.** Asserts: install runs before attempt 1; subsequent retries on the same worktree (`ci_fail`, `blocker_resolved`) do not re-run install.
39. **Branch naming uses the §13 git-safe slug.** Enqueue with `--external-ref ITRY-900` → branch named `quay/ITRY-900`. Enqueue with `--external-ref feat/ABC.123` → `quay/feat/ABC.123`. Enqueue with no `external_ref` (or one that normalizes to empty, e.g. `...`) → `quay/task-<task_id_short>`.
40. **Branch-name collision on re-enqueue after cancel — remote-only retention.** After a `cancelled` task whose **local** branch was deleted but **remote** branch was retained (because a PR was open at cancel time per §5 cleanup rules), re-enqueuing the same `external_ref` must NOT reuse the same branch name. Asserts: branch resolution checks remote heads (`git ls-remote`) and open PRs (`gh pr list --head <branch> --state open`) in addition to the local bare clone; the new task gets `quay/<branch_slug>-<task_id_short>`; the new worker's first push does NOT update the prior PR.

40a. **Branch resolution catches an open PR even when the remote branch was deleted.** Setup: prior task ended in `closed_unmerged` (rare timing — both branches deleted), but a human reopened the PR on the GitHub side. Asserts: `gh pr list --head <branch> --state open` returns the PR; resolution applies the suffix.
41. **`escalate-human` without `--thread-ref` and without enqueue-time `--slack-thread-ref`.** Errors with "no Slack thread configured."
42. **`escalate-human --thread-ref X` overrides task's enqueue-time thread.** Asserts: the override ref is used and persisted.

### Crash-safety and side-effect recovery

43. **Tick crash AFTER blocker artifact write but BEFORE event/state update.** Next tick computes content_hash, finds existing artifact row, reuses it (no duplicate insert), then writes the missing event/state and deletes the file. Asserts: exactly one artifact row, exactly one event row, file removed, task in `awaiting-next-brief`.
44. **Tick crash AFTER artifact + event write but BEFORE file delete.** Next tick deletes the file (idempotent on missing); no duplicate artifact or event written. Asserts: convergence to expected post-condition without state corruption.
45. **Spawn failure (tmux create errors), no worker evidence.** Substrate `tmux new-session` fails outright; no worker ever started, so there is no orphan session, no signal file, no remote progress. Recovery classifier finds no evidence; takes the substrate-failed default. Asserts: `attempts.exit_kind = 'spawn_failed'`; budget rolled back if `consumed_budget = 1`; `spawn_failures_consecutive` incremented; fresh scheduled attempt row inserted; task back to `queued`.
46. **DB update fails after tmux session created — no-evidence sub-case.** Step 3 of the spawn rules created the tmux session, but step 4 (write `tmux_session` to DB) failed. The worker exited immediately on its own (e.g., agent CLI errored) before pushing or writing a signal. Next tick observes `tmux_session = NULL`, runs evidence classifier: no `.quay-blocked.md`, no remote progress, no PR. Falls through to substrate-failed default. Asserts: orphan tmux session is killed; `attempts.exit_kind = 'spawn_failed'`; budget rolled back; fresh attempt scheduled; task back to `queued`.
46a. **DB update fails after tmux session created — worker opened a PR (regression test).** Step 3 succeeded; the worker started, pushed the branch, and called `gh pr create`, opening PR #N. Then step 4 (DB write of `tmux_session`) failed and tick crashed. Next tick observes `running` with `tmux_session = NULL`. Recovery: kills the orphan canonical-name tmux session (worker has already exited cleanly, but the kill is idempotent); collects session log; runs evidence classifier — finds `pr_existed_at_spawn = 0`, `pr_exists_at_exit = 1` → `no_progress = false` via the "PR opened during this attempt" clause. Asserts: `attempts.exit_kind = 'pr_opened'` (NOT `spawn_failed`); `attempts.remote_sha_at_exit` recorded; transition → `pr-open`; **budget is preserved** (not rolled back); `spawn_failures_consecutive` reset to 0 (evidence-found outcome). Regression test for the prior design that would have killed the productive worker, marked `spawn_failed`, and lost the link between Quay's state and the real PR.
46b. **DB update fails after tmux session created — worker pushed but did not open a PR.** Step 3 succeeded; worker pushed commits to the branch, then died. PR has not been opened. Next tick observes `tmux_session = NULL`, runs evidence classifier: no signal file, `remote_sha_at_exit != remote_sha_at_spawn`, `pr_exists_at_exit = 0`. The progress predicate evaluates: `(remote_sha_at_exit != remote_sha_at_spawn)` so the first `no_progress` clause is false → `no_progress = false`; but `pr_exists_at_exit = 0` so the `pr_exists_at_exit AND not no_progress` branch is not taken either. Falls through to the substrate-failed default. Asserts: `attempts.exit_kind = 'spawn_failed'`; budget rolled back; fresh attempt scheduled. (Note: this is a deliberate behavior — without a PR, there's nothing for tick to track in `pr-open`. The pushed commits remain on the remote branch and will be picked up by the next attempt's `remote_sha_at_spawn`.)
46c. **DB update fails after tmux session created — worker wrote a blocker file.** Step 3 succeeded; worker started, decided it couldn't proceed, wrote `.quay-blocked.md`, exited. Next tick observes `tmux_session = NULL`, runs evidence classifier: `.quay-blocked.md` exists and is valid. Asserts: blocker is ingested as an artifact; `attempts.exit_kind = 'blocker_written'`; transition → `awaiting-next-brief`; **budget is preserved** at promotion's accounting (a future `submit-brief --reason blocker_resolved` consumes one unit at its own promotion); `spawn_failures_consecutive` reset to 0.
47. **Legacy Slack post fails after step-3 SQL commit.** Step 3 committed (artifact has `slack_pre_post_fence_ts`, `escalation_seq`, `escalation_nonce` set; `slack_post_ts = NULL`, `slack_recovered_post_ts = NULL`); step 4 (the actual API post) failed. Next tick: nonce-recovery search returns no match (no bot post exists); re-post path executes; `slack_post_ts` and `slack_recovered_post_ts` both set in one txn. Asserts: exactly one Slack post visible after recovery; no infinite re-posting; `slack_pre_post_fence_ts`, `escalation_seq`, `escalation_nonce` unchanged.

48. **Legacy Slack post succeeds but step-5 SQL update fails — no duplicate post.** Step 4 returned ts1 but step 5 never committed; `slack_post_ts` and `slack_recovered_post_ts` both NULL locally, post visible in Slack carrying the nonce. Inject a real reply at `ts_reply` with `ts_reply > ts1`. Next tick: nonce-recovery search returns the bot message at ts1; `slack_recovered_post_ts` set to ts1 in one SQL txn; **no re-post is performed**; reply at `ts_reply > ts1` ingested. Asserts: zero duplicate posts (regression test for the previous design that always re-posted); the reply is ingested correctly; Slack search rate cost is bounded (one search per tick until recovery succeeds).

48a. **Legacy second escalation on the same attempt is not deduped.** On the same attempt, `escalate-human` once (seq=1, nonce=N1, body=Q1), Slack reply ingested by the legacy path, then orchestrator re-claims and `escalate-human` a second time with the *same* body Q1 (seq=2, nonce=N2). Asserts: two distinct `slack_escalation_post` artifact rows exist (different `content_hash` because seq + nonce differ); each carries its own nonce in the visible Slack post; reply ingestion against the second escalation uses the second escalation's `slack_recovered_post_ts`, not the first's.

48b. **Legacy pre-fence chatter is excluded as the answer when post lands quickly.** Inject thread chatter at `ts_chat` with `ts_chat < slack_pre_post_fence_ts`. Then complete the post sequence cleanly. Next tick: `slack_recovered_post_ts > slack_pre_post_fence_ts > ts_chat`; chatter is not eligible (well below either lower bound). Asserts: the chatter is NOT ingested as the human reply; first real post-escalation reply is.

48c. **Inter-window chatter is excluded once recovery completes.** Step 4 returned ts1, step 5 failed. A real human reply lands at `ts_reply > ts1`. Unrelated chatter (from another thread participant, not addressing Quay) lands at `ts_chat` with `slack_pre_post_fence_ts < ts_chat < ts1`. Asserts: on the recovery tick, `slack_recovered_post_ts = ts1`, so `ts_chat` is no longer eligible (`ts_chat < ts1`); only `ts_reply` is ingested. (Without recovery, the prior design would have used the fence and incorrectly admitted `ts_chat`.)

### Non-budget retry dedup

48. **`CHANGES_REQUESTED` stays sticky on GitHub after Quay's review respawn.** Asserts: tick observes the same `latest_review_id` on subsequent ticks; does NOT re-respawn (matches `last_review_id_acted_on`).
49. **New review filed after a review respawn.** Asserts: new `latest_review_id` triggers a fresh review respawn; `last_review_id_acted_on` updated; `non_budget_respawns_consumed` incremented.
50. **Same conflict polled repeatedly without push.** Asserts: tick does NOT re-respawn (`last_conflict_observation` matches `head_sha:base_sha`).
51. **Conflict re-respawned after a force-push that didn't resolve it.** Asserts: new head_sha → new observation → fresh respawn.
52. **Non-budget safety cap (off-by-one boundary).** Set `max_non_budget_respawns = 3`. Synthetically trigger 4 distinct review or conflict events (each with a fresh dedupe key). Asserts: respawns #1, #2, #3 are scheduled normally and `non_budget_respawns_consumed` ticks 1→2→3; on event #4, the increment to 4 exceeds the cap and the task transitions to `non_budget_loop`; `non_budget_loop_parked` event logged; counter is recorded as 4 (post-increment, for forensics); tick stops cycling. Confirms the rule "cap N allows N respawns, parks on the (N+1)th."

### `pr-open` PR state polling

53. **PR merged while in `pr-open` (CI still pending).** Asserts: tick detects merged state, transitions through to `merged`, cleanup runs.
54. **PR closed-unmerged while in `pr-open`.** Asserts: terminal `closed_unmerged`.

### Bootstrap

55. **`quay enqueue` against a fresh repo runs full bootstrap.** Asserts: bare clone created, fetch run, worktree created, install_cmd run, all before enqueue returns.
56. **`quay enqueue` against an already-cloned repo skips clone but still fetches.** Asserts: existing bare clone reused; fetch always runs.
57. **`quay enqueue` aborts cleanly on bootstrap failure.** E.g., install_cmd exits non-zero. Asserts: no task row created; worktree removed; branch deleted; orchestrator gets a clear error.

### Spawn-path unification

58. **`submit-brief` transitions to `queued`, not `running`.** Asserts: after `submit-brief`, task is in `queued`; tick promotes on its next cycle.
59. **Capacity cap enforced on respawn paths.** With `max_concurrent = 1`: task A in `running`, task B writes a blocker, orchestrator submits new brief for B. Asserts: B sits in `queued` until A reaches `pr-open`; only then does tick promote B.
60. **Quay-driven retry transitions to `queued`.** CI-fail on a PR. Asserts: task returns to `queued` with a deterministic `ci_fail` brief written to attempt N+1's row; tick promotes; budget consumed only at promotion.

### Substrate spawn failure

61. **Single spawn failure (tmux create errors), no worker evidence.** Asserts: `attempts.exit_kind = 'spawn_failed'`; `attempts_consumed` decremented (rolled back); task back to `queued`; `spawn_failures_consecutive` incremented.
62. **`max_spawn_failures` consecutive *no-evidence* substrate failures.** Asserts: task transitions to `worktree_error`; manual recovery via `quay cancel`. The counter only counts no-evidence outcomes — evidence-found recoveries (PR opened, blocker written) reset it.
63. **Successful spawn (or evidence-found recovery) resets the counter.** Asserts: `spawn_failures_consecutive = 0` after the next worker actually starts logging *or* after any evidence-found recovery (PR opened during the spawn-window crash, blocker written, etc.).

### Slack reply cursor

64. **Pre-existing chatter in the escalation thread is ignored.** Thread has older messages from before Quay captured the pre-post fence; tick only ingests replies with `ts > slack_pre_post_fence_ts`. Asserts: stale reply not ingested; first new reply is.

### Brief / final_prompt artifact invariant

65. **Every attempt has exactly one brief and one final_prompt artifact.** Across initial spawn and 3 retry paths (CI-fail, review feedback, blocker_resolved). Asserts: `SELECT COUNT(*) FROM artifacts WHERE attempt_id = X AND kind = 'brief'` is 1 for every attempt, ditto `final_prompt`.

### CI status rules

66. **`ci_workflow_name` set; unrelated failing workflows still block.** Asserts: a passing named workflow plus a failing different workflow triggers `ci_fail` retry.
67. **`ci_workflow_name` unset; any reported failure blocks.** Asserts: with one non-required check failed and no required checks, status = fail.
68. **No check rows reported at all.** Asserts: status = pass; transitions to `done`.
69. **Stale check runs against earlier SHA ignored.** After force-push, old runs against the prior SHA do not affect status determination.

### Read-command JSON shape

70. **`task list` with no matches returns `[]`.** Asserts: literal empty JSON array on stdout.
71. **`task get` returns a single object, not an array.** Asserts: stdout starts with `{` and includes `slack_thread_ref` for orchestrator Slack routing.
72. **`tick` emits NDJSON, one task per line.** Asserts: each line independently parses as a JSON object.

### PR idempotency and per-attempt SHA tracking

73. **Retry attempt creates no duplicate PR.** Worker on attempt N crashes after pushing; PR exists. Worker on attempt N+1 pushes more commits without calling `gh pr create` again. Asserts: still exactly one PR; `remote_sha_at_exit != remote_sha_at_spawn` on attempt N+1; transition → `pr-open`.
74. **Retry attempt with no remote progress is classified as no-progress, not pr-open.** Three sub-cases, each must be classified as `no_progress`:
    a) Worker on attempt N+1 spawns, exits without committing or pushing. Local HEAD unchanged, remote unchanged.
    b) Worker on attempt N+1 commits locally but crashes before `git push`. Local HEAD advanced, remote unchanged. (This is the case local-HEAD comparison would have missed.)
    c) Worker on attempt N+1 attempts to push but the push fails (network, permissions). Local HEAD advanced, remote unchanged.
    Asserts (each sub-case): `remote_sha_at_exit == remote_sha_at_spawn`; `attempts.exit_kind = 'no_progress'`; deterministic `crash` retry scheduled, NOT a `pr-open` transition.
74b. **First-attempt push transitions cleanly to pr-open.** Worker on attempt 1 pushes for the first time (remote_sha_at_spawn was NULL because the branch didn't exist remotely yet). Asserts: `remote_sha_at_exit IS NOT NULL`; transition → `pr-open` (the NULL → SHA case is treated as progress).
74c. **PR opened during this attempt counts as progress, even if no further pushes happened.** Setup: attempt N pushed the branch then crashed before `gh pr create` — so attempt N exited with `no_progress` (remote advanced, no PR yet) and got a deterministic retry. Attempt N+1 spawns: `remote_sha_at_spawn` matches what attempt N pushed, `pr_existed_at_spawn = 0`. Worker N+1 does not push more commits but does call `gh pr create` and exits cleanly. Asserts: `remote_sha_at_exit == remote_sha_at_spawn` (unchanged), `pr_existed_at_spawn = 0`, PR exists at exit → `no_progress = false` via the "PR was opened during this attempt" clause; `attempts.exit_kind = 'pr_opened'`; transition → `pr-open` (NOT misclassified as `no_progress` and NOT scheduling a `crash` retry).
74d. **Agent exit ends the tmux session — clean PR-open is not mis-classified as stale.** Spawn a worker; the agent process pushes, opens a PR, and exits with status 0. Asserts: within one tick after the agent exits, `tmux has-session -t <session_name>` returns non-zero (the `exec sh -c` wrapping ensures the pane dies with the agent); next tick takes the dead-worker branch; `attempts.exit_kind = 'pr_opened'`; transition → `pr-open`. Regression-asserts: NO `kill_intent` was set (i.e., this was a natural exit, not a stale or wall-clock kill); the attempt's elapsed time is well under `staleness_threshold_seconds` and `max_attempt_duration_seconds`. This guards against the historical hazard where `tmux send-keys "<cmd>" C-m` left an interactive shell behind that kept the session alive after the agent exited.
74e. **Operator-misconfigured `agent_invocation` that backgrounds itself is detected.** Configure `agent_invocation = "claude --prompt-file {prompt_file} &"` (deliberate misconfig — backgrounds the agent into the parent shell). Spawn a worker. Asserts: the session is reported alive by `tmux has-session` long after the agent exited; eventually a `staleness` or `wall_clock` kill fires. This test exists to document the failure mode the spec warns against, not to claim Quay handles it gracefully — a deployment with a backgrounding `agent_invocation` is broken by configuration.

### Spawn-failure recovery from `running` state

75. **Tick crashed mid-spawn (state = running, tmux_session = NULL) — evidence-first recovery.** Next tick observes the missing session and runs the evidence classifier (kill orphan, collect log, check signal file, fetch remote, check PR). Outcome depends on what the worker did before the crash:
    a) No worker evidence → marks `spawn_failed`, rolls back budget if `consumed_budget = 1`, schedules a fresh attempt, transitions back to `queued`. `spawn_failures_consecutive` increments. (See tests 45, 46, 46b.)
    b) Worker opened a PR → `exit_kind = 'pr_opened'`, transition → `pr-open`, budget preserved, `spawn_failures_consecutive` reset. (See test 46a.)
    c) Worker wrote `.quay-blocked.md` → `exit_kind = 'blocker_written'`, transition → `awaiting-next-brief`, budget preserved, `spawn_failures_consecutive` reset. (See test 46c.)
    d) PR existed at spawn and remote did not advance → `exit_kind = 'no_progress'`, schedule `crash` retry, transition → `queued`, budget preserved at promotion's accounting (the retry consumes one unit at its own promotion).
    Asserts: convergence to the right outcome per evidence; budget is rolled back **only** in sub-case (a); `spawn_failures_consecutive` increments only in (a) and resets in (b)/(c).

### CI source-of-truth specifics

76. **`gh pr view --json headRefOid` returns SHA X; `gh pr checks` returns runs against SHA Y.** Asserts: tick treats this as a stale read (SHA mismatch), logs `tick_error`, does not transition.
77. **`ci_workflow_name` set, target workflow's run buckets are all `pass`, other workflows fail.** Asserts: status = fail; transition → `queued` via deterministic `ci_fail`.
78. **`ci_workflow_name` unset, all required checks bucket = `pass`, non-required check bucket = `fail`.** Asserts: status = fail; transition → `queued` via deterministic `ci_fail`.

### Branch cleanup matrix

79. **`merged` terminal: local branch deleted; remote untouched.** Asserts: bare-clone branch gone; remote presence unchanged from GitHub auto-delete behavior.
80. **`closed_unmerged` terminal: both branches deleted.** Asserts: bare-clone branch gone; `git push origin --delete` executed.
81. **`cancelled` with PR open: local deleted, remote retained.** Asserts: bare-clone branch gone; remote intact (PR still openable).
82. **`cancelled --close-pr`: both deleted.** Asserts: full cleanup.

### Non-budget accounting

83. **`advice_answered` respawn does NOT increment `non_budget_respawns_consumed`.** Asserts: counter unchanged after a Slack-reply-driven respawn; only `review` and `conflict` reasons increment it.

### Input normalization and command execution

84. **Adversarial `external_ref` slugged before use.** Enqueue with `--external-ref "evil; rm -rf /"`. Asserts: branch name matches `[A-Za-z0-9._/-]+` and passes `git check-ref-format refs/heads/<branch>`; tmux session name matches `[A-Za-z0-9_-]+` (no `/`, no `.`); no shell metacharacters survive in either; SQL row stores verbatim original.
85. **`external_ref` longer than 64 chars truncated.** Asserts: branch slug is ≤ 64 chars; tmux human-part ≤ 38 chars (with the `-<task_id_short>` suffix the full tmux_id is ≤ 47 chars); truncation never leaves a trailing `/`, `.`, or `-` on the branch slug, and never leaves a trailing `-` on the tmux human-part; verbatim form preserved in `tasks.external_ref`.
85a. **Adversarial `external_ref` violating git ref rules normalized.** Enqueue with each of `..foo..bar.lock`, `/leading/slash/`, `foo/.bar`, `foo/bar.lock/baz`, `foo/bar.`. For each: assert the resulting branch slug passes `git check-ref-format refs/heads/quay/<slug>`; specifically that no component starts with `.`, no component ends with `.`, no component ends with `.lock`, no `..` appears, no leading/trailing `/`.
85b. **Empty-after-normalization `external_ref` falls back.** Enqueue with `--external-ref "..."`, `--external-ref "////"`, and `--external-ref ".lock/.lock"`. Asserts: each branch falls back to `quay/task-<task_id_short>`; tmux_id becomes `task-<task_id_short>` (the human part is `task` and the suffix is `-<task_id_short>`).
85c. **Final `git check-ref-format` gate is enforced.** Inject a slug-rule bypass (test-only) that produces a slug containing a control character. Asserts: enqueue refuses to proceed; the fallback `task-<task_id_short>` form is used and re-validated. This catches future regressions where slug-rule edits drift away from `git check-ref-format`.
85d. **Tmux-id collision across distinct branch slugs is impossible.** Enqueue two tasks with `external_ref = "foo.bar"` and `external_ref = "foo/bar"` simultaneously. Asserts: the two branches are distinct (`quay/foo.bar` vs `quay/foo/bar`) so branch-collision logic does NOT engage; the two tmux human-parts both collapse to `foo-bar`; the full tmux_ids differ because each appends a unique `task_id_short` (`foo-bar-<id1>` vs `foo-bar-<id2>`); first-attempt session names `quay-task-foo-bar-<id1>-1` and `quay-task-foo-bar-<id2>-1` are distinct; spawn succeeds for both; cancel/spawn-failure recovery on either task targets the correct worker by canonical name. Regression-asserts that no shared tmux state can be touched by the wrong task's recovery path.
86. **`install_cmd` with shell expansion runs successfully.** E.g. `install_cmd = "NODE_ENV=production bun install && bun run setup"`. Asserts: shell expansion works; both commands run in sequence.

---

## 16. Open questions / deferred to v2

- **Second worker backend.** Direct subprocess (no tmux), for environments without tmux or for containerized per-task pods.
- **Remote workers.** Out-of-host worker execution; would benefit from Agent Communication Protocol (the unrelated REST spec at agentcommunicationprotocol.dev) as a wire format.
- **Push channel as latency optimization on top of pull.** v1 is pull-only. If sub-minute orchestrator response latency becomes important, push can be added as an overlay (pull stays as the correctness floor).
- **Auto-recovery from `worktree_error`.** Automatic worktree rebuild from the branch after FS or git failure. Out for v1 due to silent-data-loss risk.
- **Multiple orchestrators on one Quay deployment.** The CLI surface is forward-compatible (JSON, atomic claims arbitrate cleanly between callers), but auth/identity for distinguishing orchestrators is not in v1.
- **Training data export tooling.** Convenience commands for exporting `(brief, outcome)` and `(context, brief)` pairs for orchestrator improvement loops. The data is captured in v1; tooling to extract it is v2.
- **`quay task resume <id>`.** A complement to `cancel` for `worktree_error` recovery once auto-rebuild lands.
- **Budget pause (path 5 in early ACP doc).** Daily or per-task cost caps. Reserved in the schema's spirit but not implemented in v1.
- **Concrete agent invocation pattern.** v1 ships with a tested invocation pattern for at least one coding-agent CLI (Claude Code or Codex). Final pattern (exact flags, error handling) is pinned during implementation.
- **Project rename.** "Quay" is the v1 name. The earlier "ACP" naming collides with Agent Communication Protocol; this spec uses "Quay" throughout.

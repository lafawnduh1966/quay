# Repositories

Quay separates repo metadata from repo materialization.

## Register A Repo

```bash
quay repo add \
  --id myrepo \
  --url git@github.com:owner/myrepo.git \
  --base-branch main \
  --package-manager bun \
  --install-cmd "bun install"
```

Required fields:

- `--id`: stable repo id. Must match `[A-Za-z0-9._-]+`, cannot be `.` or `..`,
  and cannot contain path separators.
- `--url`: stored repo URL. Quay does not clone from it automatically.
- `--base-branch`: base branch for worktrees and PRs.
- `--package-manager`: stored metadata.
- `--install-cmd`: command Quay runs in each new worktree during enqueue.

Optional fields:

- `--test-cmd`
- `--ci-workflow-name`
- `--contribution-guide-path`

`ci_workflow_name` is used when classifying PR checks. The other optional
fields are stored metadata today.

## Materialize The Bare Clone

By default Quay expects:

```text
${QUAY_DATA_DIR:-~/.quay}/repos/<repo_id>.git
```

Create it yourself:

```bash
git clone --bare git@github.com:owner/myrepo.git ~/.quay/repos/myrepo.git
```

If you configured `repos_root`, clone under that directory instead:

```toml
repos_root = "/Users/me/.acc/repos"
```

```bash
git clone --bare git@github.com:owner/myrepo.git /Users/me/.acc/repos/myrepo.git
```

Quay validates that the bare clone exists before enqueueing. If it is missing,
enqueue fails with `bare_clone_missing` and prints the expected path.

## Update A Repo

```bash
quay repo update myrepo --install-cmd "bun install --frozen-lockfile"
quay repo update --id myrepo --ci-workflow-name "CI"
```

The implementation accepts nullable values for optional fields through JSON
input. For shell flag use, prefer setting a new non-empty value. Use
`repo export`, edit JSON, and `repo import` if you need to clear optional
fields precisely.

## List, Export, And Import

```bash
quay repo list
quay repo list --active
quay repo export
quay repo export --active
quay repo export --out repos.json
quay repo import --in repos.json
```

`repo list` and `repo export` default to all rows, archived included, so
operators debugging "where did my repo go?" still see soft-deleted entries
and a `repo export` dump remains full-fidelity for restore. Pass `--active`
to either command to limit the output to repos with `archived_at IS NULL` —
the typical "which repos are in service?" question. `repo import` upserts
rows and is intended for restore workflows.

## Remove A Repo

```bash
quay repo remove myrepo
```

Remove is a soft archive. It blocks if the repo has active tasks in:

- `queued`
- `running`
- `pr-open`
- `done`
- `awaiting-next-brief`
- `claimed-by-orchestrator`
- `waiting_human`

Parked and terminal tasks keep their repo foreign key for forensics.

Re-running `repo add` with the same id reactivates an archived repo.

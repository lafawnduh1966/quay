# Quay

Bun + TypeScript implementation of the Quay task lifecycle service.

## Documentation

Start with the user-facing docs:

- User docs index: [`docs/user/index.md`](docs/user/index.md)
- Quickstart: [`docs/user/quickstart.md`](docs/user/quickstart.md)
- External services setup: [`docs/user/external-services.md`](docs/user/external-services.md)
- CLI reference: [`docs/user/cli-reference.md`](docs/user/cli-reference.md)
- Troubleshooting: [`docs/user/troubleshooting.md`](docs/user/troubleshooting.md)

The older specs and design notes are still useful implementation history, but
they have not been maintained all the way. Treat them as internal references,
not as the current user contract:

- Original lifecycle spec: [`docs/quay-spec.md`](docs/quay-spec.md)
- Validator spec: [`docs/quay-spec-ticket-validation.md`](docs/quay-spec-ticket-validation.md)
- Linear/Slack adapter spec: [`docs/quay-spec-deployment-adapters.md`](docs/quay-spec-deployment-adapters.md)
- Build order notes: [`docs/quay-tdd-implementation-plan.md`](docs/quay-tdd-implementation-plan.md)

## Install

Quay ships as a single, statically-compiled Bun binary. No runtime is
required on the target host — `bun build --compile` bundles the
TypeScript source, all migration SQL, and the shipped default
`ticket_schema.toml` into one executable.

```bash
# Build locally from a checkout (requires Bun ≥ 1.1):
bun install
bun run build         # → dist/quay (~58 MB)
./dist/quay --version # → e.g. 0.1.0+abcdef1 (or 0.1.0+abcdef1+dirty on an unclean tree)
```

### Download a release binary

Quay is delivered as prebuilt binaries on tagged GitHub Releases. Each
`v*` tag triggers `.github/workflows/release.yml`, which builds four
artifacts and a SHA256SUMS manifest, then attaches them to the release.

Artifacts published per release:

| File                  | Target                         |
| --------------------- | ------------------------------ |
| `quay-linux-amd64`    | Linux x86_64                   |
| `quay-linux-arm64`    | Linux aarch64                  |
| `quay-darwin-amd64`   | macOS Intel                    |
| `quay-darwin-arm64`   | macOS Apple Silicon            |
| `SHA256SUMS`          | `sha256` of every binary above |

Stable URL pattern (used by the hermes-agent installer):

```
https://github.com/lafawnduh1966/quay/releases/download/<tag>/quay-<os>-<arch>
https://github.com/lafawnduh1966/quay/releases/download/<tag>/SHA256SUMS
```

Install on a Linux deployment box (`linux-amd64` shown):

```bash
set -euo pipefail

TAG=v0.1.0
BASE=https://github.com/lafawnduh1966/quay/releases/download/${TAG}

curl -fsSL -o quay         "${BASE}/quay-linux-amd64"
curl -fsSL -o SHA256SUMS   "${BASE}/SHA256SUMS"

# Verify the download against the published manifest before installing.
# `set -e` above guarantees that a failing sha256sum check aborts the
# script before `install` runs, so an unverified binary never lands on
# the host.
grep " quay-linux-amd64$" SHA256SUMS | sed 's/quay-linux-amd64/quay/' \
  | sha256sum -c -

install -m 0755 quay /usr/local/bin/quay
quay --version    # → 0.1.0+<short-sha>
```

The binary is single-file and statically compiled; nothing else needs
to be installed on the host (no Bun, no Node).

#### Verification policy

Releases ship checksums (SHA256SUMS) but are not GPG- or cosign-signed.
Trust is anchored on (a) HTTPS to `github.com` and (b) the GitHub
Actions workflow being the only producer of release artifacts (the
`release` job has `contents: write` and uploads happen via
`gh release create` on `v*` tag pushes — no manual uploads). Consumers,
the hermes-agent installer in particular, MUST fetch and check
`SHA256SUMS` against the binary they downloaded; a release tag without
a matching `SHA256SUMS` entry is invalid and must be rejected.

First invocation creates `~/.quay/` (or `$QUAY_DATA_DIR`) and applies
the embedded migrations. Migrations are idempotent; re-running `quay`
is safe.

### Upgrading

`quay tick` holds a supervisor lock at `${data_dir}/tick.lock` for the
duration of each pass. To roll a new binary forward:

1. Stop the tick driver (cron entry, systemd timer, or whatever
   schedules `quay tick`).
2. Replace the binary at its install path.
3. Re-enable the driver. The next tick picks up the new version; the
   supervisor lock guarantees no overlap with an in-flight pass.

The binary embeds its build version (`quay --version` returns
`<package version>+<git short SHA>`, or `+<sha>+dirty` if built from
an unclean tree) so an operator on a remote box can confirm what's
deployed.

### Building from source for development

```bash
bun install            # also runs scripts/embed.ts (prepare hook)
bun test
bun run typecheck
bun run quay -- task list # invoke the CLI from TS source
```

`scripts/embed.ts` regenerates `src/build/embedded.generated.ts` (the
in-binary copy of migrations + shipped schema + version stamp). The
generated file is gitignored; `bun install` and `bun run build` both
regenerate it.

## Bootstrapping a repo

Quay is a *consumer* of bare clones, not a manager. Before enqueuing
tasks against a repo, two things have to happen:

1. **Register repo metadata** with `quay repo add`:

   ```bash
   quay repo add \
     --id myrepo \
     --url git@github.com:owner/myrepo.git \
     --base-branch main \
     --package-manager bun \
     --install-cmd "bun install"
   ```

2. **Materialize the bare clone** at the path quay expects. By default
   that's `<data_dir>/repos/<repo_id>.git` (i.e. `~/.quay/repos/myrepo.git`).
   Override with `repos_root` in `~/.quay/config.toml` to put the cache
   anywhere — e.g. a shared agent-wide directory:

   ```toml
   # ~/.quay/config.toml
   repos_root = "/Users/me/.acc/repos"
   ```

   Then clone:

   ```bash
   git clone --bare git@github.com:owner/myrepo.git <repos_root>/myrepo.git
   ```

   That's the entire contract — vanilla `--bare`, no extra `git config`
   step. If the clone is missing when you `quay enqueue`, the error
   prints the exact expected path and command.

## CLI surface

```bash
quay tick                                  # one supervisor pass over the queue
quay enqueue --repo <id> --brief-file <p>  # legacy enqueue (operator-composed brief)
quay enqueue --linear-issue <ENG-1234>     # Linear-adapter enqueue (target repo
                                           # comes from the ticket's `repo:` field;
                                           # `--repo <id>` is an optional override)
quay validate-ticket [--ticket-json <p|->] [--schema-file <p>] [--quiet]
                                           # standalone validator: JSON in, JSON out
quay task get <task_id> | task list        # read commands (deterministic JSON)
quay submit-brief | escalate-human | cancel
quay artifact get <task_id> <kind>         # raw bytes to stdout
```

`quay validate-ticket` runs stateless — it does not open the DB or apply
migrations, so a malformed `~/.quay/config.toml` cannot break validation.

## Configuration

### Deployment config — `~/.quay/config.toml`

Resolution order (first match wins): `$QUAY_CONFIG_FILE`, `$QUAY_CONFIG_DIR/config.toml`,
`$QUAY_DATA_DIR/config.toml`, `~/.quay/config.toml`. A missing file is OK
(defaults apply); an unparseable or schema-invalid file is a hard error.

```toml
# Tick / supervisor knobs (see docs/user/configuration.md for the full set)
data_dir = "/var/lib/quay"
repos_root = "/Users/me/.acc/repos"     # bare-clone cache; defaults to ${data_dir}/repos
max_concurrent = 4
retry_budget = 5
agent_invocation = "claude < {prompt_file}"

# Linear/Slack adapters (see docs/user/linear-and-slack.md)
[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"          # name of the env var holding the bot token

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
# max_thread_messages = 200             # fetchThreadContext cap; default 200
```

`[adapters.linear].enabled` gates `quay enqueue --linear-issue`. Without it
the dispatcher returns `adapter_not_enabled`. A configured-but-missing
token (e.g. `LINEAR_API_KEY` unset) surfaces as `adapter_not_configured`.

### Validator schema — `ticket_schema.toml`

Resolution order (first match wins): `--schema-file <path>`,
`$QUAY_CONFIG_DIR/ticket_schema.toml`, `$HOME/.quay/ticket_schema.toml`,
shipped default at [`config/ticket_schema.toml`](config/ticket_schema.toml).
The default mirrors the `quay-config` block used by the Linear adapter, so
tag/author shape stays consistent across validation and enqueue.

### Environment variables

| Var | Purpose |
|---|---|
| `LINEAR_API_KEY` | Linear bot token (rename via `[adapters.linear].api_key_env`) |
| `SLACK_TOKEN` | Slack bot token (rename via `[adapters.slack].bot_token_env`) |
| `QUAY_DATA_DIR` | Override `~/.quay` data root (DB, worktrees, artifacts, lock) |
| `QUAY_CONFIG_DIR` | Override config + schema lookup directory |
| `QUAY_CONFIG_FILE` | Direct path to a config TOML; bypasses dir resolution |
| `QUAY_INTEGRATION_TESTS=1` | Opt in to network-backed adapter tests |

## Layout

```
migrations/       SQL migration files (read at runtime, applied in lex order)
config/           shipped defaults (ticket_schema.toml)
src/
  cli/            entry point + dispatch; production wiring lives in cli/index.ts
  core/           service API: enqueue, tick_once, claim_task, ticket_context, ...
  adapters/       LinearAdapter, SlackAdapter, GitHub CLI, tmux, local git
  validator/      pure validateTicket library + TOML schema loader
  db/             sqlite connection + migration runner
  artifacts/      artifact-store helper
  ports/          interfaces: TmuxPort, GitPort, GitHubPort, SlackPort, LinearPort, Clock, ...
tests/
  support/        harness, fakes, fixtures (test-only)
  schema/ enqueue/ tick/ claim/ cancel/ slack/ pr/ cli/ adapters/ validator/ ticket_context/ quay_config_block/
```

Tests are organized by domain. The full suite runs without network access;
the two adapter integration tests (`linear_adapter_integration.test.ts`,
`slack_adapter_fetch_thread_context.test.ts`) skip unless
`QUAY_INTEGRATION_TESTS=1` is set.

#!/usr/bin/env bun
// Quay CLI entry. Wires real adapters and a shared SQLite DB under
// $QUAY_DATA_DIR (or ~/.quay), then hands argv to dispatch().
//
// Tests do NOT import this file: they call dispatch() directly with fakes.
// Keep this entry thin.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createArtifactStore } from "../artifacts/store.ts";
import { openDatabase } from "../db/connection.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  GitHubCliAdapter,
  LocalGitAdapter,
  ShellCommandRunner,
  SlackAdapter,
  TmuxAdapter,
} from "../adapters/index.ts";
import { FileSupervisorLock } from "../core/supervisor_lock.ts";
import { SystemClock } from "../ports/clock.ts";
import { UuidIdGenerator } from "../ports/id_generator.ts";
import { loadConfig, tickOptionsFromConfig } from "./config.ts";
import { dispatch, type CliDeps } from "./dispatch.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { config } = loadConfig();
  // Spec §13: `data_dir` defaults to `~/.quay`. The QUAY_DATA_DIR env var
  // is the operator's runtime override (handy in tests / containers); the
  // config file's `data_dir` is the deployment-level default. Env wins.
  const dataDir =
    process.env.QUAY_DATA_DIR ??
    config.data_dir ??
    join(homedir(), ".quay");
  const reposRoot = join(dataDir, "repos");
  const worktreesRoot = join(dataDir, "worktrees");
  const artifactsRoot = join(dataDir, "artifacts");
  for (const d of [dataDir, reposRoot, worktreesRoot, artifactsRoot]) {
    mkdirSync(d, { recursive: true });
  }
  const db = openDatabase(join(dataDir, "quay.db"));
  const migrationsDir = resolveMigrationsDir();
  runMigrations(db, migrationsDir);
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const artifactStore = createArtifactStore({
    db,
    artifactRoot: artifactsRoot,
    clock,
  });

  const deps: CliDeps = {
    db,
    clock,
    ids,
    git: new LocalGitAdapter(reposRoot),
    github: new GitHubCliAdapter(reposRoot),
    tmux: new TmuxAdapter(),
    slack: new SlackAdapter(),
    commandRunner: new ShellCommandRunner(),
    artifactStore,
    supervisorLock: new FileSupervisorLock(
      // Spec §11: `tick_lock_path` defaults to `${data_dir}/tick.lock`. Name
      // retained for compatibility; semantically the supervisor lock that
      // serializes every tmux/Slack/gh/branch side effect across processes.
      config.supervisor_lock_stale_seconds !== undefined
        ? {
            lockfilePath:
              config.tick_lock_path ?? join(dataDir, "tick.lock"),
            staleSeconds: config.supervisor_lock_stale_seconds,
          }
        : {
            lockfilePath:
              config.tick_lock_path ?? join(dataDir, "tick.lock"),
          },
    ),
    paths: { reposRoot, worktreesRoot, artifactsRoot },
    tickOptions: tickOptionsFromConfig(config),
  };

  const io = {
    stdout: (c: string) => process.stdout.write(c),
    stderr: (c: string) => process.stderr.write(c),
  };
  const result = await dispatch(argv, deps, io);
  return result.exitCode;
}

function resolveMigrationsDir(): string {
  // Resolve relative to repo root regardless of where the CLI was invoked.
  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ error: "internal_error", message: err?.message ?? String(err) })}\n`,
  );
  process.exit(1);
});

// Spec §13: the production CLI entry must load `~/.quay/config.toml` (or
// the operator's override) before constructing dispatch deps. Tests at the
// dispatch level can't catch a regression where index.ts itself stops
// calling the loader, so we drive the real entry binary here and assert:
//
//   - a valid config file lets the CLI start up and serve a read command,
//   - an invalid config file fails loudly at startup instead of silently
//     falling back to defaults.
//
// We isolate state via QUAY_DATA_DIR + QUAY_CONFIG_FILE so the test never
// touches the operator's real `~/.quay`.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-cli-cfg-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function runCli(args: string[], extraEnv: Record<string, string>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ENTRY, ...args],
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("CLI starts up with a well-formed config file present", () => {
  const dataDir = tempDir();
  const configPath = join(tempDir(), "config.toml");
  writeFileSync(
    configPath,
    `agent_invocation = "claude --custom < {prompt_file}"
max_concurrent = 3
supervisor_lock_stale_seconds = 45
`,
  );
  // `task list` is a read command — no tasks, no tmux/git dependencies,
  // just exercises the same startup path that `tick` uses to load config.
  const { exitCode, stdout, stderr } = runCli(["task", "list"], {
    QUAY_DATA_DIR: dataDir,
    QUAY_CONFIG_FILE: configPath,
  });
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("[]");
});

test("CLI accepts worktree_root and retry_budget overrides from the config file", () => {
  // Spec §13 keys that didn't have an entry-level smoke test before: the
  // production CLI must accept both `worktree_root` (deploy-controlled
  // worktree placement) and `retry_budget` (per-task budget cap) without
  // tripping the strict schema. We don't run a write command here because
  // that requires real adapters; just prove startup doesn't reject the
  // file.
  const dataDir = tempDir();
  const worktreeDir = tempDir();
  const configPath = join(tempDir(), "config.toml");
  writeFileSync(
    configPath,
    `worktree_root = "${worktreeDir}"
retry_budget = 9
`,
  );
  const { exitCode, stdout, stderr } = runCli(["task", "list"], {
    QUAY_DATA_DIR: dataDir,
    QUAY_CONFIG_FILE: configPath,
  });
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("[]");
});

test("CLI fails loudly when the config file is invalid (does not silently use defaults)", () => {
  const dataDir = tempDir();
  const configPath = join(tempDir(), "config.toml");
  // `max_concurrency` is a plausible typo of `max_concurrent`. The strict
  // schema must reject it so the operator notices instead of running with
  // the default and wondering why their setting is ignored.
  writeFileSync(configPath, `max_concurrency = 4\n`);
  const { exitCode, stderr } = runCli(["task", "list"], {
    QUAY_DATA_DIR: dataDir,
    QUAY_CONFIG_FILE: configPath,
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/max_concurrency|invalid|unrecognized/i);
});

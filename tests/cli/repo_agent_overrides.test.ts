// `repo add` and `repo update` accept `--agent-worker` / `--agent-reviewer`
// per spec AST-107. The CLI validates the name against the resolver's
// registered set so an operator mistyping `codex` as `cdx` gets a clear
// error before any DB write. Passing an empty string on update clears
// the override.

import { afterEach, expect, test } from "bun:test";
import { dispatch, type CliDeps } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

// Replace the default (claude-only) resolver with one that also
// registers a "codex" entry, mirroring what production sets up via
// `[agents.invocations.codex]` in config.toml.
function withCodexResolver(deps: CliDeps): CliDeps {
  return {
    ...deps,
    agentResolver: createAgentResolver({
      db: deps.db,
      config: {
        agents: {
          invocations: {
            claude: { worker: "claude --w", reviewer: "claude --r" },
            codex: { worker: "codex --w", reviewer: "codex --r" },
          },
        },
      },
    }),
  };
}

test("repo add accepts --agent-worker / --agent-reviewer for registered agents", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const deps = withCodexResolver(built.deps);

  const io = bufferIO();
  const result = await dispatch(
    [
      "repo",
      "add",
      "--id",
      "hermes-agent",
      "--url",
      "git@example:hermes.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "bun install",
      "--agent-worker",
      "codex",
      "--agent-reviewer",
      "claude",
    ],
    deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const row = JSON.parse(io.out());
  expect(row.agent_worker).toBe("codex");
  expect(row.agent_reviewer).toBe("claude");
});

test("repo add rejects an unregistered agent name with a usage_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const deps = withCodexResolver(built.deps);

  const io = bufferIO();
  const result = await dispatch(
    [
      "repo",
      "add",
      "--id",
      "typo-repo",
      "--url",
      "git@example:typo.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "bun install",
      "--agent-worker",
      "cdx",
    ],
    deps,
    io,
  );
  expect(result.exitCode).not.toBe(0);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
  expect(err.message).toMatch(/cdx/);
  // Repo row should not have been written.
  const repo = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM repos WHERE repo_id = ?`,
    )
    .get("typo-repo");
  expect(repo?.n).toBe(0);
});

test("repo update --agent-worker '' clears the override", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const deps = withCodexResolver(built.deps);

  // Seed: add a repo with a worker override.
  let io = bufferIO();
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "clear-me",
      "--url",
      "git@example:clear.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "bun install",
      "--agent-worker",
      "codex",
    ],
    deps,
    io,
  );
  expect(JSON.parse(io.out()).agent_worker).toBe("codex");

  // Now clear it.
  io = bufferIO();
  const result = await dispatch(
    ["repo", "update", "--id", "clear-me", "--agent-worker", ""],
    deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const row = JSON.parse(io.out());
  expect(row.agent_worker).toBeNull();
});

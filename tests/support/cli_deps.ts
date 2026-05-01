// Builds a CliDeps wired with the same fakes the core tests use, so dispatch
// can be driven without real adapters.
import { join } from "node:path";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import type { CliDeps } from "../../src/cli/dispatch.ts";
import { InProcessSupervisorLock } from "../../src/core/supervisor_lock.ts";
import type { Harness } from "./harness.ts";
import { FakeCommandRunner } from "./fakes/command_runner.ts";
import { FakeGit } from "./fakes/git.ts";
import { FakeGitHub } from "./fakes/github.ts";
import { FakeSlack } from "./fakes/slack.ts";
import { FakeTmux } from "./fakes/tmux.ts";

export interface BuiltCliDeps {
  deps: CliDeps;
  git: FakeGit;
  github: FakeGitHub;
  tmux: FakeTmux;
  slack: FakeSlack;
  commandRunner: FakeCommandRunner;
  reposRoot: string;
  worktreesRoot: string;
}

export function buildCliDeps(h: Harness): BuiltCliDeps {
  const reposRoot = join(h.dataDir, "repos");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const git = new FakeGit(reposRoot);
  const github = new FakeGitHub();
  const tmux = new FakeTmux();
  const slack = new FakeSlack();
  const commandRunner = new FakeCommandRunner();
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  return {
    deps: {
      db: h.db,
      clock: h.clock,
      ids: h.ids,
      git,
      github,
      tmux,
      slack,
      commandRunner,
      artifactStore,
      supervisorLock: new InProcessSupervisorLock(),
      paths: {
        reposRoot,
        worktreesRoot,
        artifactsRoot: h.artifactRoot,
      },
    },
    git,
    github,
    tmux,
    slack,
    commandRunner,
    reposRoot,
    worktreesRoot,
  };
}

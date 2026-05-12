// Builds a CliDeps wired with the same fakes the core tests use, so dispatch
// can be driven without real adapters.
import { join } from "node:path";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import type { CliDeps } from "../../src/cli/dispatch.ts";
import { InProcessSupervisorLock } from "../../src/core/supervisor_lock.ts";
import type { ValidatorRunner } from "../../src/core/validator_runner.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createTagService } from "../../src/core/tags/service.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
import type { Harness } from "./harness.ts";
import { FakeCommandRunner } from "./fakes/command_runner.ts";
import { FakeGit } from "./fakes/git.ts";
import { FakeGitHub } from "./fakes/github.ts";
import { FakeLinearAdapter } from "./fakes/linear.ts";
import { FakeSlack } from "./fakes/slack.ts";
import { FakeTmux } from "./fakes/tmux.ts";
import { FakeValidatorRunner } from "./fakes/validator_runner.ts";

export interface BuiltCliDeps {
  deps: CliDeps;
  git: FakeGit;
  github: FakeGitHub;
  tmux: FakeTmux;
  slack: FakeSlack;
  linear: FakeLinearAdapter;
  validatorRunner: FakeValidatorRunner;
  commandRunner: FakeCommandRunner;
  reposRoot: string;
  worktreesRoot: string;
}

export interface BuildCliDepsOptions {
  linearEnabled?: boolean;
  slackEnabled?: boolean;
  validatorRunner?: ValidatorRunner;
}

export function buildCliDeps(
  h: Harness,
  options: BuildCliDepsOptions = {},
): BuiltCliDeps {
  const reposRoot = join(h.dataDir, "repos");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const git = new FakeGit(reposRoot);
  const github = new FakeGitHub();
  const tmux = new FakeTmux();
  const slack = new FakeSlack();
  const linear = new FakeLinearAdapter();
  const fakeValidatorRunner = new FakeValidatorRunner();
  const validatorRunner: ValidatorRunner =
    options.validatorRunner ?? fakeValidatorRunner;
  const commandRunner = new FakeCommandRunner();
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  const repoService = createRepoService({ db: h.db, clock: h.clock });
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
      linear,
      validatorRunner,
      adaptersConfig: {
        linearEnabled: options.linearEnabled ?? true,
        slackEnabled: options.slackEnabled ?? true,
      },
      repoService,
      tagService: createTagService({
        db: h.db,
        clock: h.clock,
        repoService,
      }),
      agentResolver: createAgentResolver({ db: h.db, config: {} }),
    },
    git,
    github,
    tmux,
    slack,
    linear,
    validatorRunner: fakeValidatorRunner,
    commandRunner,
    reposRoot,
    worktreesRoot,
  };
}

import { join } from "node:path";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import type { TickDeps } from "../../src/core/tick.ts";
import { InProcessSupervisorLock } from "../../src/core/supervisor_lock.ts";
import type { Harness } from "./harness.ts";
import { FakeGit } from "./fakes/git.ts";
import { FakeGitHub } from "./fakes/github.ts";
import { FakeTmux } from "./fakes/tmux.ts";

export interface BuiltTickDeps {
  deps: TickDeps;
  git: FakeGit;
  github: FakeGitHub;
  tmux: FakeTmux;
  reposRoot: string;
  artifactStore: ReturnType<typeof createArtifactStore>;
}

export function buildTickDeps(h: Harness): BuiltTickDeps {
  const reposRoot = join(h.dataDir, "repos");
  const git = new FakeGit(reposRoot);
  const github = new FakeGitHub();
  const tmux = new FakeTmux();
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  return {
    deps: {
      db: h.db,
      clock: h.clock,
      git,
      github,
      tmux,
      artifactStore,
      supervisorLock: new InProcessSupervisorLock(),
    },
    git,
    github,
    tmux,
    reposRoot,
    artifactStore,
  };
}

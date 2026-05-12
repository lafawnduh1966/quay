// `attempts.agent_name` records the resolved agent key (e.g. "claude",
// "codex"). Together with `agent_identity` (binary + version) it
// distinguishes "which entry under [agents.invocations] ran this
// attempt" from "which binary the spawn site probed".

import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("worker spawn records the resolved agent_name on the attempt row", async () => {
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-agent-name");
  // Pin this repo's worker role to the "codex" entry under
  // [agents.invocations]; the deployment default would otherwise
  // resolve to claude.
  h.db
    .query(`UPDATE repos SET agent_worker = ? WHERE repo_id = ?`)
    .run("codex", repoId);
  const taskId = insertTask(h.db, { taskId: "task-agent-name", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, null);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  const agentResolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "bun --version", reviewer: "bun --version" },
        },
      },
    },
  });

  const results = await tick_once(built.deps, { agentResolver });
  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);

  const row = h.db
    .query<
      { agent_name: string | null; agent_identity: string | null },
      [number]
    >(`SELECT agent_name, agent_identity FROM attempts WHERE attempt_id = ?`)
    .get(attemptId);
  expect(row!.agent_name).toBe("codex");
  // agent_identity still reflects the probed binary, not the registered key.
  expect(row!.agent_identity!.startsWith("bun/")).toBe(true);
});

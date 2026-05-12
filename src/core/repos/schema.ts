import { z } from "zod";

const nonEmptyString = z.string().min(1);

// `repo_id` is the stable key under which Quay creates per-repo on-disk state
// (`<reposRoot>/<repo_id>.git`, artifact subdirs, log filenames). It must not
// contain path separators or relative-path segments — otherwise an operator
// id like `../escape` would let the bare clone (and downstream cleanup) write
// outside `data_dir`. We constrain to a conservative identifier charset; that
// is also what the docs imply by calling `repo_id` an "id".
export const repoIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..", {
    message:
      "repo_id must match [A-Za-z0-9._-]+ and cannot be '.' or '..' (no path separators or traversal)",
  });

// `agent_worker` / `agent_reviewer` name an entry registered under
// `[agents.invocations]` in deployment config. NULL means "follow the
// deployment default for this role". We do not validate the name
// matches a registered agent here — the repo service does not see the
// config — so the CLI handler validates against the resolver's
// `registeredAgents()` before calling into the service.
const agentName = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, {
  message: "agent name must match [A-Za-z0-9._-]+",
});

export const repoAddInputSchema = z
  .object({
    repo_id: repoIdSchema,
    repo_url: nonEmptyString,
    base_branch: nonEmptyString,
    package_manager: nonEmptyString,
    install_cmd: nonEmptyString,
    test_cmd: nonEmptyString.optional(),
    ci_workflow_name: nonEmptyString.optional(),
    contribution_guide_path: nonEmptyString.optional(),
    agent_worker: agentName.optional(),
    agent_reviewer: agentName.optional(),
  })
  .strict();

export type RepoAddInput = z.infer<typeof repoAddInputSchema>;

export const repoUpdateInputSchema = z
  .object({
    repo_url: nonEmptyString.optional(),
    base_branch: nonEmptyString.optional(),
    package_manager: nonEmptyString.optional(),
    install_cmd: nonEmptyString.optional(),
    test_cmd: nonEmptyString.nullable().optional(),
    ci_workflow_name: nonEmptyString.nullable().optional(),
    contribution_guide_path: nonEmptyString.nullable().optional(),
    agent_worker: agentName.nullable().optional(),
    agent_reviewer: agentName.nullable().optional(),
  })
  .strict();

export type RepoUpdateInput = z.infer<typeof repoUpdateInputSchema>;

// `repo import` rows accept the same required fields as `repo add` plus the
// two metadata columns (`archived_at`, `created_at`) so a full-fidelity
// export → wipe → import round-trip preserves timestamps. Both metadata
// fields are optional: hand-written single-row dumps can omit them and rely
// on the service's default ("preserve existing" / "now()").
export const repoImportInputSchema = z
  .object({
    repo_id: repoIdSchema,
    repo_url: nonEmptyString,
    base_branch: nonEmptyString,
    package_manager: nonEmptyString,
    install_cmd: nonEmptyString,
    test_cmd: nonEmptyString.nullable().optional(),
    ci_workflow_name: nonEmptyString.nullable().optional(),
    contribution_guide_path: nonEmptyString.nullable().optional(),
    agent_worker: agentName.nullable().optional(),
    agent_reviewer: agentName.nullable().optional(),
    archived_at: z.string().nullable().optional(),
    created_at: nonEmptyString.optional(),
  })
  .strict();

export type RepoImportInput = z.infer<typeof repoImportInputSchema>;

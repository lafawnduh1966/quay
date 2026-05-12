-- Per-repo agent overrides for worker and reviewer roles.
--
-- A NULL column means "use the deployment default" (the resolver falls
-- back to `[agents].worker` / `[agents].reviewer`). A non-NULL column
-- pins the role to a named entry under `[agents.invocations]`. The
-- worker and reviewer columns are independent so operators can run e.g.
-- a codex worker against a claude reviewer ("second opinion" mix).
--
-- Migration also adds `attempts.agent_name` so the spawn site records
-- which registered agent ran the attempt — observability that doesn't
-- depend on `agent_identity` (which is the binary + version string from
-- the probe, not the registered key).

ALTER TABLE repos ADD COLUMN agent_worker TEXT;
ALTER TABLE repos ADD COLUMN agent_reviewer TEXT;

ALTER TABLE attempts ADD COLUMN agent_name TEXT;

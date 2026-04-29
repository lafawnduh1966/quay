// CI status classifier (spec §5 "CI status rules"). Pure function over a
// `PrSnapshot` plus the repo's `ci_workflow_name`.
//
// Returns `"stale"` when the SHA the checks were run against doesn't match
// the PR's current head SHA — caller logs `tick_error` and skips the
// transition (no budget consumed).
import type { PrCheck, PrSnapshot } from "../ports/github.ts";

export type CiOutcome = "pass" | "fail" | "pending" | "stale";

export function classifyCi(
  snapshot: PrSnapshot,
  ciWorkflowName: string | null,
): CiOutcome {
  if (
    snapshot.checks.checkSha !== null &&
    snapshot.checks.checkSha !== snapshot.headSha
  ) {
    return "stale";
  }

  if (ciWorkflowName !== null && ciWorkflowName.length > 0) {
    const filtered = snapshot.checks.items.filter(
      (c) => c.workflow === ciWorkflowName,
    );
    return classifySet(filtered);
  }

  // ci_workflow_name unset: required-checks rule. The set of checks Quay
  // considers is `--required` only. No required checks at all → pass.
  const required = snapshot.checks.items.filter((c) => c.required);
  if (required.length === 0) return "pass";
  return classifySet(required);
}

function classifySet(items: PrCheck[]): CiOutcome {
  if (items.length === 0) return "pending";
  let hasFail = false;
  let hasPending = false;
  for (const c of items) {
    if (c.bucket === "fail") {
      hasFail = true;
      continue;
    }
    if (c.bucket === "cancelled") {
      if (c.required) hasFail = true;
      continue;
    }
    if (c.bucket === "pending") {
      hasPending = true;
    }
  }
  if (hasFail) return "fail";
  if (hasPending) return "pending";
  return "pass";
}

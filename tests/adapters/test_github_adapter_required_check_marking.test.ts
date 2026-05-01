// Regression: when `ci_workflow_name` is unset, the spec §5 CI rule falls
// back to "all required checks must pass." That hinges on the GitHub
// adapter actually marking each PrCheck's `required` flag from the second
// `gh pr checks --required` call. If the adapter ever ships every check as
// `required: false`, classifyCi sees "no required checks → pass" and a
// failing required CI silently transitions the task to `done`.
//
// We test the pure helpers (`requiredKeyOf`, `markRequired`) plus the
// downstream `classifyCi` so the regression is caught without needing a
// real `gh` round-trip.

import { expect, test } from "bun:test";
import {
  markRequired,
  requiredKeyOf,
} from "../../src/adapters/github.ts";
import { classifyCi } from "../../src/core/ci_status.ts";
import type { PrCheck, PrSnapshot } from "../../src/ports/github.ts";

const baseCheck = (over: Partial<PrCheck> = {}): PrCheck => ({
  name: "test",
  workflow: "ci",
  bucket: "pass",
  required: false,
  ...over,
});

test("requiredKeyOf disambiguates workflow vs name", () => {
  // "ci/build" vs "ci"+"build" must produce different keys; a plain space
  // join would collide.
  const a = requiredKeyOf({ workflow: "ci/build", name: "lint" });
  const b = requiredKeyOf({ workflow: "ci", name: "build/lint" });
  expect(a).not.toBe(b);
  // null workflow is distinct from empty-string workflow.
  const c = requiredKeyOf({ workflow: null, name: "lint" });
  const d = requiredKeyOf({ workflow: "", name: "lint" });
  expect(c).toBe(d); // both reduce to empty-prefix; this is fine because
  // `gh` returns null when no workflow is associated and we coerce both to ""
  // — the equality is intentional and asserted here.
});

test("markRequired flips `required: true` only on matching (workflow,name) pairs", () => {
  const items: PrCheck[] = [
    baseCheck({ name: "lint", workflow: "ci" }),
    baseCheck({ name: "test", workflow: "ci", bucket: "fail" }),
    baseCheck({ name: "deploy", workflow: "release" }),
  ];
  const required = new Set<string>([
    requiredKeyOf({ workflow: "ci", name: "test" }),
  ]);
  const out = markRequired(items, required);
  // Only the matching row gets required:true.
  expect(out[0]!.required).toBe(false);
  expect(out[1]!.required).toBe(true);
  expect(out[2]!.required).toBe(false);
  // markRequired is non-mutating.
  expect(items[1]!.required).toBe(false);
});

test("classifyCi(no ci_workflow_name): failing REQUIRED check produces fail", () => {
  // Regression asserting that an adapter that correctly populates `required`
  // routes a fail to fail (not pass). Synthesize the snapshot the adapter
  // would have produced for: one passing required check + one failing
  // required check + one failing non-required check.
  const items: PrCheck[] = [
    baseCheck({ name: "lint", workflow: "ci", bucket: "pass", required: true }),
    baseCheck({ name: "test", workflow: "ci", bucket: "fail", required: true }),
    baseCheck({ name: "perf", workflow: "ci", bucket: "fail", required: false }),
  ];
  const snapshot = makeSnapshot(items);
  expect(classifyCi(snapshot, null)).toBe("fail");
});

test("classifyCi(no ci_workflow_name): no required checks at all → pass (spec §5)", () => {
  // Spec: "No required checks configured at all (set is empty): treated as
  // pass." This is what the previous adapter accidentally triggered for
  // every repo; the test pins it as the only legitimate path to that
  // outcome.
  const items: PrCheck[] = [
    baseCheck({ name: "lint", workflow: "ci", bucket: "fail", required: false }),
  ];
  const snapshot = makeSnapshot(items);
  expect(classifyCi(snapshot, null)).toBe("pass");
});

test("classifyCi(no ci_workflow_name): all required pass → pass", () => {
  const items: PrCheck[] = [
    baseCheck({ name: "lint", workflow: "ci", bucket: "pass", required: true }),
    baseCheck({ name: "test", workflow: "ci", bucket: "pass", required: true }),
  ];
  expect(classifyCi(makeSnapshot(items), null)).toBe("pass");
});

test("classifyCi(no ci_workflow_name): required pending → pending", () => {
  const items: PrCheck[] = [
    baseCheck({ name: "lint", workflow: "ci", bucket: "pass", required: true }),
    baseCheck({ name: "test", workflow: "ci", bucket: "pending", required: true }),
  ];
  expect(classifyCi(makeSnapshot(items), null)).toBe("pending");
});

function makeSnapshot(items: PrCheck[]): PrSnapshot {
  return {
    state: "open",
    headSha: "deadbeef",
    baseSha: "cafef00d",
    mergeable: "mergeable",
    latestReview: {
      decision: "NONE",
      latestReviewId: null,
      comments: "",
    },
    checks: { checkSha: null, items },
  };
}

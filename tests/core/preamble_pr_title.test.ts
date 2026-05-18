import { expect, test } from "bun:test";
import {
  DEFAULT_PREAMBLE_BODY,
  DEFAULT_REVIEWER_PREAMBLE_BODY,
} from "../../src/core/preamble.ts";

test("code preamble instructs workers to use conventional-commit PR title prefixes", () => {
  expect(DEFAULT_PREAMBLE_BODY).toContain("conventional-commit prefix");
  expect(DEFAULT_PREAMBLE_BODY).toContain("`feat:`");
  expect(DEFAULT_PREAMBLE_BODY).toContain("`fix:`");
  expect(DEFAULT_PREAMBLE_BODY).toContain("`chore:`");
});

test("code preamble tells workers how to disambiguate between feat and chore", () => {
  expect(DEFAULT_PREAMBLE_BODY).toMatch(
    /in doubt between `feat` and `chore`, pick `chore`/,
  );
});

test("code preamble keeps the ticket reference out of the PR title leading position", () => {
  expect(DEFAULT_PREAMBLE_BODY).toMatch(
    /ticket reference in the PR body|do not lead the title/i,
  );
});

test("code preamble permits a respawn to update the PR title only on material scope changes", () => {
  expect(DEFAULT_PREAMBLE_BODY).toContain("gh pr edit --title");
  expect(DEFAULT_PREAMBLE_BODY).toMatch(/materially changed/);
});

test("reviewer preamble does not instruct title rewrites on human-authored PRs", () => {
  expect(DEFAULT_REVIEWER_PREAMBLE_BODY).not.toContain("gh pr edit");
  expect(DEFAULT_REVIEWER_PREAMBLE_BODY).not.toContain("conventional-commit");
  expect(DEFAULT_REVIEWER_PREAMBLE_BODY).toContain("Do not modify code");
});

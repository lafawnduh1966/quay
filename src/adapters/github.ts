// Real GitHub adapter. Shells out to the `gh` CLI from inside the bare clone
// for `<repoId>`, so `gh` infers the upstream repo from `origin` rather than
// requiring an explicit owner/name pair on every call. The GitHubCliAdapter
// throws on any unexpected `gh` failure; tick wraps these in the per-task
// `tick_error` path (spec §5).
//
// Schema mapping (see ports/github.ts for the type definitions):
//   - PR existence:       `gh pr list --head <branch> --state all --json number`
//   - PR open?:           `gh pr list --head <branch> --state open --json number`
//   - PR snapshot fields: `gh pr view <branch> --json number,url,state,headRefOid,
//                                                baseRefName,mergeable,
//                                                reviewDecision,latestReviews,reviews`
//     `baseRefOid` is intentionally NOT in this set — it was added in gh
//     2.46 and a successful read on older gh installs (e.g. 2.45.0) errors
//     with "Unknown JSON field: baseRefOid", which would knock out the whole
//     scrape and leave tasks.pr_number / pr_url / base_sha NULL. We carry
//     `baseRefName` (universally supported) and resolve it to a SHA via a
//     `git merge-base origin/<baseRefName> <headRefOid>` shell-out against
//     the bare clone (already fetched by tick before calling this).
//     `reviews` is requested alongside `latestReviews` to recover the review
//     node id when gh's `latestReviews` projection emits `id: ""` (observed
//     on the gh that ships with current Debian/Ubuntu): same review surfaces
//     under `reviews` with the real `PRR_…` id, so the inline-comment fetch
//     can key off that instead of looping on an empty id.
//   - Inline review comments (CHANGES_REQUESTED only):
//                         `gh api graphql -f query='... PullRequestReview.comments ...'`
//                         keyed by the review's node id from `latestReviews`/`reviews`.
//                         Folded into `latestReview.comments` so the worker's respawn
//                         artifact actually carries the actionable feedback.
//   - Required-check set: `gh pr checks <branch> --json bucket,workflow,name,state`
//   - Closing the PR:     `gh pr close <branch>`  (idempotent: tolerates "already closed"
//                                                  and "no PR" by inspecting stderr)
import { join, resolve } from "node:path";
import type {
  GitHubPort,
  PrCheck,
  PrCheckBucket,
  PrCheckStatus,
  PrChecksReport,
  PrLatestReview,
  PrMergeableState,
  PostedReview,
  PrReviewDecision,
  PrSnapshot,
  PrTerminalState,
  PullRequestView,
} from "../ports/github.ts";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitHubCliAdapter implements GitHubPort {
  private cachedLogin: string | null = null;

  constructor(private readonly reposRoot: string) {}

  prExistsForBranch(repoId: string, branch: string): boolean {
    const list = this.listPrs(repoId, branch, "all");
    return list.length > 0;
  }

  prCheckStatus(repoId: string, branch: string): PrCheckStatus {
    // `prCheckStatus` is the convenience read that does not flow through the
    // tick-side `classifyCi` (which combines `ci_workflow_name` + required-
    // only filtering). To stay consistent with §5, restrict the decision
    // here to required checks only — same rule as the spec's fallback when
    // no `ci_workflow_name` is set. Callers that need named-workflow
    // semantics use `prSnapshot` + `classifyCi`.
    const checks = this.fetchChecks(repoId, branch);
    const required = checks.items.filter((c) => c.required);
    // Spec §5: "no required checks at all → pass" — repos with no required
    // checks configured don't gate on CI, so an empty required set must
    // resolve to pass rather than stranding callers in pending.
    if (required.length === 0) return { state: "pass" };
    const anyFail = required.some(
      (c) => c.bucket === "fail" || c.bucket === "cancelled",
    );
    if (anyFail) {
      return checks.failureExcerpt !== undefined
        ? { state: "fail", excerpt: checks.failureExcerpt }
        : { state: "fail" };
    }
    const anyPending = required.some((c) => c.bucket === "pending");
    if (anyPending) return { state: "pending" };
    return { state: "pass" };
  }

  prIsOpen(repoId: string, branch: string): boolean {
    return this.listPrs(repoId, branch, "open").length > 0;
  }

  closePr(repoId: string, branch: string): void {
    // Idempotent per spec §5: a closed/merged PR or a missing PR is a no-op.
    // Match only PR-scoped phrasings — a bare `not found` substring would
    // also match repo-level 404s, auth-scope errors, and any Go-internal
    // ENOENT bubbling through gh, masking real failures as benign no-ops.
    const result = this.run(repoId, ["gh", "pr", "close", branch]);
    if (result.exitCode === 0) return;
    const msg = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (
      msg.includes("already closed") ||
      msg.includes("no pull request") ||
      msg.includes("no pull requests")
    ) {
      return;
    }
    throw new Error(`gh pr close ${branch} failed: ${result.stderr.trim()}`);
  }

  prSnapshot(repoId: string, branch: string): PrSnapshot | null {
    return this.prSnapshotBySelector(repoId, branch);
  }

  prSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null {
    // `gh pr view` / `gh pr checks` accept either a branch ref or a numeric
    // PR id as the positional selector; the underlying helpers are agnostic.
    return this.prSnapshotBySelector(repoId, String(prNumber));
  }

  private prSnapshotBySelector(
    repoId: string,
    selector: string,
  ): PrSnapshot | null {
    // Spec §5 / §12: tick must reject CI evaluation when the check rows it
    // sees were produced against a SHA that's no longer the PR head (force
    // push or GitHub lag). `gh pr checks --json` does not surface a per-row
    // SHA, so we bracket the checks call with two `gh pr view --json
    // headRefOid` reads:
    //
    //   - `headShaBefore` is the SHA we believe the checks describe — it's
    //     what was at the head of the PR at the moment we asked `gh` for
    //     check rows. We propagate it as `checks.checkSha`.
    //   - `headShaAfter` is the SHA at the moment the snapshot returns —
    //     we propagate it as `headSha`.
    //
    // If a force-push lands between the two reads, the two SHAs disagree;
    // `classifyCi` returns "stale" and tick logs `tick_error` rather than
    // transitioning on possibly-old green checks.
    const view = this.fetchPrView(repoId, selector);
    if (view === null) return null;
    const headShaBefore = view.headSha;
    const checks = this.fetchChecks(repoId, selector);
    const headShaAfter =
      this.fetchHeadShaOnly(repoId, selector) ?? headShaBefore;
    const snapshot: PrSnapshot = {
      state: view.state,
      prNumber: view.prNumber ?? null,
      headSha: headShaAfter,
      baseSha: view.baseSha,
      mergeable: view.mergeable,
      latestReview: view.latestReview,
      checks: { ...checks, checkSha: headShaBefore },
    };
    // Optional metadata fields use conditional assignment so they're only
    // present when populated — `exactOptionalPropertyTypes` rejects an
    // explicit `undefined` on optional members.
    if (view.baseRef !== null && view.baseRef !== undefined) {
      snapshot.baseRef = view.baseRef;
    }
    if (view.baseTipSha !== null && view.baseTipSha !== undefined) {
      snapshot.baseTipSha = view.baseTipSha;
    }
    if (view.prNumber !== null && view.prNumber !== undefined) {
      snapshot.prNumber = view.prNumber;
    }
    if (view.prUrl !== null && view.prUrl !== undefined) {
      snapshot.prUrl = view.prUrl;
    }
    return snapshot;
  }

  prView(repoId: string, prNumber: number): PullRequestView | null {
    const fields = [
      "number",
      "title",
      "body",
      "url",
      "headRefName",
      "headRefOid",
    ].join(",");
    const result = this.run(repoId, [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--json",
      fields,
    ]);
    if (result.exitCode !== 0) {
      const lower = result.stderr.toLowerCase();
      if (
        lower.includes("no pull request") ||
        lower.includes("no pull requests")
      ) {
        return null;
      }
      throw new Error(
        `gh pr view ${prNumber} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `gh pr view returned unparseable JSON for PR #${prNumber}: ${(err as Error).message}`,
      );
    }
    return {
      number:
        typeof parsed.number === "number" ? parsed.number : Number(prNumber),
      title: String(parsed.title ?? ""),
      body: String(parsed.body ?? ""),
      url:
        parsed.url !== null && parsed.url !== undefined
          ? String(parsed.url)
          : null,
      headRefName: String(parsed.headRefName ?? ""),
      headSha: String(parsed.headRefOid ?? ""),
    };
  }

  fetchPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
    expectedLogin?: string,
  ): PostedReview | null {
    const login = expectedLogin ?? this.currentLogin(repoId);
    // Match policy preserves *identity kind* (App vs. regular user). The
    // previous `gh pr view --json reviews` projection only exposes
    // `author.login`, and that field is shape-ambiguous: gh strips the
    // `app/` prefix and the `[bot]` suffix for App-bot review authors, so
    // an App-bot review by `app/foo` and a user review by `foo` both
    // surface as `foo` — collapsing two distinct GitHub identities. If
    // an operator pins `reviewer.login = "app/foo"`, only an App-bot
    // review must satisfy the gate; a same-named user must not.
    //
    // The REST reviews endpoint (`/repos/{o}/{r}/pulls/<n>/reviews`)
    // returns the discriminator we need: `user.type` is `"Bot"` for App
    // authors and `"User"` for regular accounts, and `user.login` carries
    // the `[bot]` suffix on Bot rows so the two paths cannot alias.
    const isAppForm = login.startsWith("app/");
    const expectedType: "Bot" | "User" = isAppForm ? "Bot" : "User";
    const expectedBareLogin = isAppForm ? login.slice(4) : login;
    // `?per_page=100` lifts the default page size (30) to cover practical
    // review volumes on a single PR; we still iterate newest-first so the
    // first match wins. If a PR ever exceeds 100 reviews from the same
    // author we'd miss the most recent ones on subsequent pages — that's
    // far beyond any real reviewer-bot workload, but the failure mode is
    // a transient "no posted review yet" (a retry, not a wrong accept),
    // so we don't paginate at the cost of a multi-call code path.
    const path = `repos/{owner}/{repo}/pulls/${prNumber}/reviews?per_page=100`;
    const result = this.run(repoId, ["gh", "api", path]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh api ${path} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `gh api returned unparseable review JSON for PR #${prNumber}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `gh api returned non-array review JSON for PR #${prNumber}: ${result.stdout.trim().slice(0, 200)}`,
      );
    }
    const reviews = parsed as Array<Record<string, unknown>>;
    // A Bot's `user.login` carries the `[bot]` suffix in the REST API
    // (e.g. `didier-reviewer[bot]`). Strip only for Bot rows so a
    // collision with a real user named `didier-reviewer[bot]`-literal
    // would still mismatch on `user.type`.
    const stripBotSuffix = (s: string): string =>
      s.endsWith("[bot]") ? s.slice(0, -"[bot]".length) : s;
    for (let i = reviews.length - 1; i >= 0; i -= 1) {
      const r = reviews[i] ?? {};
      const user = (r.user ?? {}) as Record<string, unknown>;
      const userType = String(user.type ?? "");
      if (userType !== expectedType) continue;
      const userLogin = String(user.login ?? "");
      const bareLogin =
        expectedType === "Bot" ? stripBotSuffix(userLogin) : userLogin;
      if (bareLogin !== expectedBareLogin) continue;
      const commitId = String(r.commit_id ?? "");
      if (commitId !== headSha) continue;
      const decision = mapPostedReviewDecision(r.state);
      if (decision === null) continue;
      const reviewNodeId = String(r.node_id ?? "");
      if (reviewNodeId === "") continue;
      const inline = this.fetchReviewInlineComments(repoId, reviewNodeId);
      return {
        reviewId: reviewNodeId,
        decision,
        body: String(r.body ?? ""),
        comments: composeReviewFeedback(String(r.body ?? ""), inline),
      };
    }
    return null;
  }

  // -- helpers ------------------------------------------------------------

  private listPrs(
    repoId: string,
    branch: string,
    state: "open" | "closed" | "all",
  ): Array<{ number: number }> {
    const result = this.run(repoId, [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      state,
      "--json",
      "number",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh pr list --head ${branch} --state ${state} failed: ${result.stderr.trim()}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `gh pr list returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    // Fail closed on a non-array body. `gh pr list --json number` is
    // contractually an array; anything else (object, null, scalar) is a
    // schema/CLI anomaly. Coercing it to `[]` would make a malformed
    // response look like "no PR" — cancel would delete a remote branch
    // that should be retained for an open PR, and enqueue would skip the
    // open-PR collision check. Same fail-closed posture as `prCheckStatus`
    // already takes for `gh pr checks`.
    if (!Array.isArray(parsed)) {
      throw new Error(
        `gh pr list returned non-array JSON for ${branch}: ${result.stdout.trim().slice(0, 200)}`,
      );
    }
    return parsed;
  }

  private fetchPrView(
    repoId: string,
    branch: string,
  ):
    | (Omit<PrSnapshot, "checks">)
    | null {
    // `baseRefOid` was deliberately removed from this list — see the header
    // comment on this file. Anything added here that's newer than gh 2.45 is
    // a stop-the-scrape regression for operators on the old CLI.
    const fields = [
      "number",
      "url",
      "state",
      "headRefOid",
      "baseRefName",
      "mergeable",
      "reviewDecision",
      "latestReviews",
      // `reviews` is requested as a backstop for the review node id: some
      // gh CLI versions return `latestReviews[].id` as the empty string
      // while the same review row under `reviews` carries the real
      // `PRR_…` node id. `extractLatestReview` falls back to this list
      // when the picked `latestReviews` entry has no usable id.
      "reviews",
    ].join(",");
    const result = this.run(repoId, [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      fields,
    ]);
    if (result.exitCode !== 0) {
      // `gh pr view` exits non-zero with "no pull requests found" when no PR
      // exists for the branch — that's the spec-defined "no PR" case, not an
      // error condition. Match PR-scoped phrasings only — a bare `not found`
      // substring would also match repo-level 404s and auth-scope errors,
      // silently disabling the spec §5 stale-SHA gate downstream by routing
      // a transient API error to a null snapshot.
      const lower = result.stderr.toLowerCase();
      if (
        lower.includes("no pull request") ||
        lower.includes("no pull requests")
      ) {
        return null;
      }
      throw new Error(
        `gh pr view ${branch} failed: ${result.stderr.trim()}`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `gh pr view returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    const baseLatestReview = extractLatestReview(parsed);
    const latestReview = this.enrichWithInlineComments(repoId, baseLatestReview);
    const headSha = String(parsed.headRefOid ?? "");
    const baseRef =
      parsed.baseRefName !== null && parsed.baseRefName !== undefined
        ? String(parsed.baseRefName)
        : null;
    // Resolve baseRefName → SHA via `git merge-base`. We deliberately use the
    // merge-base rather than the current tip of `origin/<baseRef>` so the
    // recorded base_sha is the commit the PR was branched from — stable even
    // if the base advances during the PR's lifetime. Best-effort: a missing
    // ref or unfetched base falls through as null and tick records pr_open
    // metadata without it.
    const baseSha =
      baseRef !== null && headSha !== ""
        ? this.computeMergeBaseSha(repoId, `origin/${baseRef}`, headSha)
        : null;
    // Resolve the base ref tip separately. Conflict dedup keys on the tip so
    // a base advance can re-trigger respawn even when head is unchanged —
    // `baseSha` (merge-base) is stable across that scenario by construction.
    const baseTipSha =
      baseRef !== null
        ? this.computeRefTipSha(repoId, `origin/${baseRef}`)
        : null;
    const prNumber = toFiniteIntegerOrNull(parsed.number);
    const prUrl =
      typeof parsed.url === "string" && parsed.url.length > 0
        ? parsed.url
        : null;
    const view: Omit<PrSnapshot, "checks"> = {
      state: mapPrState(parsed.state),
      headSha,
      baseSha,
      mergeable: mapMergeable(parsed.mergeable),
      latestReview,
    };
    if (baseRef !== null) view.baseRef = baseRef;
    if (baseTipSha !== null) view.baseTipSha = baseTipSha;
    if (prNumber !== null) view.prNumber = prNumber;
    if (prUrl !== null) view.prUrl = prUrl;
    return view;
  }

  // Resolve a (base, head) pair to the merge-base SHA via a git shell-out
  // inside the bare clone. Best-effort: any failure (missing ref, empty
  // output, unfetched base) returns null so the caller can still publish a
  // partial snapshot — base_sha just stays null until the next tick.
  protected computeMergeBaseSha(
    repoId: string,
    baseRef: string,
    headSha: string,
  ): string | null {
    const result = this.run(repoId, [
      "git",
      "merge-base",
      baseRef,
      headSha,
    ]);
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  // Resolve a ref to its current tip SHA via `git rev-parse`. Same best-effort
  // posture as `computeMergeBaseSha`: any failure returns null and the caller
  // omits `baseTipSha` from the snapshot.
  protected computeRefTipSha(repoId: string, ref: string): string | null {
    const result = this.run(repoId, ["git", "rev-parse", ref]);
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  // For CHANGES_REQUESTED reviews, the actionable feedback usually lives in
  // inline review comments — `gh pr view --json latestReviews` only surfaces
  // the (often empty) review summary body. Without this enrichment, the
  // worker gets respawned with an empty `review_comments` artifact and no
  // idea what the reviewer asked for.
  //
  // Fetch the review's inline comments via the GraphQL API (keyed by the
  // review's node id, which is what `gh pr view` returns) and fold them
  // into `comments` as a deterministic markdown block. We only enrich
  // CHANGES_REQUESTED reviews — other decisions don't trigger a respawn,
  // so there's no caller that would read the result.
  //
  // Fail closed: if the inline-comments fetch errors (rate limit, auth,
  // malformed response), throw so tick logs `tick_error` and retries.
  // Returning a partial snapshot would mean respawning the worker with
  // less feedback than the reviewer actually wrote.
  private enrichWithInlineComments(
    repoId: string,
    base: PrLatestReview,
  ): PrLatestReview {
    if (base.decision !== "CHANGES_REQUESTED") return base;
    // Skip on null OR empty string. `extractLatestReview` normalises a
    // missing id to null, but the empty-string check is a belt-and-
    // suspenders guard: a graphql `node(id: "")` call returns "Could not
    // resolve to a node with the global id of ''" and tick loops on it
    // every cycle with no circuit breaker.
    if (!base.latestReviewId) return base;
    const inline = this.fetchReviewInlineComments(repoId, base.latestReviewId);
    if (inline.length === 0 && base.comments.trim() === "") return base;
    return { ...base, comments: composeReviewFeedback(base.comments, inline) };
  }

  private fetchReviewInlineComments(
    repoId: string,
    reviewNodeId: string,
  ): InlineReviewComment[] {
    // GraphQL keyed on the review's node id (the form `gh pr view` returns).
    // The REST endpoint at /pulls/<n>/reviews/<numeric-id>/comments would
    // require translating to the numeric databaseId first; the GraphQL
    // `node(id: $id)` form doesn't, so it's the cleanest path.
    //
    // Pagination: GraphQL caps `first` at 100. A review with more inline
    // comments would silently drop the rest under a single-page query —
    // and because tick records the review id as acted-on after the
    // respawn, the missing comments would never be surfaced again. Loop
    // through pages until `hasNextPage` is false.
    //
    // Cap the loop with a generous-but-finite ceiling so a malformed
    // server response (always-true `hasNextPage`, repeating cursor)
    // can't wedge tick. 50 pages × 100 = 5000 inline comments is well
    // above any realistic review; we throw if hit so the operator sees
    // the anomaly rather than tick silently truncating.
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    const items: InlineReviewComment[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { nodes, hasNextPage, endCursor } = this.fetchReviewCommentsPage(
        repoId,
        reviewNodeId,
        PAGE_SIZE,
        cursor,
      );
      for (const row of nodes) {
        const r = (row ?? {}) as Record<string, unknown>;
        const path = String(r.path ?? "");
        const line =
          typeof r.line === "number"
            ? r.line
            : typeof r.originalLine === "number"
              ? r.originalLine
              : null;
        const body = String(r.body ?? "");
        items.push({ path, line, body });
      }
      if (!hasNextPage) return items;
      // Defense: if the server promises a next page but doesn't supply
      // an advancing cursor, treat as a hard failure rather than looping
      // on the same page until MAX_PAGES.
      if (endCursor === null || endCursor === cursor) {
        throw new Error(
          `gh api graphql (review comments) reported hasNextPage=true with no advancing cursor for review ${reviewNodeId}`,
        );
      }
      cursor = endCursor;
    }
    throw new Error(
      `gh api graphql (review comments) exceeded ${MAX_PAGES * PAGE_SIZE} inline comments for review ${reviewNodeId}; refusing to truncate silently`,
    );
  }

  private fetchReviewCommentsPage(
    repoId: string,
    reviewNodeId: string,
    pageSize: number,
    cursor: string | null,
  ): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } {
    const query =
      "query($id: ID!, $first: Int!, $after: String) { node(id: $id) { ... on PullRequestReview { " +
      "comments(first: $first, after: $after) { nodes { path line originalLine body } " +
      "pageInfo { hasNextPage endCursor } } } } }";
    const args = [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `id=${reviewNodeId}`,
      "-F",
      `first=${pageSize}`,
    ];
    if (cursor !== null) {
      args.push("-f", `after=${cursor}`);
    }
    const result = this.run(repoId, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh api graphql (review comments) failed for review ${reviewNodeId}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `gh api graphql (review comments) returned unparseable JSON for review ${reviewNodeId}: ${(err as Error).message}`,
      );
    }
    // gh forwards GraphQL `errors` arrays even on exit 0 if the query
    // partially-failed against a permissions-restricted node. Surface that
    // as a hard failure rather than silently returning an empty list.
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const summary = parsed.errors
        .map((e) => {
          const eo = (e ?? {}) as Record<string, unknown>;
          return String(eo.message ?? JSON.stringify(eo));
        })
        .join("; ");
      throw new Error(
        `gh api graphql (review comments) returned errors for review ${reviewNodeId}: ${summary}`,
      );
    }
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const node = (data.node ?? {}) as Record<string, unknown>;
    const commentsField = (node.comments ?? {}) as Record<string, unknown>;
    const nodes = Array.isArray(commentsField.nodes) ? commentsField.nodes : [];
    const pageInfo = (commentsField.pageInfo ?? {}) as Record<string, unknown>;
    const hasNextPage = pageInfo.hasNextPage === true;
    const endCursor =
      typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0
        ? pageInfo.endCursor
        : null;
    return { nodes, hasNextPage, endCursor };
  }

  // Lightweight head-SHA read used by `prSnapshot` to bracket the checks
  // call. Returns null when no PR exists for the branch; throws on any
  // other `gh` failure so the caller can surface a `tick_error` (rather
  // than silently treating an API blip as "no force-push happened").
  private fetchHeadShaOnly(repoId: string, branch: string): string | null {
    const result = this.run(repoId, [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      "headRefOid",
    ]);
    if (result.exitCode !== 0) {
      // PR-scoped phrasing only. The bracketing `headRefOid` read is the
      // load-bearing input to the spec §5/§12 stale-SHA gate — if a bare
      // `not found` substring caught a transient GraphQL 404 here, the
      // caller's `?? headShaBefore` fallback in `prSnapshot` would silently
      // make the bracket SHAs match and let `classifyCi` transition on
      // possibly-stale checks. Failing closed surfaces a `tick_error`
      // instead.
      const lower = result.stderr.toLowerCase();
      if (
        lower.includes("no pull request") ||
        lower.includes("no pull requests")
      ) {
        return null;
      }
      throw new Error(
        `gh pr view ${branch} (headRefOid) failed: ${result.stderr.trim()}`,
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `gh pr view (headRefOid) returned unparseable JSON for ${branch}: ${(err as Error).message}`,
      );
    }
    const sha = String(parsed.headRefOid ?? "");
    return sha === "" ? null : sha;
  }

  private fetchChecks(repoId: string, branch: string): PrChecksReport {
    const fields = ["bucket", "workflow", "name", "state"].join(",");
    // Two passes: the unfiltered set drives the named-workflow rule (which
    // looks at every check matching `ci_workflow_name`), and the
    // `--required` filtered set tells us *which* of those checks count when
    // `ci_workflow_name` is unset and the spec falls back to required-only
    // status. Without this second call, every check would be marked
    // `required: false`, and the §5 rule "no required checks at all → pass"
    // would silently fire on repos with failing required CI.
    const result = this.run(repoId, [
      "gh",
      "pr",
      "checks",
      branch,
      "--json",
      fields,
    ]);
    // `gh pr checks` documents three significant exit codes (see
    // `gh pr checks --help`):
    //   0 — all checks passed.
    //   1 — at least one check failed.
    //   2 — gh CLI / runtime error (auth, network, malformed args, etc.).
    //   8 — checks are still pending.
    // Codes 0, 1, and 8 are *successful reads* — `gh` still wrote the JSON
    // checks array to stdout; the exit code only encodes the overall
    // verdict. We must parse the body in those cases. Anything else
    // (notably 2) is a hard failure and must throw so tick logs
    // `tick_error` rather than transitioning to done.
    // Parse a non-empty stdout as JSON BEFORE checking any "no checks"
    // hint. If gh emitted a valid JSON array, that array drives the
    // outcome — even if a check inside it has a workflow or name
    // containing the substring "no checks" (e.g. a CI workflow literally
    // named "No checks required"). A combined-stdout-and-stderr substring
    // match would otherwise short-circuit a real check set to empty,
    // which the spec §5 fallback then approves as pass.
    const stdoutTrim = result.stdout.trim();
    const parsedArray = tryParseJsonArray(stdoutTrim);
    if (parsedArray !== null) {
      const isReadSuccess =
        result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 8;
      if (!isReadSuccess) {
        throw new Error(
          `gh pr checks ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const requiredKeys = this.fetchRequiredCheckKeys(repoId, branch);
      const items: PrCheck[] = markRequired(
        parsedArray.map((row) => mapCheckRow(row)),
        requiredKeys,
      );
      return { checkSha: null, items };
    }

    // No usable JSON body. The "no checks" empty-set signal must come
    // from stderr — gh's stable channel for that message. We allow stdout
    // matching too, but ONLY when stdout failed to parse as JSON above
    // (so a non-empty JSON array is never bypassed). Generic 404s ("Not
    // Found") are not in the matcher and fall through to the exit-code
    // check.
    const stderrLower = result.stderr.toLowerCase();
    const stdoutNoChecksHint =
      stdoutTrim !== "" &&
      noChecksPhraseIn(stdoutTrim.toLowerCase());
    const isKnownNoChecks =
      noChecksPhraseIn(stderrLower) || stdoutNoChecksHint;
    if (isKnownNoChecks) return { checkSha: null, items: [] };
    const isReadSuccess =
      result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 8;
    if (!isReadSuccess) {
      throw new Error(
        `gh pr checks ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    // Empty stdout handling, by exit code:
    //   exit 0 (no checks at all) — legitimate empty-set; the §5 "no
    //         required checks → pass" rule is what's intended here.
    //   exit 1 (at least one check failed) — anomalous empty body
    //         (rate limit / transient error mapped to exit 1). Fail closed.
    //   exit 8 (checks pending) — empty body means "checks pending but no
    //         rows reported yet." That is NOT the same as "no checks";
    //         routing it to an empty items list would let classifyCi
    //         conclude pass under the spec §5 fallback. Fail closed by
    //         throwing — tick logs tick_error and retries on the next
    //         cycle, by which point gh should emit pending rows.
    if (stdoutTrim === "") {
      if (result.exitCode === 1) {
        throw new Error(
          `gh pr checks ${branch} exited 1 with empty body: ${result.stderr.trim() || "<no stderr>"}`,
        );
      }
      if (result.exitCode === 8) {
        throw new Error(
          `gh pr checks ${branch} exited 8 (pending) with empty body; cannot distinguish pending-no-rows from no-checks. Tick will retry next cycle.`,
        );
      }
      return { checkSha: null, items: [] };
    }
    // stdout non-empty but neither valid JSON nor a known "no checks"
    // text message — fail closed. (Note: `gh pr checks --json` is the
    // only place we read the per-row check SHA; `checkSha` is always
    // null at this layer and is rewritten by `prSnapshot` from a
    // `gh pr view --json headRefOid` bracket so the stale-SHA gate works.)
    throw new Error(
      `gh pr checks returned unparseable / non-array JSON for ${branch}: ${stdoutTrim.slice(0, 200)}`,
    );
  }

  private currentLogin(repoId: string): string {
    if (this.cachedLogin !== null) return this.cachedLogin;
    const result = this.run(repoId, ["gh", "api", "user", "--jq", ".login"]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh api user failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const login = result.stdout.trim();
    if (login === "") throw new Error("gh api user returned an empty login");
    this.cachedLogin = login;
    return login;
  }

  private fetchRequiredCheckKeys(repoId: string, branch: string): Set<string> {
    const fields = ["workflow", "name"].join(",");
    const result = this.run(repoId, [
      "gh",
      "pr",
      "checks",
      branch,
      "--required",
      "--json",
      fields,
    ]);
    // Same exit-code semantics as fetchChecks: 0/1/8 are read-success.
    // Parse a non-empty stdout as JSON FIRST. A required-check entry
    // whose workflow or name happens to contain the substring "no
    // checks" / "no required" must NOT short-circuit a real required
    // set to empty.
    const stdoutTrim = result.stdout.trim();
    const parsedArray = tryParseJsonArray(stdoutTrim);
    if (parsedArray !== null) {
      const isReadSuccess =
        result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 8;
      if (!isReadSuccess) {
        throw new Error(
          `gh pr checks --required ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const keys = new Set<string>();
      for (const row of parsedArray) {
        const r = (row ?? {}) as Record<string, unknown>;
        const workflow =
          r.workflow === null || r.workflow === undefined
            ? ""
            : String(r.workflow);
        const name = String(r.name ?? "");
        keys.add(
          requiredKeyOf({ workflow: workflow === "" ? null : workflow, name }),
        );
      }
      return keys;
    }

    // No usable JSON body. The "no required checks" empty-set signal
    // must come from stderr (gh's stable channel for that message), or
    // from a stdout body that failed JSON parsing — never from a
    // matching substring inside a successfully-parsed array.
    const stderrLower = result.stderr.toLowerCase();
    const stdoutNoChecksHint =
      stdoutTrim !== "" && noRequiredChecksPhraseIn(stdoutTrim.toLowerCase());
    const isKnownNoChecks =
      noRequiredChecksPhraseIn(stderrLower) || stdoutNoChecksHint;
    if (isKnownNoChecks) return new Set<string>();
    const isReadSuccess =
      result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 8;
    if (!isReadSuccess) {
      throw new Error(
        `gh pr checks --required ${branch} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    // Empty stdout handling, by exit code (mirrors fetchChecks).
    if (stdoutTrim === "") {
      if (result.exitCode === 1) {
        throw new Error(
          `gh pr checks --required ${branch} exited 1 with empty body: ${result.stderr.trim() || "<no stderr>"}`,
        );
      }
      if (result.exitCode === 8) {
        throw new Error(
          `gh pr checks --required ${branch} exited 8 (pending) with empty body; cannot distinguish pending-no-rows from no-required-checks. Tick will retry next cycle.`,
        );
      }
      return new Set<string>();
    }
    throw new Error(
      `gh pr checks --required returned unparseable / non-array JSON for ${branch}: ${stdoutTrim.slice(0, 200)}`,
    );
  }

  // Protected so tests can subclass and stub a fake `gh` without spinning
  // up a real binary. Production callers reach `gh` exclusively through
  // this method, so a subclass override has full control over command
  // dispatch.
  protected run(repoId: string, cmd: string[]): RunResult {
    const cwd = this.bareDir(repoId);
    // Forward `process.env` explicitly. Bun's `spawnSync` snapshots PATH at
    // process startup unless a caller passes `env`, so without this line a
    // test that stubs `gh` by mutating `process.env.PATH` at runtime would
    // be silently ignored — the real `gh` binary would still resolve.
    const result = Bun.spawnSync({
      cmd,
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode ?? 0,
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
    };
  }

  private bareDir(repoId: string): string {
    // Mirrors LocalGitAdapter.bareDir's containment check so a bypassed
    // schema can't smuggle a `repo_id` like `../escape` into a `gh` cwd.
    if (
      !/^[A-Za-z0-9._-]+$/.test(repoId) ||
      repoId === "." ||
      repoId === ".."
    ) {
      throw new Error(`repo_id "${repoId}" is not a safe identifier`);
    }
    const root = resolve(this.reposRoot);
    const dir = resolve(this.reposRoot, `${repoId}.git`);
    if (!dir.startsWith(`${root}/`) && dir !== root) {
      throw new Error(
        `repo_id "${repoId}" escapes reposRoot (${root}); refusing to operate`,
      );
    }
    return dir;
  }
}

function mapPrState(raw: unknown): PrTerminalState {
  // `gh` returns OPEN / CLOSED / MERGED on `state`. We collapse CLOSED into
  // closed_unmerged here; `merged` is its own state and does not double as
  // closed.
  const s = String(raw ?? "").toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed_unmerged";
  return "open";
}

function mapMergeable(raw: unknown): PrMergeableState {
  const s = String(raw ?? "").toUpperCase();
  if (s === "MERGEABLE") return "mergeable";
  if (s === "CONFLICTING") return "conflicting";
  return "unknown";
}

// Stable key for matching a check row across the two `gh pr checks` calls
// (unfiltered + `--required`). `gh` does not surface an opaque id, so we
// identify a check by `(workflow, name)`. The `\x1f` separator ensures the
// pair "workflow=foo, name=bar/baz" never collides with "workflow=foo/bar,
// name=baz" — Slack/GitHub display ambiguity that a plain space would
// preserve. Exported so the unit tests can exercise the join directly.
export function requiredKeyOf(c: { workflow: string | null; name: string }): string {
  return `${c.workflow ?? ""}\x1f${c.name}`;
}

// Walk the unfiltered check set and copy `required: true` onto items whose
// `(workflow, name)` matches an entry in `requiredKeys`. Pure and
// deterministic — exported for direct testing without a `gh` binary.
export function markRequired(items: PrCheck[], requiredKeys: Set<string>): PrCheck[] {
  return items.map((c) => ({ ...c, required: requiredKeys.has(requiredKeyOf(c)) }));
}

function mapCheckRow(row: unknown): PrCheck {
  const r = (row ?? {}) as Record<string, unknown>;
  const bucket = mapBucket(r.bucket);
  // `gh` does not expose a `required` boolean per check on every workflow;
  // when invoked without `--required` we get all checks and treat each as
  // non-required by default. The `--required` filtering for the spec's
  // "no ci_workflow_name" path is handled by tick reading the named
  // workflow filter directly. This is consistent with the adapter contract.
  return {
    name: String(r.name ?? ""),
    workflow:
      r.workflow === null || r.workflow === undefined
        ? null
        : String(r.workflow),
    bucket,
    required: false,
  };
}

// Try to parse `s` as a JSON array. Returns the array on success; null
// when the input is empty, not valid JSON, or valid JSON but not an
// array. Used by the gh-checks readers to drive the outcome from a
// trustworthy parsed body whenever one is present, and only fall back to
// stderr / textual hints when there is no JSON to parse.
function tryParseJsonArray(s: string): unknown[] | null {
  if (s === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function noChecksPhraseIn(lower: string): boolean {
  return (
    lower.includes("no checks") ||
    lower.includes("no check runs") ||
    lower.includes("no required checks")
  );
}

function noRequiredChecksPhraseIn(lower: string): boolean {
  // Anchored to "checks" / "check runs" only — a bare "no required"
  // substring would also match unrelated gh diagnostics like "no required
  // permissions" or "no required scope", routing real failures to an empty
  // required-set and letting the spec §5 fallback ("no required checks
  // → pass") fire on transient gh errors.
  return (
    lower.includes("no required checks") ||
    lower.includes("no check runs") ||
    lower.includes("no checks")
  );
}

function mapBucket(raw: unknown): PrCheckBucket {
  const s = String(raw ?? "").toLowerCase();
  if (s === "pass") return "pass";
  if (s === "fail") return "fail";
  if (s === "pending") return "pending";
  if (s === "skipping") return "skipping";
  // `gh pr checks --json bucket` reports cancelled checks as the literal
  // "cancel" (its own bucket vocabulary) — neither "cancelled" nor "canceled".
  // The conclusion column on the same row is "cancelled" (US English) or
  // "canceled" (recent gh versions). Recognise all three so a cancelled
  // required check counts as CI failure (`classifySet` → "fail") rather than
  // falling through to "pending" and stranding the task.
  if (s === "cancel" || s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
}

interface InlineReviewComment {
  path: string;
  line: number | null;
  body: string;
}

// Compose the reviewer-summary body and the per-line inline comments into a
// single markdown blob. Worker reads the resulting `review_comments`
// artifact verbatim, so the layout is the contract.
function composeReviewFeedback(
  body: string,
  inline: InlineReviewComment[],
): string {
  const trimmedBody = body.trim();
  if (inline.length === 0) return trimmedBody;
  const formatted = inline
    .map((c) => {
      const loc = c.line !== null ? `${c.path}:${c.line}` : c.path;
      const trimmed = c.body.trim();
      return trimmed === "" ? `- ${loc}` : `- ${loc} — ${trimmed}`;
    })
    .join("\n");
  const header = `Inline review comments (${inline.length}):`;
  if (trimmedBody === "") return `${header}\n${formatted}`;
  return `${trimmedBody}\n\n${header}\n${formatted}`;
}

function extractLatestReview(parsed: Record<string, unknown>): PrLatestReview {
  const decision = mapReviewDecision(parsed.reviewDecision);
  const latest = Array.isArray(parsed.latestReviews)
    ? (parsed.latestReviews as Array<Record<string, unknown>>)
    : [];
  let pick: Record<string, unknown> | null = null;
  let comments = "";
  if (latest.length > 0) {
    // `gh` returns reviews ordered chronologically; pick the last
    // CHANGES_REQUESTED review when the decision says CHANGES_REQUESTED so
    // the dedupe key (`last_review_id_acted_on`) is stable.
    const wanted =
      decision === "CHANGES_REQUESTED"
        ? latest.filter(
            (r) => String(r.state ?? "").toUpperCase() === "CHANGES_REQUESTED",
          )
        : latest;
    pick = wanted[wanted.length - 1] ?? null;
    if (pick) {
      comments = pick.body !== undefined ? String(pick.body) : "";
    }
  }
  const latestReviewId = resolveReviewNodeId(pick, parsed);
  return { decision, latestReviewId, comments };
}

// Recover the review node id for the picked `latestReviews` entry. Some
// `gh` versions return `latestReviews[].id` as the empty string while the
// same review surfaces under `--json reviews` with the real GraphQL node
// id (`PRR_…`). Trust `latestReviews[].id` when populated; otherwise walk
// `reviews` newest-first and match by state (preferring an exact
// `submittedAt` match when both sides expose one). Return null when no
// usable id can be resolved — the enrichment guard skips the graphql
// fetch on null so tick doesn't loop on empty-id errors.
function resolveReviewNodeId(
  picked: Record<string, unknown> | null,
  parsed: Record<string, unknown>,
): string | null {
  if (picked === null) return null;
  const pickedId = picked.id !== undefined ? String(picked.id) : "";
  if (pickedId !== "") return pickedId;
  const reviews = Array.isArray(parsed.reviews)
    ? (parsed.reviews as Array<Record<string, unknown>>)
    : [];
  if (reviews.length === 0) return null;
  const pickedState = String(picked.state ?? "").toUpperCase();
  const pickedSubmittedAt = String(picked.submittedAt ?? "");
  let stateMatch: string | null = null;
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const r = reviews[i] ?? {};
    const id = String(r.id ?? "");
    if (id === "") continue;
    const state = String(r.state ?? "").toUpperCase();
    if (state !== pickedState) continue;
    const submittedAt = String(r.submittedAt ?? "");
    if (pickedSubmittedAt !== "" && submittedAt === pickedSubmittedAt) {
      return id;
    }
    if (stateMatch === null) stateMatch = id;
  }
  return stateMatch;
}

function mapReviewDecision(raw: unknown): PrReviewDecision {
  const s = String(raw ?? "").toUpperCase();
  if (s === "APPROVED") return "APPROVED";
  if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  if (s === "COMMENTED") return "COMMENTED";
  return "NONE";
}

function mapPostedReviewDecision(
  raw: unknown,
): PostedReview["decision"] | null {
  const s = String(raw ?? "").toUpperCase();
  if (s === "APPROVED") return "APPROVED";
  if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  if (s === "COMMENTED") return "COMMENTED";
  return null;
}

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

function toFiniteIntegerOrNull(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isFinite(raw)) return null;
  if (!Number.isInteger(raw)) return null;
  return raw;
}

// `join` is exported so adapter contract tests can compute the bare-clone
// path without duplicating the convention.
export const _bareCloneSubpath = (repoId: string): string =>
  join(`${repoId}.git`);

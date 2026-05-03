// Real Slack adapter. Posts and reads via the Slack Web API using `fetch`.
// The bot token is sourced from `SLACK_TOKEN` (spec §11 Slack integration).
//
// Thread refs are encoded as `<channel>:<ts>` everywhere in Quay; this
// adapter parses that encoding once at the boundary and uses the structured
// pieces internally. Failures throw — tick wraps the throw in `tick_error`
// and retries on the next cycle (spec §5).
import type {
  SlackPort,
  SlackPostInput,
  SlackPostResult,
  SlackReply,
} from "../ports/slack.ts";

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
}

// Default per-call timeout for the synchronous child fetch. Configurable via
// QUAY_SLACK_TIMEOUT_MS at the deployment level; the adapter forwards it to
// the child so a stalled Slack connection cannot hold the supervisor lock
// indefinitely (spec §5: tick must record `tick_error` and continue, not
// block the next cycle).
const DEFAULT_SLACK_TIMEOUT_MS = 30_000;
// How long the parent waits past the child's own timeout before treating the
// child as wedged and killing it. The child's AbortController is the primary
// mechanism; this is a backstop if the child's runtime itself hangs.
const PARENT_TIMEOUT_GRACE_MS = 5_000;

export class SlackAdapter implements SlackPort {
  // The token is resolved lazily on first use so the production CLI can
  // construct this adapter unconditionally — a deployment without any
  // `waiting_human` tasks should not need `SLACK_TOKEN` set just to run
  // `quay tick`. The error surfaces only when tick actually tries to talk
  // to Slack.
  private readonly endpoint: string;
  private readonly explicitToken: string | null;
  private readonly timeoutMs: number;

  constructor(opts?: { token?: string; endpoint?: string; timeoutMs?: number }) {
    this.explicitToken =
      opts?.token !== undefined && opts.token !== "" ? opts.token : null;
    this.endpoint = opts?.endpoint ?? "https://slack.com/api";
    this.timeoutMs =
      opts?.timeoutMs !== undefined && opts.timeoutMs > 0
        ? opts.timeoutMs
        : resolveTimeoutFromEnv();
  }

  private resolveToken(): string {
    if (this.explicitToken !== null) return this.explicitToken;
    const fromEnv = process.env.SLACK_TOKEN ?? "";
    if (fromEnv === "") {
      throw new Error(
        "SlackAdapter requires SLACK_TOKEN to be set in the environment for any Slack API call",
      );
    }
    return fromEnv;
  }

  post(input: SlackPostInput): SlackPostResult {
    const { channel, ts: parentTs } = parseThreadRef(input.threadRef);
    const body = {
      channel,
      thread_ts: parentTs,
      text: input.body,
    };
    const data = this.callSync<{ ts: string }>("chat.postMessage", body);
    if (typeof data.ts !== "string" || data.ts.length === 0) {
      throw new Error(
        `Slack chat.postMessage returned no ts for thread ${input.threadRef}`,
      );
    }
    return { ts: data.ts };
  }

  fenceTs(threadRef: string): string {
    const replies = this.fetchReplies(threadRef);
    if (replies.length === 0) {
      // Empty thread (no parent reachable) — return a sentinel "earlier than
      // anything" ts so any subsequent post is strictly later. Slack ts are
      // floats encoded as strings; "0" is well below any real value.
      return "0.000000";
    }
    return replies[replies.length - 1]!.ts;
  }

  searchByNonce(threadRef: string, nonce: string): SlackReply | null {
    // Spec §5 Sequence B step 3: scan the thread for a *bot-authored* message
    // whose body contains the per-escalation nonce. Not search.messages —
    // workspaces frequently disable that scope, and conversations.replies is
    // the same data source we already use for reply ingestion.
    const replies = this.fetchReplies(threadRef);
    for (const m of replies) {
      if (!isBotAuthored(m)) continue;
      if ((m.text ?? "").includes(nonce)) {
        return { ts: m.ts, authorBot: true, text: m.text ?? "" };
      }
    }
    return null;
  }

  listReplies(threadRef: string, lowerBoundTs: string): SlackReply[] {
    const replies = this.fetchReplies(threadRef);
    const lb = Number(lowerBoundTs);
    return replies
      .filter((m) => Number(m.ts) > lb)
      .map((m) => ({
        ts: m.ts,
        authorBot: isBotAuthored(m),
        text: m.text ?? "",
      }));
  }

  // -- helpers ----------------------------------------------------------

  private fetchReplies(threadRef: string): SlackMessage[] {
    const { channel, ts } = parseThreadRef(threadRef);
    // conversations.replies is paginated. v1 fetches a single page; threads
    // longer than ~200 messages would need cursor handling. The spec
    // explicitly defers paging optimization — escalation threads in practice
    // sit in the low double digits.
    const data = this.callSync<{ messages: SlackMessage[] }>(
      "conversations.replies",
      { channel, ts, limit: 200 },
      "GET",
    );
    return Array.isArray(data.messages) ? data.messages : [];
  }

  private callSync<T>(
    method: string,
    payload: Record<string, unknown>,
    httpMethod: "POST" | "GET" = "POST",
  ): T {
    const token = this.resolveToken();
    // Slack's Web API returns JSON with `{ ok: bool, error?: string, ... }`.
    // Quay treats any `ok=false` as a thrown error so tick's per-task error
    // path logs `tick_error`. Network/HTTP failures bubble up the same way.
    const url =
      httpMethod === "GET"
        ? `${this.endpoint}/${method}?${encodeForm(payload)}`
        : `${this.endpoint}/${method}`;
    const init: RequestInit =
      httpMethod === "GET"
        ? {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          }
        : {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(payload),
          };
    // SlackPort is synchronous (every tick handler relies on it) but Bun's
    // `fetch` is async-only, so we run the HTTP call in a child Bun
    // process and `spawnSync`-wait on it. ALL request fields (token, URL,
    // body) are passed via the child's env — argv is visible in `ps` /
    // `/proc/<pid>/cmdline` for the child's lifetime, so anything routed
    // through argv leaks the message text (escalation question, blocker
    // excerpt, dedupe nonce) and the GET query (channel id, parent thread
    // ts) to any local reader on a multi-tenant host. Only the http method
    // (POST/GET) stays on argv since it is a fixed enum with no operator
    // content.
    //
    // The child wraps `fetch` in an AbortController gated on
    // `QUAY_SLACK_TIMEOUT_MS` so a stalled HTTP connection aborts cleanly
    // and the child exits non-zero. As a backstop, the parent's
    // `spawnSync` carries a slightly longer `timeout` so a wedged child
    // runtime can't hold the supervisor lock past the bounded budget.
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        slackFetchScript(),
        init.method ?? "GET",
      ],
      env: {
        ...process.env,
        QUAY_SLACK_TOKEN: token,
        QUAY_SLACK_URL: url,
        QUAY_SLACK_BODY:
          init.body !== undefined && init.body !== null
            ? String(init.body)
            : "",
        QUAY_SLACK_TIMEOUT_MS: String(this.timeoutMs),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: this.timeoutMs + PARENT_TIMEOUT_GRACE_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Slack ${method} child process failed (exit ${result.exitCode}): ${decode(result.stderr).trim()}`,
      );
    }
    let parsed: { ok: boolean; error?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(decode(result.stdout));
    } catch (err) {
      throw new Error(
        `Slack ${method} returned unparseable JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed.ok) {
      throw new Error(
        `Slack ${method} failed: ${parsed.error ?? "unknown error"}`,
      );
    }
    return parsed as unknown as T;
  }
}

function parseThreadRef(threadRef: string): { channel: string; ts: string } {
  // `<channel>:<ts>` per spec §11. The colon split is unambiguous because
  // both Slack channel ids and Slack timestamps are safe charsets that
  // never contain `:`.
  const idx = threadRef.indexOf(":");
  if (idx <= 0 || idx >= threadRef.length - 1) {
    throw new Error(
      `invalid Slack thread ref "${threadRef}"; expected "<channel>:<ts>"`,
    );
  }
  return { channel: threadRef.slice(0, idx), ts: threadRef.slice(idx + 1) };
}

function isBotAuthored(msg: SlackMessage): boolean {
  // Slack flags bot posts via `bot_id`. The thread's parent message (the
  // ticket post the orchestrator is replying into) often has neither a
  // `bot_id` nor a `user` matching ours; treat anything without a `bot_id`
  // as human-authored. Subtype `bot_message` is also a strong signal.
  if (msg.bot_id !== undefined && msg.bot_id !== "") return true;
  if (msg.subtype === "bot_message") return true;
  return false;
}

function encodeForm(payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

function resolveTimeoutFromEnv(): number {
  const raw = process.env.QUAY_SLACK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SLACK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLACK_TIMEOUT_MS;
  return Math.floor(parsed);
}

// Child-process script: argv = [_, _, method]; everything sensitive
// (token, URL with query string, body) comes in via env vars so it
// never appears in `ps` / `/proc/<pid>/cmdline`. `QUAY_SLACK_TIMEOUT_MS`
// bounds how long the child waits on `fetch` before aborting and
// exiting non-zero — the supervisor lock is held for the duration of
// this call, so an unbounded fetch would block `quay cancel` and the
// next tick. Errors print to stderr and exit non-zero. Embedded as a
// string so the parent never needs a separate file.
function slackFetchScript(): string {
  return `
const [method] = process.argv.slice(1);
const token = process.env.QUAY_SLACK_TOKEN || "";
const url = process.env.QUAY_SLACK_URL || "";
const body = process.env.QUAY_SLACK_BODY || "";
if (!token) {
  process.stderr.write("QUAY_SLACK_TOKEN not set in child env");
  process.exit(1);
}
if (!url) {
  process.stderr.write("QUAY_SLACK_URL not set in child env");
  process.exit(1);
}
const timeoutMs = Number(process.env.QUAY_SLACK_TIMEOUT_MS || "30000");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
const init = {
  method,
  headers: { Authorization: "Bearer " + token },
  signal: controller.signal,
};
if (method !== "GET" && body) {
  init.headers["Content-Type"] = "application/json; charset=utf-8";
  init.body = body;
}
fetch(url, init)
  .then(async (r) => {
    const text = await r.text();
    process.stdout.write(text);
  })
  .catch((err) => {
    const isAbort =
      (err && (err.name === "AbortError" || err.name === "TimeoutError")) ||
      /aborted|abort/i.test(String(err && err.message ? err.message : err));
    if (isAbort) {
      process.stderr.write("Slack request timed out after " + timeoutMs + "ms");
    } else {
      process.stderr.write(String(err && err.message ? err.message : err));
    }
    process.exit(1);
  })
  .finally(() => clearTimeout(timer));
`;
}

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

export class SlackAdapter implements SlackPort {
  // The token is resolved lazily on first use so the production CLI can
  // construct this adapter unconditionally — a deployment without any
  // `waiting_human` tasks should not need `SLACK_TOKEN` set just to run
  // `quay tick`. The error surfaces only when tick actually tries to talk
  // to Slack.
  private readonly endpoint: string;
  private readonly explicitToken: string | null;

  constructor(opts?: { token?: string; endpoint?: string }) {
    this.explicitToken =
      opts?.token !== undefined && opts.token !== "" ? opts.token : null;
    this.endpoint = opts?.endpoint ?? "https://slack.com/api";
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
    // Bun supports synchronous `fetch` only via `await`; we run the call
    // inside `Atomics.wait`-free deasync via `Bun.spawnSync`-style? No — we
    // just await within a synchronous wrapper through `Bun.serve`-free
    // approach: Slack must be called async-only. Refactor: callSync returns
    // a Promise via `then` chain blocked using `await`-on-thenable.
    // Bun gives us `await` only inside async; the SlackPort interface is
    // synchronous, so we use `bun:ffi`-free synchronous `fetch` via the
    // `--experimental-fetch-sync` path is unavailable. Instead, surface the
    // call as truly synchronous by spawning a child Bun process.
    //
    // In practice: tick is a one-shot CLI invocation, and a child-process
    // round-trip per Slack call adds milliseconds — acceptable. The
    // alternative is to redesign SlackPort as async, which ripples through
    // every tick handler. We choose the small synchronous-shim cost over the
    // large refactor.
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        slackFetchScript(),
        url,
        init.method ?? "GET",
        init.body !== undefined && init.body !== null
          ? String(init.body)
          : "",
        token,
      ],
      stdout: "pipe",
      stderr: "pipe",
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

// Child-process script: argv = [_, _, url, method, body, token]. Executes a
// single fetch against `url` with the given method/body and prints the
// response body to stdout. Errors print to stderr and exit non-zero.
function slackFetchScript(): string {
  // Embedded as a string so the parent never needs a separate file. Kept
  // small and dependency-free.
  return `
const [url, method, body, token] = process.argv.slice(1);
const init = { method, headers: { Authorization: "Bearer " + token } };
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
    process.stderr.write(String(err && err.message ? err.message : err));
    process.exit(1);
  });
`;
}

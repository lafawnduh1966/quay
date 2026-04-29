import type {
  SlackPort,
  SlackPostInput,
  SlackPostResult,
  SlackReply,
} from "../../../src/ports/slack.ts";

interface FakeMessage {
  ts: string;
  authorBot: boolean;
  text: string;
}

export class FakeSlack implements SlackPort {
  postCalls: SlackPostInput[] = [];
  fenceCalls: string[] = [];
  searchCalls: { threadRef: string; nonce: string }[] = [];
  listCalls: { threadRef: string; lowerBoundTs: string }[] = [];

  private threads = new Map<string, FakeMessage[]>();
  private tsCounter = 0;
  private postFailureQueue: Error[] = [];
  private fenceFailureQueue: Error[] = [];
  private listFailureQueue: Error[] = [];
  private searchFailureQueue: Error[] = [];

  private getThread(threadRef: string): FakeMessage[] {
    let thread = this.threads.get(threadRef);
    if (!thread) {
      thread = [];
      this.threads.set(threadRef, thread);
    }
    return thread;
  }

  private nextTs(): string {
    this.tsCounter += 1;
    // ts strings are zero-padded so both numeric and alphabetic comparison
    // produce a consistent total order.
    return `1.${String(this.tsCounter).padStart(8, "0")}`;
  }

  // Test helpers ---------------------------------------------------------

  appendBotMessage(threadRef: string, text: string): string {
    const ts = this.nextTs();
    this.getThread(threadRef).push({ ts, authorBot: true, text });
    return ts;
  }

  appendHumanReply(threadRef: string, text: string): string {
    const ts = this.nextTs();
    this.getThread(threadRef).push({ ts, authorBot: false, text });
    return ts;
  }

  failPostOnce(message = "fake: slack post failed"): void {
    this.postFailureQueue.push(new Error(message));
  }

  failFenceOnce(message = "fake: slack fence failed"): void {
    this.fenceFailureQueue.push(new Error(message));
  }

  failListOnce(message = "fake: slack list failed"): void {
    this.listFailureQueue.push(new Error(message));
  }

  failSearchOnce(message = "fake: slack search failed"): void {
    this.searchFailureQueue.push(new Error(message));
  }

  totalCalls(): number {
    return (
      this.postCalls.length +
      this.fenceCalls.length +
      this.searchCalls.length +
      this.listCalls.length
    );
  }

  // Port impl ------------------------------------------------------------

  post(input: SlackPostInput): SlackPostResult {
    this.postCalls.push({ ...input });
    const failure = this.postFailureQueue.shift();
    if (failure) throw failure;
    const ts = this.appendBotMessage(input.threadRef, input.body);
    return { ts };
  }

  fenceTs(threadRef: string): string {
    this.fenceCalls.push(threadRef);
    const failure = this.fenceFailureQueue.shift();
    if (failure) throw failure;
    const thread = this.getThread(threadRef);
    if (thread.length === 0) return "0.00000000";
    return thread[thread.length - 1]!.ts;
  }

  searchByNonce(threadRef: string, nonce: string): SlackReply | null {
    this.searchCalls.push({ threadRef, nonce });
    const failure = this.searchFailureQueue.shift();
    if (failure) throw failure;
    const thread = this.getThread(threadRef);
    for (const msg of thread) {
      if (msg.authorBot && msg.text.includes(nonce)) {
        return { ts: msg.ts, authorBot: true, text: msg.text };
      }
    }
    return null;
  }

  listReplies(threadRef: string, lowerBoundTs: string): SlackReply[] {
    this.listCalls.push({ threadRef, lowerBoundTs });
    const failure = this.listFailureQueue.shift();
    if (failure) throw failure;
    const thread = this.getThread(threadRef);
    const lb = Number(lowerBoundTs);
    return thread
      .filter((m) => Number(m.ts) > lb)
      .map((m) => ({ ts: m.ts, authorBot: m.authorBot, text: m.text }));
  }
}

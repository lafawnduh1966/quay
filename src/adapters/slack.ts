// Real Slack adapter. Slice 10 step 7 (stub). Contract tests gated behind
// QUAY_INTEGRATION_TESTS=1 and skipped by default.
import type {
  SlackPort,
  SlackPostInput,
  SlackPostResult,
  SlackReply,
} from "../ports/slack.ts";

export class SlackAdapter implements SlackPort {
  post(_input: SlackPostInput): SlackPostResult {
    throw new Error("SlackAdapter.post not implemented yet");
  }
  fenceTs(_threadRef: string): string {
    throw new Error("SlackAdapter.fenceTs not implemented yet");
  }
  searchByNonce(_threadRef: string, _nonce: string): SlackReply | null {
    throw new Error("SlackAdapter.searchByNonce not implemented yet");
  }
  listReplies(_threadRef: string, _lowerBoundTs: string): SlackReply[] {
    throw new Error("SlackAdapter.listReplies not implemented yet");
  }
}

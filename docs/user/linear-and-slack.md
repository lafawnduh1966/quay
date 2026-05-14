# Linear And Slack

Linear and Slack integrations are opt-in deployment adapters.

For complete token, scope, channel membership, and scheduler environment setup,
see [External Services Setup](external-services.md).

## Configuration

```toml
[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
max_thread_messages = 200
```

Default env vars:

```bash
export LINEAR_API_KEY=...
export SLACK_TOKEN=...
```

You can rename those env vars with `api_key_env` and `bot_token_env`.

## Linear Enqueue Flow

```bash
quay enqueue --repo myrepo --linear-issue ENG-1234
```

The flow is:

1. Resolve the Linear issue.
2. Reject draft tickets.
3. Parse the ticket's `quay-config` block.
4. Fetch Slack thread context if the block has `slack_thread` and Slack is
   enabled.
5. Compose a canonical brief and ticket snapshot.
6. Run `quay validate-ticket`.
7. Enqueue through the normal substrate path.

If Linear is disabled, the command fails with `adapter_not_enabled`. If the
token env var is missing, it fails with `adapter_not_configured`.

## Slack Context At Enqueue

The `quay-config` block can include a Slack permalink:

```yaml
slack_thread: https://example.slack.com/archives/C123456/p1712345678901234
```

The parser converts that URL to Quay's internal thread ref:

```text
C123456:1712345678.901234
```

When Slack is enabled, Quay fetches the parent message and replies and includes
them in the brief. Long threads are capped by `max_thread_messages` and
truncated with a marker.

When Slack is disabled, enqueue can still proceed, but Slack thread context is
not fetched.

## Human Escalation

`quay escalate-human` persists a `slack_escalation_post` artifact, records a
nonce, and transitions the task to `waiting_human` while preserving the
orchestrator claim. Quay does not post to Slack for this new flow. The
orchestrator chooses the Slack route, posts the question, waits for the answer,
then calls `quay record-human-reply` followed by
`quay submit-brief --reason advice_answered`.

Claimless legacy `waiting_human` rows still use the old tick-owned Slack
posting/reply ingestion path when they already have a `slack_thread_ref`. Legacy
rows without a thread are requeued to `awaiting-next-brief` so the orchestrator
can apply deployment-owned fallback routing.

If the task has authors from a Linear `quay-config` block, Quay prefixes valid
Slack user mentions on the escalation post.

## Timeouts

Network calls are synchronous from Quay's perspective and have deployment
timeouts:

```bash
export QUAY_LINEAR_TIMEOUT_MS=30000
export QUAY_SLACK_TIMEOUT_MS=30000
```

Invalid or missing timeout values fall back to the implementation defaults.

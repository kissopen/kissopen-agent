# Chat Completions providers: DeepSeek and Kimi

`sources/protocol/chatCompletions/` implements the OpenAI Chat Completions protocol once, as
`ChatCompletionsProvider` and `ChatCompletionsSession`. `DeepSeekProvider` and `KimiProvider`
configure it with an endpoint, an API key, and a model resolver; they add no protocol code.

## Evidence and provenance

There is no native coding client whose traffic these providers reproduce, and no golden trace has
been captured. The wire shape follows DeepSeek's and Moonshot's published API documentation, and
the tests replay hand-written SSE fixtures through a mocked `fetch`. Treat every vendor-specific
rule below as documented behavior that still needs a recorded response: when a real failure or
stream is observed, record it under `tests/vendors/fixtures/` and replay it through the transport.

## Request

`POST {baseUrl}/chat/completions` with a bearer key, `stream: true`, and
`stream_options: { include_usage: true }`. The instructions are the first `system` message.

- **Messages.** User text is sent as a string. System and agent notices become
  `<system-reminder>` user turns at the position the caller chose, as the Anthropic protocol does.
  A plaintext compaction checkpoint becomes the user message
  `Conversation continuation checkpoint (historical context):\n…`; an opaque checkpoint without
  text is left out.
- **Images.** Sent as `image_url` data URLs only when the model profile declares `vision`.
  Otherwise, and always inside tool results, each image becomes a one-line text note.
- **Reasoning replay.** `reasoning_content` is attached only to assistant messages that carry
  tool calls and follow the last user message. DeepSeek and Kimi thinking modes require the
  reasoning of the current tool-use turn back and do not want earlier turns' reasoning.
- **Tool-call pairing.** The endpoints reject a history where an assistant `tool_calls` entry is
  not followed by its `tool` answer. A missing answer becomes a short placeholder, an answer
  without its call is dropped, and any other message that sits between a call and its answer
  moves after the answers. Arguments that are not a JSON object (a truncated call) are sent as
  `{}`. All of this is a projection of one request; caller history is never changed.
- **Tools.** JSON-schema functions only. Server tools are left out. `defer` is ignored, so deferred
  tools are sent eagerly, as every provider without native discovery does. A namespaced tool is
  `mcp__<namespace>__<name>`; names outside `[A-Za-z0-9_-]{1,64}` keep a readable prefix and an
  eight-character hash, and a per-request table maps streamed names back to the caller's name and
  namespace. A grammar tool becomes a function taking one `input` string, with the Lark grammar in
  its description; the call's `input` is unwrapped before `toolcall_end`, and the call carries
  `vendor: { type: "chat_completions_freeform" }` so replay wraps it again.
- **Structured output.** `json_schema` by default; DeepSeek and Kimi use `json_object` with the
  schema stated in an extra system message, since neither accepts a schema.

## Stream

`delta.reasoning_content` streams as reasoning and `delta.content` as text; the open block closes
before the other opens and before any tool call starts. Tool calls are keyed by `index`; a call
starts once its name is known and every call ends, in index order, when the response finishes.
Usage is read from the top-level `usage` chunk or from the finishing choice (Moonshot), with cache
hits from `prompt_cache_hit_tokens` (DeepSeek), `prompt_tokens_details.cached_tokens`, or
`cached_tokens` (Moonshot) as `cacheRead`. `stop` ends the turn normally, `tool_calls` (or any
finish with calls) ends with `tool_call`, and `length` ends with `length` and marks calls
incomplete. `content_filter` is a terminal error; DeepSeek's `insufficient_system_resource` is a
retryable server error. SSE comments such as DeepSeek's `: keep-alive` are ignored.

## Errors and retries

Every attempt is one event block. Before any output has streamed, network errors, response-start
and idle timeouts (150 s and 180 s by default), a stream that closes without a finish reason,
HTTP 408, 409, 429, and 5xx are retried within the inference retry budget after a `block_reset`
and a `retrying` event, honoring `retry-after` up to 60 s. After output has begun a failure is
terminal, so replay never duplicates visible output. An empty response (no text, no tool calls,
zero output tokens) is retried like everywhere else in this package.

HTTP 401 and 403 are terminal `authentication` errors. HTTP 402, and a 429 whose error names a
quota, balance, or billing problem (Moonshot's `exceeded_current_quota_error`), are terminal
`billing_error` / `out_of_tokens`. HTTP 413, and a 400 or 422 whose message mentions the context
length or token limit, are `context_overflow`.

## Compaction

Neither vendor has native compaction. `compact()` runs one tool-less request with the portable
continuation-checkpoint prompt and returns a compaction message whose `content` is the summary
and whose `encryptedContent` is `null`; the next run sends it as the checkpoint user message.

## Vendors

| Provider | Default base URL             | Key                                     | Model IDs                |
| -------- | ---------------------------- | --------------------------------------- | ------------------------ |
| DeepSeek | `https://api.deepseek.com`   | `DEEPSEEK_API_KEY`                      | `deepseek/<id>` → `<id>` |
| Kimi     | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY`, then `KIMI_API_KEY` | `moonshot/<id>` → `<id>` |

`deepseek-chat` requests its documented 8K output maximum because the 4K default is too small for
an agent; `deepseek-reasoner` keeps its 32K default. Kimi K2 models request 32,000 output tokens
and Moonshot's recommended temperatures, 0.6 for K2 and 1.0 for K2 Thinking. No catalog model
accepts images. International Moonshot accounts set the base URL to `https://api.moonshot.ai/v1`.

## DeepSeek V4 (2026-09-27)

DeepSeek now serves `deepseek-flash` (DeepSeek-V4.1-Flash, reads images) and `deepseek-v4-pro`
(DeepSeek-V4-Pro-0813, text only), both with a 1M context and thinking on by default
(api-docs.deepseek.com, 模型 & 价格 and 思考模式). The older `deepseek-chat` / `deepseek-reasoner`
names still answer but are not what the catalog offers.

- Thinking is switched with `thinking: {type: "enabled" | "disabled"}` and sized with
  `reasoning_effort` (`low` / `high` / `max`; DeepSeek maps medium and xhigh to high). The agent's
  `off` effort disables thinking; the profile's `thinkingControl: "deepseek"` sends both fields.
- With `tools` in the request, **every** earlier assistant message must carry its
  `reasoning_content` back, or the request is refused with 400 — not only the current tool-use
  turn's, which is what Kimi needs. The profile's `reasoningReplay: "all"` sends it on every
  assistant message (an empty string for one another model wrote) whenever thinking is on and
  tools are present.
- `max_tokens` is 65,536: thinking counts against the output budget.

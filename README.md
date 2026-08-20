# n8n-nodes-claude-refine

[![npm version](https://img.shields.io/npm/v/n8n-nodes-claude-refine.svg)](https://www.npmjs.com/package/n8n-nodes-claude-refine)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-claude-refine.svg)](https://www.npmjs.com/package/n8n-nodes-claude-refine)
[![license](https://img.shields.io/npm/l/n8n-nodes-claude-refine.svg)](LICENSE.md)

This is an n8n community node package for the **[Anthropic Claude API](https://platform.claude.com/docs/en/home)** — the REST API behind the Claude models. It covers the parts of the API the built-in n8n Anthropic nodes don't: **prompt caching** with explicit breakpoints, **message batches** at 50% cost, **token counting**, **extended thinking and effort control**, **structured outputs**, **citations**, **server tools** (web search, web fetch, code execution) and the **Files** and **Models** APIs — all from one node, with an escape hatch to call any other endpoint.

It ships one node:

- **Claude Refine** — Message, Batch, File, Model and Custom API Call resources on your Anthropic account.

> 💾 **Why "refine"?** The node is built around the features that make Claude cheap and precise in production automations: cached prefixes cost ~10% to read and don't count toward input-token rate limits, and batches halve the price of bulk work.

[Installation](#installation) · [Credentials](#credentials) · [Resources & operations](#resources--operations) · [Prompt caching](#prompt-caching) · [Usage examples](#usage-examples) · [Model parameter rules](#model-parameter-rules) · [Known limitations](#known-limitations)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

Self-hosted n8n: **Settings → Community Nodes → Install** and enter `n8n-nodes-claude-refine`.

Requirements:

- n8n ≥ 1.86.0 (the node uses the modern connection types and can be used as an AI Agent tool)
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

## Credentials

Create a **Claude Refine API** credential:

| Field    | Description                                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| API Key  | Anthropic API key (`sk-ant-…`), created in the Anthropic Console under **API Keys**      |
| Base URL | `https://api.anthropic.com` by default — change it only for compatible gateways/proxies  |

> 🔐 **Recommendation:** use a workspace-scoped API key so the node only sees the files and batches of that workspace.

The credential test lists models, so a key with basic access is enough to validate it.

## Resources & operations

### Message

| Operation    | Description                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Send         | POST `/v1/messages` — full-featured: caching, thinking, tools, attachments, citations, structured outputs |
| Count Tokens | POST `/v1/messages/count_tokens` — free, exact, model-specific token count of a request              |

**Send** supports three input types:

- **Simple Prompt** — one user message.
- **Messages Builder** — multi-turn conversations built in the UI, with a per-message *Cache Up to Here* breakpoint.
- **Raw Messages (JSON)** — the raw `messages` array, for full control (tool_result loops, thinking blocks passed back, custom `cache_control` placement, mid-conversation `system` messages on supported models).

Plus, as dedicated sections:

- **Attachments** — images and documents (URL, binary property, base64 or an uploaded Anthropic file ID), with document **citations**.
- **Prompt Caching** — breakpoints on the system prompt, tool definitions and/or the conversation, each with a 5-minute or 1-hour TTL.
- **Extended Thinking** — adaptive (recommended on Claude 4.6+), disabled, or legacy token budgets for older models, with display control.
- **Tools** — custom tools (JSON definitions returned as `tool_use` blocks), plus Anthropic server tools: **Web Search** (with domain filters), **Web Fetch** and **Code Execution**.
- **Output** — `effort` (low → max) and **structured outputs** (JSON Schema-constrained responses, parsed into a `parsed` field).
- **Options** — temperature/top-p/top-k, stop sequences, `metadata.user_id`, service tier, inference region, custom `anthropic-beta` headers, response rate-limit headers, request timeout and a **Request Body Overrides** JSON merged last (MCP connector, container reuse, context management, fallbacks, task budgets…).

The default **Simplify Output** returns `{ id, model, text, stopReason, stopDetails?, thinking?, toolUses?, citations?, serverToolResults?, parsed?, usage }`. The `usage` block always includes `cache_creation_input_tokens` and `cache_read_input_tokens`, so you can verify caching works. Disable it to get the raw API response.

### Batch

| Operation   | Description                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Create      | POST `/v1/messages/batches` — up to 100,000 requests, 50% of the standard price                |
| Get         | Batch status — poll until `processing_status` is `ended`                                       |
| Get Many    | List the batches of the workspace                                                              |
| Get Results | Download and parse the results file — one n8n item per request, matched by `custom_id`         |
| Cancel      | Cancel a batch in progress                                                                     |
| Delete      | Delete an ended batch                                                                          |

**Create** has two modes: **Build From Input Items** (every incoming item becomes one request of a single batch — use expressions for the per-item prompt and custom ID) and **Raw JSON** (provide the `requests` array yourself, with any Messages API feature in `params`).

### File

| Operation | Description                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------- |
| Upload    | Upload a binary once, then reference it in messages by file ID (no re-sending per request)      |
| Get       | File metadata                                                                                   |
| Get Many  | List files of the workspace                                                                     |
| Download  | Download file content to binary — for files produced by code execution                          |
| Delete    | Delete a file                                                                                   |

### Model

| Operation | Description                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------- |
| Get       | One model with `max_input_tokens`, `max_tokens` and its full `capabilities` tree                    |
| Get Many  | All models available to the key — also feeds the model dropdowns of the other resources             |

### Custom API Call

Call any other Anthropic endpoint (skills, usage/admin endpoints…) with the node credential: method, path, query, JSON body, custom `anthropic-beta` headers, optional full response.

## Prompt caching

The headline feature. Place up to 4 breakpoints per request (the node exposes 3 fixed ones plus per-message breakpoints in the builder):

1. **Cache Tool Definitions** — after the last tool.
2. **Cache System Prompt** — after the system prompt.
3. **Cache Conversation** — on the last message (ideal for chat loops: each turn re-reads the previous turns from cache).

Rules to know (enforced by the API, surfaced in the node descriptions):

- Prefix caching is **byte-exact and ordered** `tools → system → messages`: keep stable content first, volatile content (timestamps, per-run IDs) after the last breakpoint.
- Prefixes below the model minimum (512–4096 tokens depending on the model) are **silently not cached**.
- Writes cost 1.25× (5m) or 2× (1h); reads cost ~0.1× and don't count toward input-token rate limits.
- Verify with `usage.cache_read_input_tokens` in the output — if it stays 0 across identical runs, something in your prefix changes every time.

## Usage examples

- **Cached RAG / chat memory** — Send (*Messages Builder*) → paste the knowledge base into the System Prompt → `Prompt Caching → Cache System Prompt: 1 Hour`. Subsequent runs read the base from cache at ~10% cost.
- **Bulk classification at half price** — feed 1,000 items → Batch (*Create*, Build From Input Items, prompt `={{ $json.text }}`) → Wait → Batch (*Get*) in a loop until `ended` → Batch (*Get Results*) → merge by `customId`.
- **Vision / PDF analysis** — Send with an Attachment (*Binary Property*) of type Document + *Enable Citations* → the simplified output includes the cited passages.
- **Pre-flight cost check** — Count Tokens with the exact same fields as your Send node → route on `input_tokens` before paying for a huge request.
- **Agent tool** — the node is `usableAsTool`, so an n8n AI Agent can call it (e.g. to trigger a batch or count tokens) as a tool.
- **Web research with citations** — Send + `Tools → Web Search` (limit domains with the allow-list) → `serverToolResults` and `citations` in the simplified output.

## Model parameter rules

The API rejects certain parameter/model combinations with a 400. Cheat sheet (also in the field descriptions):

| Parameter                  | Rule                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `thinking: adaptive`       | Claude 4.6+ only — the recommended mode there                                                                |
| `thinking: budget` (legacy)| Claude 4.6 and older only; min 1024, must be < Max Tokens                                                    |
| `thinking: disabled`       | Rejected by Fable 5; rejected by Opus 5 at effort Xhigh/Max                                                  |
| Temperature / Top P / Top K| Removed on Opus 5 / Opus 4.8 / Opus 4.7 / Sonnet 5 / Fable 5; on Claude 4 models don't combine temp + Top P |
| Effort Xhigh               | Opus 4.7+ / Sonnet 5 / Fable 5 (Max works on Opus 4.6+ and Sonnet 4.6+); Haiku 4.5 has no effort support     |
| Web Search / Web Fetch     | Claude 4.6+ models; Code Execution needs Claude 4.5+                                                         |
| Citations                  | Not compatible with structured outputs                                                                       |

Use **Model → Get** to inspect a model's `capabilities` tree at runtime when in doubt.

## Known limitations

- **No streaming** — n8n nodes return complete items. Very large `Max Tokens` values (over ~16,000) can hit HTTP timeouts; raise the *Timeout* option if needed.
- **Tool-use loops are manual** — when Claude returns `toolUses`, execute them in your workflow and send `tool_result` blocks back via *Raw Messages (JSON)*. (A future version may automate the loop.)
- Beta features without dedicated fields (MCP connector, skills/containers, fallbacks, task budgets, context management) are reachable through *Request Body Overrides* + *Anthropic Beta Headers*, not first-class UI.
- The Files API is an Anthropic beta — the node sends the `files-api-2025-04-14` header for you.

## Resources

- [Anthropic API documentation](https://platform.claude.com/docs/en/api/overview)
- [Prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Batch processing guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE.md) — © Picture Element / Ben Gosciniak

## Disclaimer

This is a community-maintained package. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Anthropic" are trademarks of Anthropic, PBC.

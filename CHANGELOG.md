# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-21

### Added

- Three ready-to-import example workflows in [`examples/`](examples/): cached knowledge-base Q&A with token pre-count, bulk classification through the Batches API with polling, and an AI Agent driven by the cached Chat Model.
- README section comparing the package with the built-in Anthropic nodes.

### Changed

- Toolchain aligned with the current n8n community-node standards (`@n8n/node-cli` 0.44, latest community lint ruleset — zero findings) in preparation for the n8n Cloud verification submission; passes `@n8n/scan-community-package` stable and beta.
- Slimmer npm package: the TypeScript build cache is no longer shipped (−40% package size).

## [1.1.1] - 2026-08-20

### Fixed

- **Chat Model: tool calls were lost** — `tool_use` blocks in Claude's responses were tunneled as provider content instead of tool-call parts, so the n8n adapter never lifted them into the message's tool calls and AI Agents saw `tool_calls.requested: 0` with an empty output on every tool-using run. Plain text calls were unaffected.
- **Chat Model streaming: corrupted tool names** — tool-call deltas repeated the tool id and name on every chunk; LangChain concatenates those strings when merging chunks, corrupting the tool name and id. They are now sent once, on the first chunk.

### Added

- Behavioral test suite (`npm test`, run in CI) that drives the Chat Model through the real n8n LangChain adapter with canned Anthropic responses: text, single and parallel tool calls, full agent turns (thinking replay with signatures, tool results, cache breakpoint placement, usage folding), streaming (text, tool call, thinking + signature) and `pause_turn` resumption — the class of contract bugs that type-checking and linting cannot catch.

## [1.1.0] - 2026-08-20

### Added

- **Claude Refine Chat Model** sub-node: connect Claude to AI Agents, LLM Chains and any Chat Model input, with block-level prompt caching (system prompt, tool definitions, conversation — re-applied on every step of the agent loop), extended thinking (adaptive / disabled / legacy budgets, display control), effort levels, sampling options, custom beta headers, request body overrides, timeouts and streaming support. Built on the official `@n8n/ai-node-sdk` (requires n8n ≥ 2.16); still **zero runtime dependencies**.
- Cache usage (`cache_read_input_tokens`, `cache_creation_input_tokens`) is reported in the model's usage metadata, visible in the n8n log panel.

## [1.0.1] - 2026-08-20

### Fixed

- Passes the official `@n8n/scan-community-package` security scan: the Effort options are now listed alphabetically (the scanner does not honor inline lint disables); the low → max scale is documented in the field description instead.
- Regenerated `package-lock.json` so `npm ci` works on CI runners.

## [1.0.0] - 2026-08-20

### Added

- **Claude Refine node** with five resources on the Anthropic Claude API.
- **Message · Send** — full `/v1/messages` support: three input types (simple prompt, messages builder, raw JSON), system prompt, attachments (images and documents from URL / binary / base64 / uploaded file ID, with citations), prompt caching breakpoints (system, tools, conversation and per-message, 5m or 1h TTL), extended thinking (adaptive / disabled / legacy budgets, display control), effort levels, structured outputs (JSON Schema), custom tools, server tools (web search with domain filters, web fetch, code execution), tool choice, stop sequences, sampling parameters, service tier, inference region, `metadata.user_id`, custom beta headers, rate-limit response headers, request body overrides, simplified or raw output.
- **Message · Count Tokens** — free pre-flight token counting with the same request builder.
- **Batch** — create (from input items or raw JSON), get, get many, get results (parsed JSONL, simplified or raw), cancel, delete.
- **File** — upload (multipart from binary, no runtime dependencies), get, get many, download to binary, delete.
- **Model** — get many and get, including the capability tree (`max_input_tokens`, `max_tokens`, thinking modes, effort levels…). Models also feed the node's model dropdowns.
- **Custom API Call** — any other endpoint with the node credential, custom beta headers included.
- **Claude Refine API credential** — API key + base URL, with a live credential test.
- `usableAsTool` — the node can be used as a tool by n8n AI Agents.

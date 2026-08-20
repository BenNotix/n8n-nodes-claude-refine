# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

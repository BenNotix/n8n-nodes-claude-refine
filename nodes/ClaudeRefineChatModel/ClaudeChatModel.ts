import type {
	ChatModelConfig,
	FinishReason,
	GenerateResult,
	Message,
	MessageContent,
	StreamChunk,
	TokenUsage,
} from '@n8n/ai-node-sdk';
import { BaseChatModel, getParametersJsonSchema, parseSSEStream } from '@n8n/ai-node-sdk';
import type { IDataObject, ISupplyDataFunctions } from 'n8n-workflow';
import { jsonParse, NodeOperationError } from 'n8n-workflow';

import type { CacheTtl } from '../ClaudeRefine/GenericFunctions';
import {
	cacheControlFor,
	claudeApiRequest,
	FILES_API_BETA,
} from '../ClaudeRefine/GenericFunctions';

export interface ClaudeChatModelSettings {
	maxTokens: number;
	/** Prebuilt `thinking` request parameter, or undefined for the model default. */
	thinking?: IDataObject;
	effort?: string;
	systemTtl?: CacheTtl;
	toolsTtl?: CacheTtl;
	conversationTtl?: CacheTtl;
	betas: string[];
	requestOverrides?: IDataObject;
	timeout?: number;
}

/**
 * How many times a `pause_turn` stop reason is transparently resumed before
 * the partial turn is returned as-is.
 */
const MAX_PAUSE_TURN_RESUMES = 5;

/** Map an Anthropic stop_reason onto the SDK's finish reasons. */
function finishReasonFrom(stopReason: unknown): FinishReason {
	switch (stopReason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		case 'max_tokens':
		case 'model_context_window_exceeded':
			return 'length';
		case 'tool_use':
			return 'tool-calls';
		case 'refusal':
			return 'content-filter';
		default:
			return 'other';
	}
}

/** Sum the token counters of `usage` into `totals` (other fields keep the latest value). */
function accumulateUsage(totals: IDataObject, usage: IDataObject | undefined): void {
	if (usage === undefined) {
		return;
	}
	const counters = [
		'input_tokens',
		'output_tokens',
		'cache_creation_input_tokens',
		'cache_read_input_tokens',
	];
	for (const [key, value] of Object.entries(usage)) {
		if (counters.includes(key)) {
			totals[key] = ((totals[key] as number) ?? 0) + ((value as number) ?? 0);
		} else if (value !== undefined && value !== null) {
			totals[key] = value;
		}
	}
}

/**
 * Map Anthropic usage onto the SDK shape. Cached tokens are folded into
 * promptTokens (like the built-in node) and also reported separately so the
 * n8n log panel shows cache activity.
 */
function usageFrom(usage: IDataObject | undefined): TokenUsage | undefined {
	if (usage === undefined) {
		return undefined;
	}
	const inputTokens = (usage.input_tokens as number) ?? 0;
	const cacheCreation = (usage.cache_creation_input_tokens as number) ?? 0;
	const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
	const outputTokens = (usage.output_tokens as number) ?? 0;
	const promptTokens = inputTokens + cacheCreation + cacheRead;
	return {
		promptTokens,
		completionTokens: outputTokens,
		totalTokens: promptTokens + outputTokens,
		inputTokenDetails: { cacheRead },
		additionalMetadata: usage as Record<string, unknown>,
	};
}

/** Convert Anthropic response content blocks into SDK message content. */
function sdkContentFrom(blocks: IDataObject[]): MessageContent[] {
	const content: MessageContent[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case 'text': {
				content.push({ type: 'text', text: (block.text as string) ?? '' });
				if (Array.isArray(block.citations)) {
					for (const citation of block.citations as IDataObject[]) {
						content.push({
							type: 'citation',
							title: citation.document_title as string | undefined,
							text: citation.cited_text as string | undefined,
							url: citation.url as string | undefined,
							providerMetadata: citation as Record<string, unknown>,
						});
					}
				}
				break;
			}
			case 'thinking':
				// Tunneled verbatim as provider content: the LangChain adapter's
				// converters round-trip provider blocks losslessly but strip
				// providerMetadata from reasoning parts, and without its signature a
				// thinking block cannot be replayed (400 on tool-use turns when
				// thinking is enabled). The extra reasoning part is display-only —
				// carrying no signature it is never rendered back into a request.
				content.push({ type: 'provider', value: block as Record<string, unknown> });
				content.push({ type: 'reasoning', text: (block.thinking as string) ?? '' });
				break;
			default:
				// redacted_thinking, server tool use/results, container uploads… kept
				// verbatim so replayed history stays intact
				content.push({ type: 'provider', value: block as Record<string, unknown> });
		}
	}
	return content;
}

/** SDK tool-call content is turned back into an Anthropic tool_use block by the caller. */
function toolUseBlockFrom(part: MessageContent, fallbackId: string): IDataObject | undefined {
	if (part.type !== 'tool-call') {
		return undefined;
	}
	let input: IDataObject = {};
	if (part.input) {
		try {
			input = jsonParse<IDataObject>(part.input);
		} catch {
			input = {};
		}
	}
	return {
		type: 'tool_use',
		id: part.toolCallId ?? fallbackId,
		name: part.toolName,
		input,
	};
}

/** Concatenated text of a message's text parts. */
function textOf(content: MessageContent[]): string {
	return content
		.filter((part) => part.type === 'text')
		.map((part) => (part as { text: string }).text)
		.join('\n\n');
}

/** Per-index state of a streamed content block, enough to rebuild the block. */
interface StreamedBlockState {
	type: string;
	raw: IDataObject;
	text: string;
	thinking: string;
	signature: string;
	partialJson: string;
}

/** Rebuild the complete Anthropic content block from streamed state. */
function completedBlock(state: StreamedBlockState): IDataObject {
	switch (state.type) {
		case 'text':
			return { type: 'text', text: state.text };
		case 'thinking':
			return { type: 'thinking', thinking: state.thinking, signature: state.signature };
		case 'tool_use':
		case 'server_tool_use':
		case 'mcp_tool_use': {
			let input = state.raw.input ?? {};
			if (state.partialJson !== '') {
				try {
					input = jsonParse<IDataObject>(state.partialJson);
				} catch {
					// keep the raw input
				}
			}
			return { ...state.raw, input };
		}
		default:
			// redacted_thinking, server tool results… arrive complete at block start
			return state.raw;
	}
}

/**
 * Claude chat model on the n8n AI-node SDK: converts the SDK's normalized
 * messages/tools into Anthropic Messages API requests built by this package's
 * own request layer, with block-level prompt caching, extended thinking and
 * effort — no LangChain dependency.
 */
export class ClaudeChatModel extends BaseChatModel {
	constructor(
		private readonly ctx: ISupplyDataFunctions,
		modelId: string,
		private readonly settings: ClaudeChatModelSettings,
		defaultConfig?: ChatModelConfig,
	) {
		super('anthropic', modelId, defaultConfig);
	}

	/** Convert one SDK file part into an Anthropic image/document block. */
	private fileBlockFrom(
		part: Extract<MessageContent, { type: 'file' }>,
		betas: Set<string>,
	): IDataObject {
		const metadata = (part.providerMetadata ?? {}) as IDataObject;
		let mediaType = part.mediaType;
		let base64Data: string | undefined;
		let url: string | undefined;
		const fileId = typeof metadata.fileId === 'string' ? metadata.fileId : undefined;

		if (typeof metadata.url === 'string' && fileId === undefined) {
			if (metadata.url.startsWith('data:')) {
				// The Anthropic URL source only accepts http(s) — unpack data URLs
				const match = /^data:([^;,]*)(;base64)?,(.*)$/.exec(metadata.url);
				if (!match) {
					throw new NodeOperationError(
						this.ctx.getNode(),
						'A file attachment carries a data URL that could not be parsed',
					);
				}
				mediaType = match[1] || mediaType;
				base64Data = match[2]
					? match[3]
					: Buffer.from(decodeURIComponent(match[3]), 'utf8').toString('base64');
			} else {
				url = metadata.url;
			}
		}
		if (base64Data === undefined && url === undefined && fileId === undefined) {
			base64Data =
				typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64');
		}
		if (
			base64Data !== undefined &&
			(mediaType === undefined || mediaType === 'application/octet-stream')
		) {
			// Sniff PDFs so unlabeled binary documents still work
			const head = Buffer.from(base64Data.slice(0, 8), 'base64').toString('latin1');
			mediaType = head.startsWith('%PDF') ? 'application/pdf' : mediaType;
		}

		const blockType = mediaType?.startsWith('image/') ? 'image' : 'document';
		let source: IDataObject;
		if (url !== undefined) {
			source = { type: 'url', url };
		} else if (fileId !== undefined) {
			source = { type: 'file', file_id: fileId };
			betas.add(FILES_API_BETA);
		} else if (blockType === 'document' && mediaType?.startsWith('text/')) {
			source = {
				type: 'text',
				media_type: 'text/plain',
				data: Buffer.from(base64Data!, 'base64').toString('utf8'),
			};
		} else if (blockType === 'document' && mediaType !== 'application/pdf') {
			throw new NodeOperationError(
				this.ctx.getNode(),
				`Unsupported document media type "${mediaType ?? 'unknown'}" — documents must be PDF or plain text`,
			);
		} else {
			source = { type: 'base64', media_type: mediaType!, data: base64Data! };
		}
		return { type: blockType, source };
	}

	/** Convert SDK content parts to Anthropic content blocks for one message. */
	private toAnthropicBlocks(
		content: MessageContent[],
		betas: Set<string>,
		messageIndex: number,
	): IDataObject[] {
		const blocks: IDataObject[] = [];
		for (const [partIndex, part] of content.entries()) {
			switch (part.type) {
				case 'text':
					if (part.text !== '') {
						blocks.push({ type: 'text', text: part.text });
					}
					break;
				case 'reasoning': {
					const metadata = (part.providerMetadata ?? {}) as IDataObject;
					if (typeof metadata.redactedData === 'string') {
						blocks.push({ type: 'redacted_thinking', data: metadata.redactedData });
					} else if (typeof metadata.signature === 'string') {
						blocks.push({ type: 'thinking', thinking: part.text, signature: metadata.signature });
					}
					// Reasoning without a signature cannot be replayed — dropped (the
					// replayable copy travels as a provider part, see sdkContentFrom)
					break;
				}
				case 'tool-call': {
					const block = toolUseBlockFrom(part, `call_${messageIndex}_${partIndex}`);
					if (block !== undefined) {
						blocks.push(block);
					}
					break;
				}
				case 'tool-result':
					blocks.push({
						type: 'tool_result',
						tool_use_id: part.toolCallId,
						content:
							typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? ''),
						...(part.isError === true ? { is_error: true } : {}),
					});
					break;
				case 'file':
					blocks.push(this.fileBlockFrom(part, betas));
					break;
				case 'provider':
					blocks.push(part.value as IDataObject);
					break;
				default:
					// citation / invalid-tool-call parts have no request-side equivalent
					break;
			}
		}
		return blocks;
	}

	/** Build the full /v1/messages request body plus the beta headers it needs. */
	private buildRequest(
		messages: Message[],
		config: ChatModelConfig,
	): { body: IDataObject; betas: string[] } {
		const betas = new Set<string>(this.settings.betas);
		const systemParts: string[] = [];
		const conversation: IDataObject[] = [];

		for (const [index, message] of messages.entries()) {
			if (message.role === 'system') {
				const text = textOf(message.content);
				if (text !== '') {
					systemParts.push(text);
				}
				continue;
			}
			const blocks = this.toAnthropicBlocks(message.content, betas, index);
			if (blocks.length === 0) {
				continue;
			}
			// The SDK's 'tool' role carries tool results, which Anthropic expects
			// as tool_result blocks in a user message
			conversation.push({ role: message.role === 'tool' ? 'user' : message.role, content: blocks });
		}

		const body: IDataObject = {
			model: this.modelId,
			max_tokens: config.maxTokens ?? this.settings.maxTokens,
			messages: conversation,
		};

		if (systemParts.length > 0) {
			const system = systemParts.join('\n\n');
			const systemCache = cacheControlFor(this.settings.systemTtl);
			body.system =
				systemCache === undefined
					? system
					: [{ type: 'text', text: system, cache_control: systemCache }];
		}

		const conversationCache = cacheControlFor(this.settings.conversationTtl);
		if (conversationCache !== undefined && conversation.length > 0) {
			const lastMessage = conversation[conversation.length - 1];
			const blocks = lastMessage.content as IDataObject[];
			blocks[blocks.length - 1] = {
				...blocks[blocks.length - 1],
				cache_control: conversationCache,
			};
		}

		const tools: IDataObject[] = [];
		for (const tool of this.tools) {
			if (tool.type === 'function') {
				const definition: IDataObject = {
					name: tool.name,
					input_schema: getParametersJsonSchema(tool) as unknown as IDataObject,
				};
				if (tool.description) {
					definition.description = tool.description;
				}
				if (tool.strict === true) {
					definition.strict = true;
				}
				tools.push(definition);
			} else {
				// Provider tools pass through — args must carry the server tool's type
				tools.push({ name: tool.name, ...((tool.args ?? {}) as IDataObject) });
			}
		}
		if (tools.length > 0) {
			const toolsCache = cacheControlFor(this.settings.toolsTtl);
			if (toolsCache !== undefined) {
				tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: toolsCache };
			}
			body.tools = tools;
		}

		if (config.temperature !== undefined) {
			body.temperature = config.temperature;
		}
		if (config.topP !== undefined) {
			body.top_p = config.topP;
		}
		if (config.topK !== undefined) {
			body.top_k = config.topK;
		}
		if (config.stopSequences !== undefined && config.stopSequences.length > 0) {
			body.stop_sequences = config.stopSequences;
		}
		if (this.settings.thinking !== undefined) {
			body.thinking = this.settings.thinking;
		}
		if (this.settings.effort !== undefined) {
			body.output_config = { effort: this.settings.effort };
		}
		if (this.settings.requestOverrides !== undefined) {
			Object.assign(body, this.settings.requestOverrides);
		}

		return { body, betas: [...betas] };
	}

	/** The abort signal, whichever key the caller used (LangChain passes `signal`). */
	private abortSignalFrom(config: ChatModelConfig): AbortSignal | undefined {
		return config.abortSignal ?? (config as { signal?: AbortSignal }).signal;
	}

	async generate(messages: Message[], config?: ChatModelConfig): Promise<GenerateResult> {
		const merged = this.mergeConfig(config);
		const abortSignal = this.abortSignalFrom(merged);
		const { body, betas } = this.buildRequest(messages, merged);

		const usageTotals: IDataObject = {};
		let response = await claudeApiRequest.call(this.ctx, 'POST', '/v1/messages', {
			body,
			betas,
			timeout: this.settings.timeout ?? merged.timeout,
			abortSignal,
		});
		accumulateUsage(usageTotals, response.usage as IDataObject | undefined);

		// pause_turn means the server-tool loop is incomplete: replay the partial
		// assistant turn verbatim so the API resumes it
		for (
			let resume = 0;
			resume < MAX_PAUSE_TURN_RESUMES && response.stop_reason === 'pause_turn';
			resume++
		) {
			(body.messages as IDataObject[]).push({ role: 'assistant', content: response.content });
			response = await claudeApiRequest.call(this.ctx, 'POST', '/v1/messages', {
				body,
				betas,
				timeout: this.settings.timeout ?? merged.timeout,
				abortSignal,
			});
			accumulateUsage(usageTotals, response.usage as IDataObject | undefined);
		}

		const providerMetadata: Record<string, unknown> = {
			stopReason: response.stop_reason,
			model: response.model,
		};
		if (response.stop_details !== undefined && response.stop_details !== null) {
			providerMetadata.stopDetails = response.stop_details;
		}
		if (response.container !== undefined && response.container !== null) {
			providerMetadata.container = response.container;
		}

		return {
			id: response.id as string,
			finishReason: finishReasonFrom(response.stop_reason),
			usage: usageFrom(usageTotals),
			message: {
				id: response.id as string,
				role: 'assistant',
				content: sdkContentFrom((response.content as IDataObject[] | undefined) ?? []),
			},
			providerMetadata,
			rawResponse: response,
		};
	}

	async *stream(messages: Message[], config?: ChatModelConfig): AsyncIterable<StreamChunk> {
		const merged = this.mergeConfig(config);
		const abortSignal = this.abortSignalFrom(merged);
		const { body, betas } = this.buildRequest(messages, merged);
		body.stream = true;

		const usageTotals: IDataObject = {};

		for (let attempt = 0; attempt <= MAX_PAUSE_TURN_RESUMES; attempt++) {
			const responseStream = (await claudeApiRequest.call(this.ctx, 'POST', '/v1/messages', {
				body,
				betas,
				encoding: 'stream',
				timeout: this.settings.timeout ?? merged.timeout,
				abortSignal,
			})) as unknown as AsyncIterableIterator<Buffer>;

			// Per-index state of the streamed blocks, to attribute deltas and to
			// rebuild the complete blocks for replay
			const blockStates = new Map<number, StreamedBlockState>();
			let finishReason: FinishReason = 'stop';
			let pauseTurn = false;
			let usage: IDataObject = {};

			for await (const event of parseSSEStream(responseStream)) {
				if (abortSignal?.aborted) {
					return;
				}
				if (!event.data) {
					continue;
				}
				let payload: IDataObject;
				try {
					payload = jsonParse<IDataObject>(event.data);
				} catch {
					continue;
				}

				switch (payload.type) {
					case 'message_start': {
						const message = payload.message as IDataObject | undefined;
						usage = { ...((message?.usage as IDataObject) ?? {}) };
						break;
					}
					case 'content_block_start': {
						const index = payload.index as number;
						const block = (payload.content_block as IDataObject) ?? {};
						blockStates.set(index, {
							type: block.type as string,
							raw: block,
							text: '',
							thinking: '',
							signature: '',
							partialJson: '',
						});
						if (block.type === 'tool_use') {
							yield {
								type: 'tool-call-delta',
								id: block.id as string,
								name: block.name as string,
							};
						}
						break;
					}
					case 'content_block_delta': {
						const delta = (payload.delta as IDataObject) ?? {};
						const state = blockStates.get(payload.index as number);
						if (delta.type === 'text_delta') {
							const text = (delta.text as string) ?? '';
							if (state !== undefined) {
								state.text += text;
							}
							yield { type: 'text-delta', delta: text };
						} else if (delta.type === 'thinking_delta') {
							const thinking = (delta.thinking as string) ?? '';
							if (state !== undefined) {
								state.thinking += thinking;
							}
							yield { type: 'reasoning-delta', delta: thinking };
						} else if (delta.type === 'signature_delta') {
							if (state !== undefined) {
								state.signature += (delta.signature as string) ?? '';
							}
						} else if (delta.type === 'input_json_delta') {
							if (state !== undefined) {
								state.partialJson += (delta.partial_json as string) ?? '';
							}
							// Only client tool_use blocks become agent tool calls —
							// server_tool_use / mcp_tool_use run on Anthropic's side
							if (state?.type === 'tool_use') {
								yield {
									type: 'tool-call-delta',
									id: state.raw.id as string | undefined,
									name: state.raw.name as string | undefined,
									argumentsDelta: (delta.partial_json as string) ?? '',
								};
							}
						}
						break;
					}
					case 'content_block_stop': {
						const state = blockStates.get(payload.index as number);
						if (state === undefined) {
							break;
						}
						// Thinking and server-tool blocks travel as complete provider
						// content so replayed history keeps them (text is already
						// streamed as deltas; client tool_use as tool-call deltas)
						if (state.type !== 'text' && state.type !== 'tool_use') {
							yield {
								type: 'content',
								content: {
									type: 'provider',
									value: completedBlock(state) as Record<string, unknown>,
								},
							};
						}
						break;
					}
					case 'message_delta': {
						const delta = (payload.delta as IDataObject) ?? {};
						if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
							pauseTurn = delta.stop_reason === 'pause_turn';
							finishReason = finishReasonFrom(delta.stop_reason);
						}
						usage = { ...usage, ...((payload.usage as IDataObject) ?? {}) };
						break;
					}
					case 'error':
						yield { type: 'error', error: payload.error };
						return;
					default:
						break;
				}
			}

			accumulateUsage(usageTotals, usage);

			if (!pauseTurn || attempt === MAX_PAUSE_TURN_RESUMES) {
				yield { type: 'finish', finishReason, usage: usageFrom(usageTotals) };
				return;
			}

			// Resume the paused turn: replay the streamed assistant content verbatim
			const resumedContent = [...blockStates.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, state]) => completedBlock(state));
			(body.messages as IDataObject[]).push({ role: 'assistant', content: resumedContent });
		}
	}
}

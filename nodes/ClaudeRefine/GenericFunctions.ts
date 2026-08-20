import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { deepCopy, jsonParse, NodeApiError, NodeOperationError } from 'n8n-workflow';

export type ClaudeRefineContext = IExecuteFunctions | ILoadOptionsFunctions | ISupplyDataFunctions;

/**
 * Current (and only recommended) API version. New Anthropic features ship as
 * additive changes or behind `anthropic-beta` headers, never as new versions.
 */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The Files API beta header. Sent on every /v1/files call and whenever a
 * message references an uploaded file — it also pins the list endpoints to the
 * `before_id`/`after_id` pagination format this node implements.
 */
export const FILES_API_BETA = 'files-api-2025-04-14';

/** Cache TTL choice shared by the system / tools / conversation breakpoints. */
export type CacheTtl = 'none' | '5m' | '1h';

export interface ClaudeRequestExtras {
	body?: IDataObject | Buffer;
	qs?: IDataObject;
	/** `anthropic-beta` feature flags to send with the request. */
	betas?: string[];
	headers?: Record<string, string>;
	/**
	 * Response encoding — 'text' for batch results (JSONL), 'arraybuffer' for
	 * file downloads, 'stream' for server-sent events.
	 */
	encoding?: 'arraybuffer' | 'text' | 'stream';
	returnFullResponse?: boolean;
	timeout?: number;
	abortSignal?: AbortSignal;
}

/** Base URL from the credential, normalized (scheme added, trailing slashes removed). */
export async function claudeApiBaseUrl(this: ClaudeRefineContext): Promise<string> {
	const credentials = await this.getCredentials('claudeRefineApi');
	let baseUrl = ((credentials.baseUrl as string) || 'https://api.anthropic.com')
		.trim()
		.replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(baseUrl)) {
		baseUrl = `https://${baseUrl}`;
	}
	return baseUrl;
}

/**
 * Best-effort extraction of the Anthropic error payload
 * (`{"type":"error","error":{"type":"...","message":"..."},"request_id":"..."}`)
 * from whatever shape the HTTP helper threw.
 */
function anthropicErrorDetails(error: unknown): {
	statusCode?: number;
	errorType?: string;
	message?: string;
	requestId?: string;
} {
	const err = error as IDataObject;
	const response = (err.response ?? (err.cause as IDataObject | undefined)?.response) as
		IDataObject | undefined;
	let body = (response?.body ?? response?.data ?? err.body ?? err.error) as
		IDataObject | string | undefined;
	if (typeof body === 'string') {
		try {
			body = jsonParse<IDataObject>(body);
		} catch {
			body = undefined;
		}
	}
	const statusCode = (response?.statusCode ??
		response?.status ??
		err.httpCode ??
		err.statusCode) as number | undefined;
	const inner = body?.error as IDataObject | undefined;
	return {
		statusCode: statusCode !== undefined ? Number(statusCode) : undefined,
		errorType: inner?.type as string | undefined,
		message: (inner?.message ?? body?.message) as string | undefined,
		requestId: body?.request_id as string | undefined,
	};
}

/** Actionable hint appended to API errors, keyed by the Anthropic error type. */
function errorHint(errorType?: string, statusCode?: number): string | undefined {
	switch (errorType) {
		case 'authentication_error':
			return 'Check the API key in the Claude Refine credential';
		case 'permission_error':
			return 'The API key does not have permission for this resource — check its workspace scope';
		case 'rate_limit_error':
			return 'Rate limit hit — add a Wait node or retry with backoff, or use the Batch resource for bulk work';
		case 'overloaded_error':
			return 'The Anthropic API is temporarily overloaded — retry in a moment';
		case 'request_too_large':
			return 'The request exceeds the size limit (32 MB for messages, 256 MB for batches)';
		case 'invalid_request_error':
			return 'The request was rejected — check model-specific parameter rules (thinking, temperature, effort) in the node documentation';
		default:
			if (statusCode !== undefined && statusCode >= 500) {
				return 'Anthropic server error — usually transient, retry in a moment';
			}
			return undefined;
	}
}

/**
 * Authenticated request against the Anthropic API. JSON in/out by default;
 * pass `encoding` for binary/text responses and a Buffer body (with an
 * explicit Content-Type header) for multipart uploads.
 */
export async function claudeApiRequest(
	this: ClaudeRefineContext,
	method: IHttpRequestMethods,
	endpoint: string,
	extras: ClaudeRequestExtras = {},
): Promise<IDataObject> {
	const baseUrl = await claudeApiBaseUrl.call(this);

	const headers: Record<string, string> = {
		'anthropic-version': ANTHROPIC_VERSION,
		...extras.headers,
	};
	const betas = [...new Set((extras.betas ?? []).map((beta) => beta.trim()).filter(Boolean))];
	if (betas.length > 0) {
		headers['anthropic-beta'] = betas.join(',');
	}

	const options: IHttpRequestOptions = {
		method,
		// Endpoints are paths anchored on the credential base URL; absolute URLs
		// returned by the API (e.g. a batch results_url) pass through unchanged
		url: /^https?:\/\//i.test(endpoint) ? endpoint : `${baseUrl}${endpoint}`,
		headers,
		json: extras.encoding === undefined && !Buffer.isBuffer(extras.body),
	};
	if (extras.body !== undefined) {
		options.body = extras.body;
	}
	if (extras.qs !== undefined && Object.keys(extras.qs).length > 0) {
		options.qs = extras.qs;
	}
	if (extras.encoding !== undefined) {
		options.encoding = extras.encoding;
	}
	if (extras.returnFullResponse === true) {
		options.returnFullResponse = true;
	}
	if (extras.timeout !== undefined) {
		options.timeout = extras.timeout;
	}
	if (extras.abortSignal !== undefined) {
		options.abortSignal = extras.abortSignal;
	}

	try {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'claudeRefineApi',
			options,
		);
		// Multipart uploads run with json:false, so a JSON reply arrives as a string
		if (extras.encoding === undefined && typeof response === 'string' && response !== '') {
			try {
				return jsonParse<IDataObject>(response);
			} catch {
				return { data: response };
			}
		}
		return response as IDataObject;
	} catch (error) {
		const details = anthropicErrorDetails(error);
		const messageParts: string[] = [];
		if (details.message !== undefined) {
			messageParts.push(details.message);
		}
		if (details.requestId !== undefined) {
			messageParts.push(`(request ID: ${details.requestId})`);
		}
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: messageParts.length > 0 ? messageParts.join(' ') : undefined,
			description: errorHint(details.errorType, details.statusCode),
		});
	}
}

/**
 * Fetch every page of a `data[]`-shaped list endpoint (models, batches,
 * files) using `after_id` cursors. Stops early once `maxItems` is reached.
 */
export async function claudeApiRequestAllItems(
	this: ClaudeRefineContext,
	endpoint: string,
	extras: { qs?: IDataObject; betas?: string[]; maxItems?: number } = {},
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let afterId: string | undefined;

	for (;;) {
		const qs: IDataObject = { ...extras.qs, limit: 100 };
		if (extras.maxItems !== undefined) {
			qs.limit = Math.min(100, Math.max(1, extras.maxItems - results.length));
		}
		if (afterId !== undefined) {
			qs.after_id = afterId;
		}
		const response = await claudeApiRequest.call(this, 'GET', endpoint, {
			qs,
			betas: extras.betas,
		});
		const data = (response.data as IDataObject[] | undefined) ?? [];
		results.push(...data);

		if (extras.maxItems !== undefined && results.length >= extras.maxItems) {
			return results.slice(0, extras.maxItems);
		}
		if (response.has_more !== true || data.length === 0) {
			return results;
		}
		afterId = (response.last_id as string) ?? (data[data.length - 1].id as string);
	}
}

/** The `cache_control` object for a TTL choice, or undefined for 'none'. */
export function cacheControlFor(ttl: CacheTtl | undefined): IDataObject | undefined {
	if (ttl === '5m') {
		return { type: 'ephemeral' };
	}
	if (ttl === '1h') {
		return { type: 'ephemeral', ttl: '1h' };
	}
	return undefined;
}

/**
 * Parse a JSON-type node parameter. Accepts objects passed via expressions,
 * treats ''/'{}'/'[]'-like empty input as undefined, and turns parse failures
 * into a NodeOperationError pointing at the parameter.
 */
export function parseJsonParameter<T>(
	this: ClaudeRefineContext,
	value: unknown,
	parameterDisplayName: string,
	itemIndex: number,
): T | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'object') {
		return value as T;
	}
	const text = String(value).trim();
	if (text === '') {
		return undefined;
	}
	try {
		return jsonParse<T>(text);
	} catch {
		throw new NodeOperationError(
			this.getNode(),
			`Parameter "${parameterDisplayName}" contains invalid JSON`,
			{ itemIndex },
		);
	}
}

/** Convert a message `content` value into block form so blocks can be appended. */
export function contentToBlocks(content: unknown): IDataObject[] {
	if (typeof content === 'string') {
		return content === '' ? [] : [{ type: 'text', text: content }];
	}
	if (Array.isArray(content)) {
		return content as IDataObject[];
	}
	return [];
}

interface AttachmentEntry {
	type: 'image' | 'document';
	source: 'url' | 'binary' | 'base64' | 'fileId';
	url?: string;
	binaryPropertyName?: string;
	base64Data?: string;
	mediaType?: string;
	fileId?: string;
	title?: string;
	context?: string;
	enableCitations?: boolean;
}

/**
 * Build image/document content blocks from the Attachments parameter of an
 * item. Returns the blocks plus any beta headers they require (file IDs need
 * the Files API beta).
 */
export async function buildAttachmentBlocks(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<{ blocks: IDataObject[]; betas: string[] }> {
	const attachments = this.getNodeParameter(
		'attachments.attachment',
		itemIndex,
		[],
	) as AttachmentEntry[];
	const blocks: IDataObject[] = [];
	const betas: string[] = [];

	for (const attachment of attachments) {
		let source: IDataObject;
		switch (attachment.source) {
			case 'url':
				if (!attachment.url) {
					throw new NodeOperationError(this.getNode(), 'Attachment is missing its URL', {
						itemIndex,
					});
				}
				source = { type: 'url', url: attachment.url };
				break;
			case 'binary': {
				const propertyName = attachment.binaryPropertyName || 'data';
				this.helpers.assertBinaryData(itemIndex, propertyName);
				const binaryMetadata = this.getInputData()[itemIndex].binary![propertyName];
				const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, propertyName);
				const mediaType = attachment.mediaType || binaryMetadata.mimeType;
				if (!mediaType) {
					throw new NodeOperationError(
						this.getNode(),
						'The binary data has no MIME type — set the attachment Media Type explicitly',
						{ itemIndex },
					);
				}
				if (attachment.type === 'document' && mediaType.startsWith('text/')) {
					// Plain-text documents use the text source, not base64
					source = { type: 'text', media_type: 'text/plain', data: buffer.toString('utf8') };
				} else {
					source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
				}
				break;
			}
			case 'base64': {
				if (!attachment.base64Data || !attachment.mediaType) {
					throw new NodeOperationError(
						this.getNode(),
						'Base64 attachments need both Data and Media Type',
						{ itemIndex },
					);
				}
				const data = attachment.base64Data.replace(/\s+/g, '');
				if (attachment.type === 'document' && attachment.mediaType.startsWith('text/')) {
					// Plain-text documents use the text source, not base64
					source = {
						type: 'text',
						media_type: 'text/plain',
						data: Buffer.from(data, 'base64').toString('utf8'),
					};
				} else {
					source = { type: 'base64', media_type: attachment.mediaType, data };
				}
				break;
			}
			case 'fileId':
				if (!attachment.fileId) {
					throw new NodeOperationError(this.getNode(), 'Attachment is missing its File ID', {
						itemIndex,
					});
				}
				source = { type: 'file', file_id: attachment.fileId };
				betas.push(FILES_API_BETA);
				break;
			default:
				continue;
		}

		const block: IDataObject = { type: attachment.type, source };
		if (attachment.type === 'document') {
			if (attachment.title) {
				block.title = attachment.title;
			}
			if (attachment.context) {
				block.context = attachment.context;
			}
			if (attachment.enableCitations === true) {
				block.citations = { enabled: true };
			}
		}
		blocks.push(block);
	}

	return { blocks, betas };
}

interface BuilderMessageEntry {
	role: 'user' | 'assistant';
	text: string;
	cacheControl?: CacheTtl;
}

interface ThinkingParameters {
	mode?: 'default' | 'adaptive' | 'disabled' | 'budget';
	budgetTokens?: number;
	display?: 'default' | 'summarized' | 'omitted';
}

interface ToolsParameters {
	customToolsJson?: string;
	webSearch?: boolean;
	webSearchMaxUses?: number;
	webSearchAllowedDomains?: string;
	webSearchBlockedDomains?: string;
	webFetch?: boolean;
	webFetchMaxUses?: number;
	codeExecution?: boolean;
	toolChoice?: 'auto' | 'any' | 'none' | 'tool';
	toolChoiceName?: string;
	disableParallelToolUse?: boolean;
}

/** Split a comma-separated domain list into a trimmed array, or undefined. */
function domainList(value: string | undefined): string[] | undefined {
	const domains = (value ?? '')
		.split(',')
		.map((domain) => domain.trim())
		.filter(Boolean);
	return domains.length > 0 ? domains : undefined;
}

/** Whether any content block references an uploaded file (needs the Files API beta). */
function messagesReferenceFiles(messages: IDataObject[]): boolean {
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content as IDataObject[]) {
			if (block.type === 'container_upload') {
				return true;
			}
			if ((block.source as IDataObject | undefined)?.type === 'file') {
				return true;
			}
		}
	}
	return false;
}

/** Number of cache_control breakpoints across tools, system blocks and messages. */
function countCacheBreakpoints(
	tools: IDataObject[],
	system: unknown,
	messages: IDataObject[],
): number {
	let count = tools.filter((tool) => tool.cache_control !== undefined).length;
	if (Array.isArray(system)) {
		count += (system as IDataObject[]).filter((block) => block.cache_control !== undefined).length;
	}
	for (const message of messages) {
		if (Array.isArray(message.content)) {
			count += (message.content as IDataObject[]).filter(
				(block) => block.cache_control !== undefined,
			).length;
		}
	}
	return count;
}

/**
 * Build the /v1/messages request body (also used by count_tokens and by the
 * Batch resource) from the node parameters of one item.
 *
 * `forCountTokens` skips everything the count endpoint does not accept
 * (max_tokens, sampling, caching options, metadata…).
 */
export async function buildMessageRequestBody(
	this: IExecuteFunctions,
	itemIndex: number,
	forCountTokens: boolean,
): Promise<{ body: IDataObject; betas: string[]; timeout?: number; includeHeaders: boolean }> {
	const body: IDataObject = {
		model: this.getNodeParameter('model', itemIndex) as string,
	};
	const betas: string[] = [];

	// ---------- messages ----------
	const inputType = this.getNodeParameter('inputType', itemIndex) as string;
	let messages: IDataObject[];
	let simplePrompt = '';
	if (inputType === 'prompt') {
		simplePrompt = this.getNodeParameter('prompt', itemIndex) as string;
		messages = [{ role: 'user', content: simplePrompt }];
	} else if (inputType === 'messages') {
		const entries = this.getNodeParameter(
			'messages.message',
			itemIndex,
			[],
		) as BuilderMessageEntry[];
		if (entries.length === 0) {
			throw new NodeOperationError(this.getNode(), 'Add at least one message', { itemIndex });
		}
		messages = entries.map((entry) => {
			const cacheControl = cacheControlFor(entry.cacheControl);
			if (cacheControl === undefined) {
				return { role: entry.role, content: entry.text } as IDataObject;
			}
			return {
				role: entry.role,
				content: [{ type: 'text', text: entry.text, cache_control: cacheControl }],
			} as IDataObject;
		});
	} else {
		const parsed = parseJsonParameter.call(
			this,
			this.getNodeParameter('messagesJson', itemIndex),
			'Messages (JSON)',
			itemIndex,
		);
		if (!Array.isArray(parsed) || parsed.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'Messages (JSON) must be a non-empty array of {role, content} objects',
				{ itemIndex },
			);
		}
		// An expression can resolve to the upstream item's live data — copy it so
		// the cache breakpoint / attachment merging below never mutates input items
		messages = deepCopy(parsed) as IDataObject[];
	}

	// ---------- attachments (appended to the last user message) ----------
	const { blocks: attachmentBlocks, betas: attachmentBetas } = await buildAttachmentBlocks.call(
		this,
		itemIndex,
	);
	betas.push(...attachmentBetas);
	if (attachmentBlocks.length > 0) {
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index].role === 'user') {
				lastUserIndex = index;
				break;
			}
		}
		if (lastUserIndex === -1) {
			throw new NodeOperationError(
				this.getNode(),
				'Attachments need at least one user message to attach to',
				{ itemIndex },
			);
		}
		const target = messages[lastUserIndex];
		const existing = contentToBlocks(target.content);
		// tool_result blocks must stay first in a user message; attachments go
		// after them but before the text, so the question follows the material
		let insertAt = 0;
		while (insertAt < existing.length && existing[insertAt].type === 'tool_result') {
			insertAt++;
		}
		target.content = [
			...existing.slice(0, insertAt),
			...attachmentBlocks,
			...existing.slice(insertAt),
		];
	}
	if (inputType === 'prompt' && simplePrompt.trim() === '' && attachmentBlocks.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			'The Prompt field is empty — provide a prompt or add an attachment',
			{ itemIndex },
		);
	}
	if (!betas.includes(FILES_API_BETA) && messagesReferenceFiles(messages)) {
		betas.push(FILES_API_BETA);
	}
	body.messages = messages;

	// ---------- system prompt ----------
	const system = this.getNodeParameter('system', itemIndex, '') as string;
	const caching = forCountTokens
		? {}
		: (this.getNodeParameter('promptCaching', itemIndex, {}) as {
				systemTtl?: CacheTtl;
				toolsTtl?: CacheTtl;
				messagesTtl?: CacheTtl;
			});
	if (system !== '') {
		const systemCache = cacheControlFor(caching.systemTtl);
		body.system =
			systemCache === undefined
				? system
				: [{ type: 'text', text: system, cache_control: systemCache }];
	}

	// ---------- conversation cache breakpoint ----------
	const messagesCache = cacheControlFor(caching.messagesTtl);
	if (messagesCache !== undefined && messages.length > 0) {
		const lastMessage = messages[messages.length - 1];
		const blocks = contentToBlocks(lastMessage.content);
		if (blocks.length > 0) {
			blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: messagesCache };
			lastMessage.content = blocks;
		}
	}

	// ---------- tools ----------
	const toolsParameters = this.getNodeParameter('tools', itemIndex, {}) as ToolsParameters;
	const tools: IDataObject[] = [];
	const customTools = parseJsonParameter.call(
		this,
		toolsParameters.customToolsJson,
		'Custom Tools (JSON)',
		itemIndex,
	);
	if (customTools !== undefined) {
		if (!Array.isArray(customTools)) {
			throw new NodeOperationError(
				this.getNode(),
				'Custom Tools (JSON) must be an array of tool definitions',
				{ itemIndex },
			);
		}
		tools.push(...(customTools as IDataObject[]));
	}
	if (toolsParameters.webSearch === true) {
		const webSearchTool: IDataObject = { type: 'web_search_20260209', name: 'web_search' };
		if (toolsParameters.webSearchMaxUses) {
			webSearchTool.max_uses = toolsParameters.webSearchMaxUses;
		}
		const allowed = domainList(toolsParameters.webSearchAllowedDomains);
		const blocked = domainList(toolsParameters.webSearchBlockedDomains);
		if (allowed !== undefined) {
			webSearchTool.allowed_domains = allowed;
		} else if (blocked !== undefined) {
			webSearchTool.blocked_domains = blocked;
		}
		tools.push(webSearchTool);
	}
	if (toolsParameters.webFetch === true) {
		const webFetchTool: IDataObject = { type: 'web_fetch_20260209', name: 'web_fetch' };
		if (toolsParameters.webFetchMaxUses) {
			webFetchTool.max_uses = toolsParameters.webFetchMaxUses;
		}
		tools.push(webFetchTool);
	}
	if (toolsParameters.codeExecution === true) {
		tools.push({ type: 'code_execution_20260120', name: 'code_execution' });
	}
	if (tools.length > 0) {
		const toolsCache = cacheControlFor(caching.toolsTtl);
		if (toolsCache !== undefined) {
			tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: toolsCache };
		}
		body.tools = tools;
	}

	const breakpointCount = countCacheBreakpoints(tools, body.system, messages);
	if (breakpointCount > 4) {
		throw new NodeOperationError(
			this.getNode(),
			`The request has ${breakpointCount} cache breakpoints but the API allows at most 4 — remove some "Cache Up to Here" markers or fixed Prompt Caching breakpoints`,
			{ itemIndex },
		);
	}
	if (
		!forCountTokens &&
		(toolsParameters.toolChoice !== undefined || toolsParameters.disableParallelToolUse === true)
	) {
		const toolChoice: IDataObject = { type: toolsParameters.toolChoice ?? 'auto' };
		if (toolsParameters.toolChoice === 'tool') {
			if (!toolsParameters.toolChoiceName) {
				throw new NodeOperationError(
					this.getNode(),
					'Tool Choice "Specific Tool" needs the Tool Name field',
					{ itemIndex },
				);
			}
			toolChoice.name = toolsParameters.toolChoiceName;
		}
		if (toolsParameters.disableParallelToolUse === true) {
			toolChoice.disable_parallel_tool_use = true;
		}
		body.tool_choice = toolChoice;
	}

	// ---------- thinking ----------
	const thinking = this.getNodeParameter('thinking', itemIndex, {}) as ThinkingParameters;
	if (thinking.mode !== undefined && thinking.mode !== 'default') {
		if (thinking.mode === 'adaptive') {
			const thinkingConfig: IDataObject = { type: 'adaptive' };
			if (thinking.display !== undefined && thinking.display !== 'default') {
				thinkingConfig.display = thinking.display;
			}
			body.thinking = thinkingConfig;
		} else if (thinking.mode === 'disabled') {
			body.thinking = { type: 'disabled' };
		} else {
			body.thinking = { type: 'enabled', budget_tokens: thinking.budgetTokens ?? 1024 };
		}
	}

	// ---------- output config ----------
	const outputParameters = this.getNodeParameter('output', itemIndex, {}) as {
		effort?: string;
		structuredSchemaJson?: string;
	};
	const outputConfig: IDataObject = {};
	if (outputParameters.effort !== undefined && outputParameters.effort !== 'default') {
		outputConfig.effort = outputParameters.effort;
	}
	const schema = parseJsonParameter.call(
		this,
		outputParameters.structuredSchemaJson,
		'Structured Output Schema (JSON)',
		itemIndex,
	) as IDataObject | undefined;
	if (schema !== undefined) {
		// Accept either the bare JSON Schema or a pre-wrapped {type, schema} format object
		outputConfig.format =
			schema.type === 'json_schema' && schema.schema !== undefined
				? schema
				: { type: 'json_schema', schema };
	}
	if (Object.keys(outputConfig).length > 0) {
		body.output_config = outputConfig;
	}

	if (forCountTokens) {
		return { body, betas, includeHeaders: false };
	}

	// ---------- create-only parameters ----------
	body.max_tokens = this.getNodeParameter('maxTokens', itemIndex) as number;

	const options = this.getNodeParameter('options', itemIndex, {}) as {
		temperature?: number;
		topP?: number;
		topK?: number;
		stopSequences?: string[];
		userId?: string;
		serviceTier?: string;
		inferenceGeo?: string;
		betas?: string;
		timeout?: number;
		includeResponseHeaders?: boolean;
		requestOverridesJson?: string;
	};
	if (options.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options.topP !== undefined) {
		body.top_p = options.topP;
	}
	if (options.topK !== undefined) {
		body.top_k = options.topK;
	}
	if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
		body.stop_sequences = options.stopSequences;
	}
	if (options.userId) {
		body.metadata = { user_id: options.userId };
	}
	if (options.serviceTier !== undefined && options.serviceTier !== 'default') {
		body.service_tier = options.serviceTier;
	}
	if (options.inferenceGeo !== undefined && options.inferenceGeo !== 'default') {
		body.inference_geo = options.inferenceGeo;
	}
	if (options.betas) {
		betas.push(...options.betas.split(','));
	}
	const overrides = parseJsonParameter.call(
		this,
		options.requestOverridesJson,
		'Request Body Overrides (JSON)',
		itemIndex,
	) as IDataObject | undefined;
	if (overrides !== undefined) {
		Object.assign(body, overrides);
	}

	return {
		body,
		betas,
		timeout: options.timeout,
		includeHeaders: options.includeResponseHeaders === true,
	};
}

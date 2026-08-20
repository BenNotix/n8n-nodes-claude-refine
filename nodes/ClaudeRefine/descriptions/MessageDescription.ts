import type { INodeProperties } from 'n8n-workflow';

const CACHE_TTL_OPTIONS = [
	{ name: '1 Hour', value: '1h', description: 'Ephemeral cache with a 1-hour time to live' },
	{ name: '5 Minutes', value: '5m', description: 'Ephemeral cache with a 5-minute time to live' },
	{ name: 'No Caching', value: 'none', description: 'Do not place a cache breakpoint here' },
];

export const messageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{
				name: 'Count Tokens',
				value: 'countTokens',
				description: 'Count how many input tokens a message request would use (free of charge)',
				action: 'Count tokens for a message',
			},
			{
				name: 'Send',
				value: 'create',
				description: 'Send a conversation to Claude and return the response',
				action: 'Send a message',
			},
		],
		default: 'create',
	},
];

export const messageFields: INodeProperties[] = [
	// ----------------------------------------
	//         message: create / countTokens
	// ----------------------------------------
	{
		displayName: 'Model Name or ID',
		name: 'model',
		type: 'options',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		typeOptions: { loadOptionsMethod: 'getModels' },
		displayOptions: { show: { resource: ['message'] } },
		required: true,
		default: '',
	},
	{
		displayName: 'Input Type',
		name: 'inputType',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{
				name: 'Messages Builder',
				value: 'messages',
				description: 'Build the conversation turn by turn with the UI',
			},
			{
				name: 'Raw Messages (JSON)',
				value: 'json',
				description:
					'Provide the messages array as raw JSON, with full control over content blocks and cache_control placement',
			},
			{
				name: 'Simple Prompt',
				value: 'prompt',
				description: 'A single user message',
			},
		],
		default: 'prompt',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 4 },
		displayOptions: { show: { resource: ['message'], inputType: ['prompt'] } },
		default: '',
		placeholder: 'e.g. Summarize the following text…',
		description: 'The user message to send to Claude',
	},
	{
		displayName: 'Messages',
		name: 'messages',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		placeholder: 'Add Message',
		displayOptions: { show: { resource: ['message'], inputType: ['messages'] } },
		default: { message: [{ role: 'user', text: '', cacheControl: 'none' }] },
		options: [
			{
				displayName: 'Message',
				name: 'message',
				values: [
					{
						displayName: 'Role',
						name: 'role',
						type: 'options',
						options: [
							{ name: 'Assistant', value: 'assistant' },
							{ name: 'User', value: 'user' },
						],
						default: 'user',
					},
					{
						displayName: 'Text',
						name: 'text',
						type: 'string',
						typeOptions: { rows: 2 },
						default: '',
					},
					{
						displayName: 'Cache Up to Here',
						name: 'cacheControl',
						type: 'options',
						options: CACHE_TTL_OPTIONS,
						default: 'none',
						description:
							'Place a prompt-caching breakpoint on this message: everything up to and including it is cached and reused by later requests. Max 4 breakpoints per request across system, tools and messages.',
					},
				],
			},
		],
	},
	{
		displayName: 'Messages (JSON)',
		name: 'messagesJson',
		type: 'json',
		typeOptions: { rows: 6 },
		displayOptions: { show: { resource: ['message'], inputType: ['json'] } },
		default: '[\n\t{\n\t\t"role": "user",\n\t\t"content": ""\n\t}\n]',
		description:
			'The messages array exactly as the Anthropic API expects it — roles user/assistant (and system on supported models), string content or content-block arrays, including cache_control, tool_result and thinking blocks',
	},
	{
		displayName: 'System Prompt',
		name: 'system',
		type: 'string',
		typeOptions: { rows: 3 },
		displayOptions: { show: { resource: ['message'] } },
		default: '',
		description: 'System prompt that sets the behavior of the model for this request',
	},
	{
		displayName: 'Max Tokens',
		name: 'maxTokens',
		type: 'number',
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['message'], operation: ['create'] } },
		default: 4096,
		description:
			'Hard cap on generated tokens (thinking + text combined). The node does not stream, so very large values (over ~16,000) can hit HTTP timeouts — raise the Timeout option accordingly.',
	},
	{
		displayName: 'Simplify Output',
		name: 'simplify',
		type: 'boolean',
		displayOptions: { show: { resource: ['message'], operation: ['create'] } },
		default: true,
		description:
			'Whether to return a compact object (text, stop reason, usage, tool calls) instead of the raw API response',
	},
	{
		displayName: 'Attachments',
		name: 'attachments',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Attachment',
		displayOptions: { show: { resource: ['message'] } },
		default: {},
		description:
			'Images and documents (PDF, plain text) added to the last user message, for vision, document analysis and citations',
		options: [
			{
				displayName: 'Attachment',
				name: 'attachment',
				values: [
					{
						displayName: 'Base64 Data',
						name: 'base64Data',
						type: 'string',
						displayOptions: { show: { source: ['base64'] } },
						default: '',
						description: 'Raw base64 content, without a data URL prefix',
					},
					{
						displayName: 'Context',
						name: 'context',
						type: 'string',
						displayOptions: { show: { type: ['document'] } },
						default: '',
						description: 'Extra context about the document, not used for citations',
					},
					{
						displayName: 'Enable Citations',
						name: 'enableCitations',
						type: 'boolean',
						displayOptions: { show: { type: ['document'] } },
						default: false,
						description:
							'Whether Claude should cite passages of this document in its answer. Not compatible with structured outputs.',
					},
					{
						displayName: 'File ID',
						name: 'fileId',
						type: 'string',
						displayOptions: { show: { source: ['fileId'] } },
						default: '',
						placeholder: 'e.g. file_011CNha8iCJcU1wXNR6q4V8w',
						description: 'ID of a file previously uploaded through the File resource',
					},
					{
						displayName: 'Input Binary Field',
						name: 'binaryPropertyName',
						type: 'string',
						displayOptions: { show: { source: ['binary'] } },
						default: 'data',
						description: 'Name of the binary property of the input item that holds the file',
					},
					{
						displayName: 'Media Type',
						name: 'mediaType',
						type: 'string',
						displayOptions: { show: { source: ['base64', 'binary'] } },
						default: '',
						placeholder: 'e.g. application/pdf',
						description:
							'MIME type of the content (image/png, image/jpeg, application/pdf, text/plain…). For binary sources it defaults to the MIME type stored on the binary property.',
					},
					{
						displayName: 'Source',
						name: 'source',
						type: 'options',
						options: [
							{ name: 'Anthropic File ID', value: 'fileId' },
							{ name: 'Base64 Data', value: 'base64' },
							{ name: 'Binary Property', value: 'binary' },
							{ name: 'URL', value: 'url' },
						],
						default: 'binary',
					},
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						displayOptions: { show: { type: ['document'] } },
						default: '',
						description: 'Document title used in citations',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						options: [
							{ name: 'Document', value: 'document' },
							{ name: 'Image', value: 'image' },
						],
						default: 'image',
					},
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						displayOptions: { show: { source: ['url'] } },
						default: '',
						placeholder: 'e.g. https://example.com/image.png',
					},
				],
			},
		],
	},
	{
		displayName: 'Prompt Caching',
		name: 'promptCaching',
		type: 'collection',
		placeholder: 'Add Cache Breakpoint',
		displayOptions: { show: { resource: ['message'], operation: ['create'] } },
		default: {},
		description:
			'Prompt caching breakpoints — cached prefixes cost ~10% to read and do not count toward input-token rate limits. Order matters: tools → system → messages. Prefixes below the model minimum (512–4096 tokens) are silently not cached.',
		options: [
			{
				displayName: 'Cache Conversation',
				name: 'messagesTtl',
				type: 'options',
				options: CACHE_TTL_OPTIONS,
				default: '5m',
				description:
					'Place a breakpoint on the last message, caching the whole conversation so far — ideal for chat memory loops',
			},
			{
				displayName: 'Cache System Prompt',
				name: 'systemTtl',
				type: 'options',
				options: CACHE_TTL_OPTIONS,
				default: '5m',
				description: 'Place a breakpoint after the system prompt',
			},
			{
				displayName: 'Cache Tool Definitions',
				name: 'toolsTtl',
				type: 'options',
				options: CACHE_TTL_OPTIONS,
				default: '5m',
				description: 'Place a breakpoint after the last tool definition',
			},
		],
	},
	{
		displayName: 'Extended Thinking',
		name: 'thinking',
		type: 'collection',
		placeholder: 'Add Thinking Option',
		displayOptions: { show: { resource: ['message'] } },
		default: {},
		options: [
			{
				displayName: 'Budget Tokens (Legacy)',
				name: 'budgetTokens',
				type: 'number',
				typeOptions: { minValue: 1024 },
				default: 1024,
				description:
					'Thinking token budget, only used when Mode is "Legacy Budget". Must be at least 1024 and lower than Max Tokens. Only valid on Claude 4.6 and older models.',
			},
			{
				displayName: 'Display',
				name: 'display',
				type: 'options',
				options: [
					{
						name: 'Default',
						value: 'default',
						description: 'Model default — omitted on Opus 4.7+ and newer',
					},
					{
						name: 'Omitted',
						value: 'omitted',
						description: 'Thinking happens but the blocks come back with empty text',
					},
					{
						name: 'Summarized',
						value: 'summarized',
						description: 'Return a readable summary of the reasoning',
					},
				],
				default: 'default',
				description: 'Visibility of the thinking blocks in the response (adaptive mode only)',
			},
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				options: [
					{
						name: 'Adaptive',
						value: 'adaptive',
						description:
							'Claude decides when and how much to think — recommended on Claude 4.6+ models',
					},
					{
						name: 'Default (Model Behavior)',
						value: 'default',
						description:
							'Do not send a thinking parameter — thinking is on for Opus 5 / Sonnet 5 / Fable 5, off for older models',
					},
					{
						name: 'Disabled',
						value: 'disabled',
						description:
							'Turn thinking off. Rejected by Fable 5, and by Opus 5 at effort Xhigh/Max.',
					},
					{
						name: 'Legacy Budget',
						value: 'budget',
						description:
							'Fixed thinking token budget — only for Claude 4.6 and older models, rejected by newer ones',
					},
				],
				default: 'adaptive',
			},
		],
	},
	{
		displayName: 'Tools',
		name: 'tools',
		type: 'collection',
		placeholder: 'Add Tool Option',
		displayOptions: { show: { resource: ['message'] } },
		default: {},
		description:
			'Custom tools (returned as tool_use blocks for your workflow to execute) and Anthropic server tools (executed by Anthropic, results included in the response)',
		options: [
			{
				displayName: 'Code Execution',
				name: 'codeExecution',
				type: 'boolean',
				default: false,
				description:
					'Whether to let Claude run Python and bash in a sandboxed container on Anthropic servers (Claude 4.5+ models). Generated files can be downloaded through the File resource.',
			},
			{
				displayName: 'Custom Tools (JSON)',
				name: 'customToolsJson',
				type: 'json',
				typeOptions: { rows: 6 },
				default: '',
				description:
					'Array of tool definitions ({name, description, input_schema, strict?}). Claude replies with tool_use blocks; execute them in your workflow and send tool_result blocks back through Raw Messages (JSON).',
			},
			{
				displayName: 'Disable Parallel Tool Use',
				name: 'disableParallelToolUse',
				type: 'boolean',
				default: false,
				description: 'Whether to force at most one tool call per response',
			},
			{
				displayName: 'Forced Tool Name',
				name: 'toolChoiceName',
				type: 'string',
				default: '',
				description: 'Name of the tool to force, only used when Tool Choice is "Specific Tool"',
			},
			{
				displayName: 'Tool Choice',
				name: 'toolChoice',
				type: 'options',
				options: [
					{ name: 'Any', value: 'any', description: 'Claude must use one of the tools' },
					{ name: 'Auto', value: 'auto', description: 'Claude decides whether to use tools' },
					{ name: 'None', value: 'none', description: 'Claude must not use tools' },
					{
						name: 'Specific Tool',
						value: 'tool',
						description: 'Claude must use the tool set in Forced Tool Name',
					},
				],
				default: 'auto',
			},
			{
				displayName: 'Web Fetch',
				name: 'webFetch',
				type: 'boolean',
				default: false,
				description:
					'Whether to let Claude fetch the full content of URLs already present in the conversation (Claude 4.6+ models)',
			},
			{
				displayName: 'Web Fetch Max Uses',
				name: 'webFetchMaxUses',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 5,
				description: 'Maximum number of fetches per request, only used when Web Fetch is enabled',
			},
			{
				displayName: 'Web Search',
				name: 'webSearch',
				type: 'boolean',
				default: false,
				description:
					'Whether to let Claude search the web on Anthropic servers, with automatic citations (Claude 4.6+ models)',
			},
			{
				displayName: 'Web Search Allowed Domains',
				name: 'webSearchAllowedDomains',
				type: 'string',
				default: '',
				placeholder: 'e.g. example.com, docs.example.com',
				description:
					'Comma-separated list of the only domains Claude may search. Cannot be combined with blocked domains (allowed wins).',
			},
			{
				displayName: 'Web Search Blocked Domains',
				name: 'webSearchBlockedDomains',
				type: 'string',
				default: '',
				placeholder: 'e.g. reddit.com',
				description: 'Comma-separated list of domains Claude must not use',
			},
			{
				displayName: 'Web Search Max Uses',
				name: 'webSearchMaxUses',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 5,
				description: 'Maximum number of searches per request, only used when Web Search is enabled',
			},
		],
	},
	{
		displayName: 'Output',
		name: 'output',
		type: 'collection',
		placeholder: 'Add Output Option',
		displayOptions: { show: { resource: ['message'] } },
		default: {},
		options: [
			{
				displayName: 'Effort',
				name: 'effort',
				type: 'options',
				options: [
					{ name: 'Default (High)', value: 'default' },
					{ name: 'High', value: 'high' },
					{ name: 'Low', value: 'low' },
					{ name: 'Max', value: 'max' },
					{ name: 'Medium', value: 'medium' },
					{ name: 'Xhigh', value: 'xhigh' },
				],
				default: 'default',
				description:
					'How many tokens Claude may spend thinking and answering — the scale is low, medium, high, xhigh, max. Xhigh needs Opus 4.7+ / Sonnet 5 / Fable 5; Max works on Opus 4.6+ and Sonnet 4.6+; Haiku 4.5 does not support effort at all.',
			},
			{
				displayName: 'Structured Output Schema (JSON)',
				name: 'structuredSchemaJson',
				type: 'json',
				typeOptions: { rows: 6 },
				default: '',
				description:
					'JSON Schema the response must conform to (objects need additionalProperties: false). The simplified output parses the result into a "parsed" field. Not compatible with citations.',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		displayOptions: { show: { resource: ['message'], operation: ['create'] } },
		default: {},
		options: [
			{
				displayName: 'Anthropic Beta Headers',
				name: 'betas',
				type: 'string',
				default: '',
				placeholder: 'e.g. mcp-client-2025-11-20',
				description:
					'Comma-separated anthropic-beta feature flags to send with the request, for beta features used through Request Body Overrides',
			},
			{
				displayName: 'Include Response Headers',
				name: 'includeResponseHeaders',
				type: 'boolean',
				default: false,
				description:
					'Whether to add the Anthropic rate-limit headers and request ID to the output, for flow control in the workflow',
			},
			{
				displayName: 'Inference Region',
				name: 'inferenceGeo',
				type: 'options',
				options: [
					{ name: 'Default', value: 'default' },
					{ name: 'Global', value: 'global' },
					{ name: 'US', value: 'us' },
				],
				default: 'default',
				description: 'Pin where inference runs, for data-residency requirements (Claude 4.6+)',
			},
			{
				displayName: 'Request Body Overrides (JSON)',
				name: 'requestOverridesJson',
				type: 'json',
				typeOptions: { rows: 4 },
				default: '',
				description:
					'Object merged into the request body last (top-level keys overwrite). Escape hatch for API features without a dedicated field: mcp_servers, container, context_management, fallbacks, task budgets.',
			},
			{
				displayName: 'Service Tier',
				name: 'serviceTier',
				type: 'options',
				options: [
					{ name: 'Auto', value: 'auto', description: 'Use priority capacity if available' },
					{ name: 'Default', value: 'default' },
					{ name: 'Standard Only', value: 'standard_only' },
				],
				default: 'default',
				description: 'Which capacity tier to use for this request',
			},
			{
				displayName: 'Stop Sequences',
				name: 'stopSequences',
				type: 'string',
				typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Stop Sequence' },
				default: [],
				description: 'Custom sequences that make the model stop generating when produced',
			},
			{
				displayName: 'Temperature',
				name: 'temperature',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
				default: 1,
				description:
					'Randomness of the response, 0–1. Removed on Opus 5 / Opus 4.8 / Opus 4.7 / Sonnet 5 / Fable 5 (sending it there returns a 400). On Claude 4 models do not combine with Top P.',
			},
			{
				displayName: 'Timeout (Ms)',
				name: 'timeout',
				type: 'number',
				typeOptions: { minValue: 1000 },
				default: 300000,
				description:
					'Maximum time to wait for the response. Raise it for large Max Tokens values or deep thinking.',
			},
			{
				displayName: 'Top K',
				name: 'topK',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 40,
				description:
					'Sample only from the top K options per token. Advanced use; same model restrictions as Temperature.',
			},
			{
				displayName: 'Top P',
				name: 'topP',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 3 },
				default: 0.999,
				description:
					'Nucleus sampling threshold. Advanced use; same model restrictions as Temperature.',
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				description:
					'Opaque external identifier for the end user, sent as metadata.user_id for abuse detection. Do not use names or email addresses.',
			},
		],
	},
];

import type { INodeProperties } from 'n8n-workflow';

export const batchOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['batch'] } },
		options: [
			{
				name: 'Cancel',
				value: 'cancel',
				description: 'Cancel a batch that is still processing',
				action: 'Cancel a batch',
			},
			{
				name: 'Create',
				value: 'create',
				description:
					'Send up to 100,000 message requests as one asynchronous batch, at 50% of the standard price',
				action: 'Create a batch',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete an ended batch',
				action: 'Delete a batch',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a batch and its processing status — poll until it is "ended"',
				action: 'Get a batch',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'List the batches of the workspace',
				action: 'Get many batches',
			},
			{
				name: 'Get Results',
				value: 'getResults',
				description: 'Download the results of an ended batch, one output item per request',
				action: 'Get batch results',
			},
		],
		default: 'create',
	},
];

export const batchFields: INodeProperties[] = [
	// ----------------------------------------
	//              batch: create
	// ----------------------------------------
	{
		displayName: 'Requests Source',
		name: 'requestsSource',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['batch'], operation: ['create'] } },
		options: [
			{
				name: 'Build From Input Items',
				value: 'items',
				description: 'Each input item of this node becomes one request of a single batch',
			},
			{
				name: 'Raw JSON',
				value: 'json',
				description: 'Provide the full requests array ({custom_id, params}) yourself',
			},
		],
		default: 'items',
	},
	{
		displayName: 'Custom ID',
		name: 'customId',
		type: 'string',
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['items'] },
		},
		default: '=item-{{ $itemIndex }}',
		description:
			'Unique identifier of the request inside the batch (1–64 characters: letters, digits, _ and -). Results come back in any order — match them by this ID.',
	},
	{
		displayName: 'Model Name or ID',
		name: 'model',
		type: 'options',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		typeOptions: { loadOptionsMethod: 'getModels' },
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['items'] },
		},
		required: true,
		default: '',
	},
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 3 },
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['items'] },
		},
		default: '',
		description: 'The user message of this request — use expressions to vary it per item',
	},
	{
		displayName: 'System Prompt',
		name: 'system',
		type: 'string',
		typeOptions: { rows: 2 },
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['items'] },
		},
		default: '',
	},
	{
		displayName: 'Max Tokens',
		name: 'maxTokens',
		type: 'number',
		typeOptions: { minValue: 1 },
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['items'] },
		},
		default: 4096,
	},
	{
		displayName: 'Params Overrides (JSON)',
		name: 'paramsOverridesJson',
		type: 'json',
		typeOptions: { rows: 4 },
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['items'] },
		},
		default: '',
		description:
			'Object merged into the params of each request (top-level keys overwrite) — thinking, tools, output_config, cache_control-annotated system blocks…',
	},
	{
		displayName: 'Requests (JSON)',
		name: 'requestsJson',
		type: 'json',
		typeOptions: { rows: 8 },
		displayOptions: {
			show: { resource: ['batch'], operation: ['create'], requestsSource: ['json'] },
		},
		default:
			'[\n\t{\n\t\t"custom_id": "item-1",\n\t\t"params": {\n\t\t\t"model": "claude-sonnet-4-6",\n\t\t\t"max_tokens": 1024,\n\t\t\t"messages": [{ "role": "user", "content": "" }]\n\t\t}\n\t}\n]',
		description:
			'Full requests array — each entry needs a unique custom_id and the params of a /v1/messages call',
	},
	// ----------------------------------------
	//   batch: cancel / delete / get / getResults
	// ----------------------------------------
	{
		displayName: 'Batch ID',
		name: 'batchId',
		type: 'string',
		displayOptions: {
			show: { resource: ['batch'], operation: ['cancel', 'delete', 'get', 'getResults'] },
		},
		required: true,
		default: '',
		placeholder: 'e.g. msgbatch_013Zva2CMHLNnXjNJJKqJ2EF',
	},
	{
		displayName: 'Simplify Output',
		name: 'simplifyResults',
		type: 'boolean',
		displayOptions: { show: { resource: ['batch'], operation: ['getResults'] } },
		default: true,
		description:
			'Whether to return compact result objects (custom ID, status, text, usage) instead of the raw result lines',
	},
	// ----------------------------------------
	//              batch: getMany
	// ----------------------------------------
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: { show: { resource: ['batch'], operation: ['getMany'] } },
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['batch'], operation: ['getMany'], returnAll: [false] } },
		default: 50,
		description: 'Max number of results to return',
	},
];

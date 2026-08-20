import type { INodeProperties } from 'n8n-workflow';

export const customOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['custom'] } },
		options: [
			{
				name: 'Make Request',
				value: 'makeRequest',
				description:
					'Call any Anthropic API endpoint with the node credential — for endpoints without a dedicated operation (skills, usage, admin…)',
				action: 'Make a custom API request',
			},
		],
		default: 'makeRequest',
	},
];

export const customFields: INodeProperties[] = [
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		displayOptions: { show: { resource: ['custom'] } },
		options: [
			{ name: 'DELETE', value: 'DELETE' },
			{ name: 'GET', value: 'GET' },
			{ name: 'PATCH', value: 'PATCH' },
			{ name: 'POST', value: 'POST' },
			{ name: 'PUT', value: 'PUT' },
		],
		default: 'GET',
	},
	{
		displayName: 'Endpoint',
		name: 'endpoint',
		type: 'string',
		displayOptions: { show: { resource: ['custom'] } },
		required: true,
		default: '',
		placeholder: 'e.g. /v1/skills',
		description: 'Path of the endpoint, starting with /',
	},
	{
		displayName: 'Query Parameters (JSON)',
		name: 'qsJson',
		type: 'json',
		displayOptions: { show: { resource: ['custom'] } },
		default: '',
		description: 'Object of query-string parameters',
	},
	{
		displayName: 'Body (JSON)',
		name: 'bodyJson',
		type: 'json',
		typeOptions: { rows: 6 },
		displayOptions: { show: { resource: ['custom'] } },
		default: '',
		description: 'JSON request body, for POST/PUT/PATCH calls',
	},
	{
		displayName: 'Anthropic Beta Headers',
		name: 'betas',
		type: 'string',
		displayOptions: { show: { resource: ['custom'] } },
		default: '',
		placeholder: 'e.g. skills-2025-10-02',
		description: 'Comma-separated anthropic-beta feature flags to send with the request',
	},
	{
		displayName: 'Return Full Response',
		name: 'fullResponse',
		type: 'boolean',
		displayOptions: { show: { resource: ['custom'] } },
		default: false,
		description:
			'Whether to return the full response (body, headers, status code) instead of the body only',
	},
];

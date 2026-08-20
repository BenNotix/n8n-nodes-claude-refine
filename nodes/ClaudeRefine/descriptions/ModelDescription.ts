import type { INodeProperties } from 'n8n-workflow';

export const modelOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['model'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description:
					'Get a model with its context window, output cap and capability tree (thinking modes, effort levels, structured outputs…)',
				action: 'Get a model',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'List the models available to the API key',
				action: 'Get many models',
			},
		],
		default: 'getMany',
	},
];

export const modelFields: INodeProperties[] = [
	{
		displayName: 'Model ID',
		name: 'modelId',
		type: 'string',
		displayOptions: { show: { resource: ['model'], operation: ['get'] } },
		required: true,
		default: '',
		placeholder: 'e.g. claude-sonnet-4-6',
		description: 'Model ID or alias',
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: { show: { resource: ['model'], operation: ['getMany'] } },
		default: true,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['model'], operation: ['getMany'], returnAll: [false] } },
		default: 50,
		description: 'Max number of results to return',
	},
];

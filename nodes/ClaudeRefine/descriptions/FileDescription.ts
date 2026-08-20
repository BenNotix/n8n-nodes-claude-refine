import type { INodeProperties } from 'n8n-workflow';

export const fileOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['file'] } },
		options: [
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a file from the workspace',
				action: 'Delete a file',
			},
			{
				name: 'Download',
				value: 'download',
				description:
					'Download the content of a file — only files created by code execution or skills are downloadable',
				action: 'Download a file',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the metadata of a file',
				action: 'Get a file',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'List the files of the workspace',
				action: 'Get many files',
			},
			{
				name: 'Upload',
				value: 'upload',
				description:
					'Upload a file once and reference it in messages by ID, instead of re-sending the content with every request',
				action: 'Upload a file',
			},
		],
		default: 'upload',
	},
];

export const fileFields: INodeProperties[] = [
	// ----------------------------------------
	//               file: upload
	// ----------------------------------------
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
		required: true,
		default: 'data',
		description: 'Name of the binary property of the input item that holds the file to upload',
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
		default: '',
		description: 'Overrides the file name stored on the binary property',
	},
	{
		displayName: 'MIME Type',
		name: 'mimeType',
		type: 'string',
		displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
		default: '',
		placeholder: 'e.g. application/pdf',
		description: 'Overrides the MIME type stored on the binary property',
	},
	// ----------------------------------------
	//     file: delete / download / get
	// ----------------------------------------
	{
		displayName: 'File ID',
		name: 'fileId',
		type: 'string',
		displayOptions: { show: { resource: ['file'], operation: ['delete', 'download', 'get'] } },
		required: true,
		default: '',
		placeholder: 'e.g. file_011CNha8iCJcU1wXNR6q4V8w',
	},
	{
		displayName: 'Put Output in Field',
		name: 'downloadBinaryProperty',
		type: 'string',
		displayOptions: { show: { resource: ['file'], operation: ['download'] } },
		default: 'data',
		description: 'Name of the binary property to write the downloaded content to',
	},
	// ----------------------------------------
	//              file: getMany
	// ----------------------------------------
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: { show: { resource: ['file'], operation: ['getMany'] } },
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['file'], operation: ['getMany'], returnAll: [false] } },
		default: 50,
		description: 'Max number of results to return',
	},
];

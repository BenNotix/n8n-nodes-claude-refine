import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { jsonParse, NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { batchFields, batchOperations } from './descriptions/BatchDescription';
import { customFields, customOperations } from './descriptions/CustomDescription';
import { fileFields, fileOperations } from './descriptions/FileDescription';
import { messageFields, messageOperations } from './descriptions/MessageDescription';
import { modelFields, modelOperations } from './descriptions/ModelDescription';
import type { ClaudeRequestExtras } from './GenericFunctions';
import {
	buildMessageRequestBody,
	claudeApiRequest,
	claudeApiRequestAllItems,
	FILES_API_BETA,
	parseJsonParameter,
} from './GenericFunctions';

/** custom_id constraint of the Batches API. */
const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Compact view of a /v1/messages response: the text, what stopped the model,
 * tool calls to execute, citations and the usage block (which carries the
 * cache_creation/cache_read token counts prompt-caching users care about).
 */
function simplifyMessageResponse(response: IDataObject, parseStructured: boolean): IDataObject {
	const content = (response.content as IDataObject[] | undefined) ?? [];
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const toolUses: IDataObject[] = [];
	const citations: IDataObject[] = [];
	const serverToolResults: IDataObject[] = [];

	for (const block of content) {
		if (block.type === 'text') {
			textParts.push((block.text as string) ?? '');
			if (Array.isArray(block.citations)) {
				citations.push(...(block.citations as IDataObject[]));
			}
		} else if (block.type === 'thinking') {
			if (typeof block.thinking === 'string' && block.thinking !== '') {
				thinkingParts.push(block.thinking);
			}
		} else if (block.type === 'tool_use') {
			toolUses.push(block);
		} else if (typeof block.type === 'string' && block.type.endsWith('_tool_result')) {
			serverToolResults.push(block);
		}
	}

	const text = textParts.join('');
	const simplified: IDataObject = {
		id: response.id,
		model: response.model,
		text,
		stopReason: response.stop_reason,
		usage: response.usage,
	};
	if (parseStructured && text !== '') {
		try {
			simplified.parsed = jsonParse<IDataObject>(text);
		} catch {
			// Structured output requested but the reply is not valid JSON
			// (refusal, max_tokens cutoff…) — the raw text is still returned
		}
	}
	if (response.stop_details !== undefined && response.stop_details !== null) {
		simplified.stopDetails = response.stop_details;
	}
	if (response.stop_sequence !== undefined && response.stop_sequence !== null) {
		simplified.stopSequence = response.stop_sequence;
	}
	if (thinkingParts.length > 0) {
		simplified.thinking = thinkingParts.join('\n\n');
	}
	if (toolUses.length > 0) {
		simplified.toolUses = toolUses;
	}
	if (citations.length > 0) {
		simplified.citations = citations;
	}
	if (serverToolResults.length > 0) {
		simplified.serverToolResults = serverToolResults;
	}
	if (response.container !== undefined && response.container !== null) {
		simplified.container = response.container;
	}
	return simplified;
}

/** Keep only the operationally useful response headers (rate limits, request ID). */
function filterAnthropicHeaders(headers: IDataObject | undefined): IDataObject {
	const kept: IDataObject = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		const lower = key.toLowerCase();
		if (lower.startsWith('anthropic-') || lower === 'request-id' || lower === 'retry-after') {
			kept[lower] = value;
		}
	}
	return kept;
}

/** Compact view of one JSONL line of a batch results file. */
function simplifyBatchResult(line: IDataObject): IDataObject {
	const result = (line.result as IDataObject | undefined) ?? {};
	const simplified: IDataObject = {
		customId: line.custom_id,
		status: result.type,
	};
	if (result.type === 'succeeded') {
		const message = (result.message as IDataObject | undefined) ?? {};
		const content = (message.content as IDataObject[] | undefined) ?? [];
		simplified.text = content
			.filter((block) => block.type === 'text')
			.map((block) => (block.text as string) ?? '')
			.join('');
		simplified.model = message.model;
		simplified.stopReason = message.stop_reason;
		simplified.usage = message.usage;
	} else if (result.type === 'errored') {
		simplified.error = result.error;
	}
	return simplified;
}

export class ClaudeRefine implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude Refine',
		name: 'claudeRefine',
		icon: {
			light: 'file:../../icons/claude-refine.svg',
			dark: 'file:../../icons/claude-refine.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Use the full Anthropic Claude API — messages with prompt caching, extended thinking, tools, citations and structured outputs, plus batches, token counting, files and models',
		defaults: {
			name: 'Claude Refine',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'claudeRefineApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Batch',
						value: 'batch',
						description: 'Process many message requests asynchronously at 50% of the price',
					},
					{
						name: 'Custom API Call',
						value: 'custom',
						description: 'Call any other Anthropic API endpoint with the node credential',
					},
					{
						name: 'File',
						value: 'file',
						description: 'Upload files once and reference them in messages by ID',
					},
					{
						name: 'Message',
						value: 'message',
						description: 'Send conversations to Claude and count tokens',
					},
					{
						name: 'Model',
						value: 'model',
						description: 'Discover available models and their capabilities',
					},
				],
				default: 'message',
			},
			...messageOperations,
			...messageFields,
			...batchOperations,
			...batchFields,
			...fileOperations,
			...fileFields,
			...modelOperations,
			...modelFields,
			...customOperations,
			...customFields,
		],
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const models = await claudeApiRequestAllItems.call(this, '/v1/models');
				return models
					.map((model) => ({
						name: (model.display_name as string) ?? (model.id as string),
						value: model.id as string,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// ----------------------------------------
		//    batch: create from ALL input items
		// ----------------------------------------
		// One batch is created for the whole run: each input item becomes one
		// request, so this happens outside the per-item loop.
		if (
			resource === 'batch' &&
			operation === 'create' &&
			(this.getNodeParameter('requestsSource', 0) as string) === 'items'
		) {
			try {
				const requests: IDataObject[] = [];
				const seenCustomIds = new Set<string>();
				for (let i = 0; i < items.length; i++) {
					const customId = this.getNodeParameter('customId', i) as string;
					if (!CUSTOM_ID_PATTERN.test(customId)) {
						throw new NodeOperationError(
							this.getNode(),
							`Custom ID "${customId}" is invalid — use 1–64 letters, digits, underscores or dashes`,
							{ itemIndex: i },
						);
					}
					if (seenCustomIds.has(customId)) {
						throw new NodeOperationError(
							this.getNode(),
							`Custom ID "${customId}" is used by more than one item — every request of a batch needs a unique one`,
							{ itemIndex: i },
						);
					}
					seenCustomIds.add(customId);

					const params: IDataObject = {
						model: this.getNodeParameter('model', i) as string,
						max_tokens: this.getNodeParameter('maxTokens', i) as number,
						messages: [{ role: 'user', content: this.getNodeParameter('prompt', i) as string }],
					};
					const system = this.getNodeParameter('system', i, '') as string;
					if (system !== '') {
						params.system = system;
					}
					const overrides = parseJsonParameter.call(
						this,
						this.getNodeParameter('paramsOverridesJson', i, ''),
						'Params Overrides (JSON)',
						i,
					) as IDataObject | undefined;
					if (overrides !== undefined) {
						Object.assign(params, overrides);
					}
					// A single empty user message means the Prompt was forgotten (and
					// no messages override replaced it) — fail before submitting the batch
					const finalMessages = params.messages as IDataObject[];
					if (
						Array.isArray(finalMessages) &&
						finalMessages.length === 1 &&
						typeof finalMessages[0].content === 'string' &&
						finalMessages[0].content.trim() === ''
					) {
						throw new NodeOperationError(
							this.getNode(),
							'The Prompt is empty for this item — set Prompt or provide messages through Params Overrides (JSON)',
							{ itemIndex: i },
						);
					}
					requests.push({ custom_id: customId, params });
				}

				const response = await claudeApiRequest.call(this, 'POST', '/v1/messages/batches', {
					body: { requests },
				});
				returnData.push({
					json: response,
					pairedItem: items.map((_item, index) => ({ item: index })),
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: items.map((_item, index) => ({ item: index })),
					});
					return [returnData];
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					// Already one of the n8n error classes — re-throw as-is
					const alreadyWrapped = error;
					throw alreadyWrapped;
				}
				throw new NodeOperationError(this.getNode(), error as Error);
			}
			return [returnData];
		}

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject | IDataObject[];

				if (resource === 'message') {
					// ----------------------------------------
					//         message: create / countTokens
					// ----------------------------------------
					if (operation === 'create') {
						const { body, betas, timeout, includeHeaders } = await buildMessageRequestBody.call(
							this,
							i,
							false,
						);
						const extras: ClaudeRequestExtras = { body, betas, timeout };
						if (includeHeaders) {
							extras.returnFullResponse = true;
						}
						let response = await claudeApiRequest.call(this, 'POST', '/v1/messages', extras);
						let responseHeaders: IDataObject | undefined;
						if (includeHeaders) {
							responseHeaders = filterAnthropicHeaders(response.headers as IDataObject);
							response = response.body as IDataObject;
						}

						const simplify = this.getNodeParameter('simplify', i) as boolean;
						if (simplify) {
							const outputParameters = this.getNodeParameter('output', i, {}) as IDataObject;
							const parseStructured =
								outputParameters.structuredSchemaJson !== undefined &&
								outputParameters.structuredSchemaJson !== '';
							responseData = simplifyMessageResponse(response, parseStructured);
						} else {
							responseData = response;
						}
						if (responseHeaders !== undefined) {
							responseData = { ...responseData, responseHeaders };
						}
					} else {
						const { body, betas } = await buildMessageRequestBody.call(this, i, true);
						responseData = await claudeApiRequest.call(this, 'POST', '/v1/messages/count_tokens', {
							body,
							betas,
						});
					}
				} else if (resource === 'batch') {
					// ----------------------------------------
					//   batch: create (JSON) / get / getMany /
					//          getResults / cancel / delete
					// ----------------------------------------
					if (operation === 'create') {
						const requests = parseJsonParameter.call(
							this,
							this.getNodeParameter('requestsJson', i),
							'Requests (JSON)',
							i,
						);
						if (!Array.isArray(requests) || requests.length === 0) {
							throw new NodeOperationError(
								this.getNode(),
								'Requests (JSON) must be a non-empty array of {custom_id, params} objects',
								{ itemIndex: i },
							);
						}
						responseData = await claudeApiRequest.call(this, 'POST', '/v1/messages/batches', {
							body: { requests },
						});
					} else if (operation === 'get') {
						const batchId = this.getNodeParameter('batchId', i) as string;
						responseData = await claudeApiRequest.call(
							this,
							'GET',
							`/v1/messages/batches/${encodeURIComponent(batchId)}`,
						);
					} else if (operation === 'getMany') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						responseData = await claudeApiRequestAllItems.call(this, '/v1/messages/batches', {
							maxItems: returnAll ? undefined : (this.getNodeParameter('limit', i) as number),
						});
					} else if (operation === 'getResults') {
						const batchId = this.getNodeParameter('batchId', i) as string;
						const batch = await claudeApiRequest.call(
							this,
							'GET',
							`/v1/messages/batches/${encodeURIComponent(batchId)}`,
						);
						if (batch.processing_status !== 'ended') {
							throw new NodeOperationError(
								this.getNode(),
								`Batch ${batchId} has not ended yet (status: ${batch.processing_status}) — poll the Get operation until processing_status is "ended"`,
								{ itemIndex: i },
							);
						}
						const resultsUrl = batch.results_url as string | null;
						if (!resultsUrl) {
							throw new NodeOperationError(
								this.getNode(),
								`Batch ${batchId} has no results file (it may have been deleted or expired)`,
								{ itemIndex: i },
							);
						}
						// results_url is absolute and always points at api.anthropic.com —
						// re-anchor the known results path on the credential base URL so
						// custom gateways keep working
						const raw = (await claudeApiRequest.call(
							this,
							'GET',
							`/v1/messages/batches/${encodeURIComponent(batchId)}/results`,
							{ encoding: 'text' },
						)) as unknown as string;
						const simplify = this.getNodeParameter('simplifyResults', i) as boolean;
						const lines = String(raw)
							.split('\n')
							.map((line) => line.trim())
							.filter((line) => line !== '');
						responseData = lines.map((line) => {
							const parsed = jsonParse<IDataObject>(line);
							return simplify ? simplifyBatchResult(parsed) : parsed;
						});
					} else if (operation === 'cancel') {
						const batchId = this.getNodeParameter('batchId', i) as string;
						responseData = await claudeApiRequest.call(
							this,
							'POST',
							`/v1/messages/batches/${encodeURIComponent(batchId)}/cancel`,
						);
					} else {
						const batchId = this.getNodeParameter('batchId', i) as string;
						responseData = await claudeApiRequest.call(
							this,
							'DELETE',
							`/v1/messages/batches/${encodeURIComponent(batchId)}`,
						);
					}
				} else if (resource === 'file') {
					// ----------------------------------------
					//  file: upload / get / getMany / download / delete
					// ----------------------------------------
					if (operation === 'upload') {
						const propertyName = this.getNodeParameter('binaryPropertyName', i) as string;
						this.helpers.assertBinaryData(i, propertyName);
						const binaryMetadata = items[i].binary![propertyName];
						const buffer = await this.helpers.getBinaryDataBuffer(i, propertyName);
						const fileName =
							(this.getNodeParameter('fileName', i, '') as string) ||
							binaryMetadata.fileName ||
							'file';
						const mimeType =
							(this.getNodeParameter('mimeType', i, '') as string) ||
							binaryMetadata.mimeType ||
							'application/octet-stream';

						// The Files API expects multipart/form-data; built by hand so the
						// package needs no runtime dependency
						const boundary = `----n8nClaudeRefine${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
						// Control characters or quotes in the filename would corrupt the part header
						const safeFileName = fileName.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
						const body = Buffer.concat([
							Buffer.from(
								`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
									`Content-Type: ${mimeType}\r\n\r\n`,
								'utf8',
							),
							buffer,
							Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
						]);
						responseData = await claudeApiRequest.call(this, 'POST', '/v1/files', {
							body,
							betas: [FILES_API_BETA],
							headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
						});
					} else if (operation === 'get') {
						const fileId = this.getNodeParameter('fileId', i) as string;
						responseData = await claudeApiRequest.call(
							this,
							'GET',
							`/v1/files/${encodeURIComponent(fileId)}`,
							{
								betas: [FILES_API_BETA],
							},
						);
					} else if (operation === 'getMany') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						responseData = await claudeApiRequestAllItems.call(this, '/v1/files', {
							betas: [FILES_API_BETA],
							maxItems: returnAll ? undefined : (this.getNodeParameter('limit', i) as number),
						});
					} else if (operation === 'download') {
						const fileId = this.getNodeParameter('fileId', i) as string;
						const propertyName = this.getNodeParameter('downloadBinaryProperty', i) as string;
						const metadata = await claudeApiRequest.call(
							this,
							'GET',
							`/v1/files/${encodeURIComponent(fileId)}`,
							{
								betas: [FILES_API_BETA],
							},
						);
						const content = (await claudeApiRequest.call(
							this,
							'GET',
							`/v1/files/${encodeURIComponent(fileId)}/content`,
							{ betas: [FILES_API_BETA], encoding: 'arraybuffer' },
						)) as unknown as Buffer;
						const binaryData = await this.helpers.prepareBinaryData(
							Buffer.from(content),
							(metadata.filename as string) ?? fileId,
							(metadata.mime_type as string) ?? undefined,
						);
						returnData.push({
							json: metadata,
							binary: { [propertyName]: binaryData },
							pairedItem: { item: i },
						});
						continue;
					} else {
						const fileId = this.getNodeParameter('fileId', i) as string;
						responseData = await claudeApiRequest.call(
							this,
							'DELETE',
							`/v1/files/${encodeURIComponent(fileId)}`,
							{
								betas: [FILES_API_BETA],
							},
						);
					}
				} else if (resource === 'model') {
					// ----------------------------------------
					//           model: get / getMany
					// ----------------------------------------
					if (operation === 'get') {
						const modelId = this.getNodeParameter('modelId', i) as string;
						responseData = await claudeApiRequest.call(
							this,
							'GET',
							`/v1/models/${encodeURIComponent(modelId)}`,
						);
					} else {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						responseData = await claudeApiRequestAllItems.call(this, '/v1/models', {
							maxItems: returnAll ? undefined : (this.getNodeParameter('limit', i) as number),
						});
					}
				} else {
					// ----------------------------------------
					//           custom: makeRequest
					// ----------------------------------------
					const method = this.getNodeParameter('method', i) as IHttpRequestMethods;
					const endpoint = this.getNodeParameter('endpoint', i) as string;
					if (!endpoint.startsWith('/')) {
						throw new NodeOperationError(this.getNode(), 'Endpoint must start with /', {
							itemIndex: i,
						});
					}
					const qs = parseJsonParameter.call(
						this,
						this.getNodeParameter('qsJson', i, ''),
						'Query Parameters (JSON)',
						i,
					) as IDataObject | undefined;
					const body = parseJsonParameter.call(
						this,
						this.getNodeParameter('bodyJson', i, ''),
						'Body (JSON)',
						i,
					) as IDataObject | undefined;
					const betas = (this.getNodeParameter('betas', i, '') as string)
						.split(',')
						.map((beta) => beta.trim())
						.filter(Boolean);
					const fullResponse = this.getNodeParameter('fullResponse', i) as boolean;
					responseData = await claudeApiRequest.call(this, method, endpoint, {
						qs,
						body,
						betas,
						returnFullResponse: fullResponse,
					});
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					// Already one of the n8n error classes — re-throw as-is
					const alreadyWrapped = error;
					throw alreadyWrapped;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

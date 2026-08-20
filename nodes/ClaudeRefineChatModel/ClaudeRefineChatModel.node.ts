import type { ChatModelConfig } from '@n8n/ai-node-sdk';
import { supplyModel } from '@n8n/ai-node-sdk';
import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import type { ClaudeChatModelSettings } from './ClaudeChatModel';
import { ClaudeChatModel } from './ClaudeChatModel';
import type { CacheTtl } from '../ClaudeRefine/GenericFunctions';
import { claudeApiRequestAllItems, parseJsonParameter } from '../ClaudeRefine/GenericFunctions';

const CACHE_TTL_OPTIONS = [
	{ name: '1 Hour', value: '1h', description: 'Ephemeral cache with a 1-hour time to live' },
	{ name: '5 Minutes', value: '5m', description: 'Ephemeral cache with a 5-minute time to live' },
	{ name: 'No Caching', value: 'none', description: 'Do not place a cache breakpoint here' },
];

interface ChatModelOptions {
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	thinkingMode?: 'default' | 'adaptive' | 'disabled' | 'budget';
	thinkingBudget?: number;
	thinkingDisplay?: 'default' | 'summarized' | 'omitted';
	effort?: string;
	betas?: string;
	timeout?: number;
	requestOverridesJson?: string;
}

export class ClaudeRefineChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude Refine Chat Model',
		name: 'claudeRefineChatModel',
		icon: {
			light: 'file:../../icons/claude-refine.svg',
			dark: 'file:../../icons/claude-refine.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["model"]}}',
		description:
			'Claude chat model for AI Agents and chains, with block-level prompt caching, extended thinking and effort control',
		defaults: {
			name: 'Claude Refine Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{ url: 'https://github.com/BenNotix/n8n-nodes-claude-refine?tab=readme-ov-file' },
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [{ name: 'claudeRefineApi', required: true }],
		properties: [
			{
				displayName: 'Connect this node to the Chat Model input of an AI Agent, chain or LLM node',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getModels' },
				required: true,
				default: '',
			},
			{
				displayName: 'Prompt Caching',
				name: 'promptCaching',
				type: 'collection',
				placeholder: 'Add Cache Breakpoint',
				default: {},
				description:
					'Prompt caching breakpoints, re-applied on every model call of the agent loop — cached prefixes cost ~10% to read and do not count toward input-token rate limits',
				options: [
					{
						displayName: 'Cache Conversation',
						name: 'conversationTtl',
						type: 'options',
						options: CACHE_TTL_OPTIONS,
						default: '5m',
						description:
							'Place a breakpoint on the last message of every call, so each agent step re-reads the previous steps from cache — the biggest saving for tool-using agents',
					},
					{
						displayName: 'Cache System Prompt',
						name: 'systemTtl',
						type: 'options',
						options: CACHE_TTL_OPTIONS,
						default: '5m',
						description: 'Place a breakpoint after the system prompt of the agent',
					},
					{
						displayName: 'Cache Tool Definitions',
						name: 'toolsTtl',
						type: 'options',
						options: CACHE_TTL_OPTIONS,
						default: '5m',
						description: 'Place a breakpoint after the last tool definition bound by the agent',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Anthropic Beta Headers',
						name: 'betas',
						type: 'string',
						default: '',
						placeholder: 'e.g. mcp-client-2025-11-20',
						description:
							'Comma-separated anthropic-beta feature flags to send with every request of this model',
					},
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
							'How many tokens Claude may spend thinking and answering — the scale is low, medium, high, xhigh, max. Xhigh needs Opus 4.7+ / Sonnet 5 / Fable 5; Haiku 4.5 does not support effort at all.',
					},
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 4096,
						description: 'Hard cap on generated tokens per model call (thinking + text combined)',
					},
					{
						displayName: 'Request Body Overrides (JSON)',
						name: 'requestOverridesJson',
						type: 'json',
						typeOptions: { rows: 4 },
						default: '',
						description:
							'Object merged into every request body last (top-level keys overwrite) — escape hatch for API features without a dedicated field',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 1,
						description:
							'Randomness of the response, 0–1. Removed on Opus 5 / Opus 4.8 / Opus 4.7 / Sonnet 5 / Fable 5 (sending it there returns a 400).',
					},
					{
						displayName: 'Thinking Budget (Legacy)',
						name: 'thinkingBudget',
						type: 'number',
						typeOptions: { minValue: 1024 },
						default: 1024,
						description:
							'Thinking token budget, only used when Thinking Mode is "Legacy Budget". Claude 4.6 and older models only.',
					},
					{
						displayName: 'Thinking Display',
						name: 'thinkingDisplay',
						type: 'options',
						options: [
							{ name: 'Default', value: 'default' },
							{ name: 'Omitted', value: 'omitted' },
							{ name: 'Summarized', value: 'summarized' },
						],
						default: 'default',
						description: 'Visibility of the thinking blocks in responses (adaptive mode only)',
					},
					{
						displayName: 'Thinking Mode',
						name: 'thinkingMode',
						type: 'options',
						options: [
							{
								name: 'Adaptive',
								value: 'adaptive',
								description: 'Claude decides when and how much to think (Claude 4.6+ models)',
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
								description: 'Turn thinking off — rejected by Fable 5',
							},
							{
								name: 'Legacy Budget',
								value: 'budget',
								description: 'Fixed thinking token budget — Claude 4.6 and older models only',
							},
						],
						default: 'default',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1000 },
						default: 300000,
						description: 'Maximum time to wait for each model call',
					},
					{
						displayName: 'Top K',
						name: 'topK',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 40,
						description:
							'Sample only from the top K options per token — same model restrictions as Temperature',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 3 },
						default: 0.999,
						description: 'Nucleus sampling threshold — same model restrictions as Temperature',
					},
				],
			},
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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const modelId = this.getNodeParameter('model', itemIndex) as string;
		const caching = this.getNodeParameter('promptCaching', itemIndex, {}) as {
			systemTtl?: CacheTtl;
			toolsTtl?: CacheTtl;
			conversationTtl?: CacheTtl;
		};
		const options = this.getNodeParameter('options', itemIndex, {}) as ChatModelOptions;

		let thinking: IDataObject | undefined;
		if (options.thinkingMode === 'adaptive') {
			thinking = { type: 'adaptive' };
			if (options.thinkingDisplay !== undefined && options.thinkingDisplay !== 'default') {
				thinking.display = options.thinkingDisplay;
			}
		} else if (options.thinkingMode === 'disabled') {
			thinking = { type: 'disabled' };
		} else if (options.thinkingMode === 'budget') {
			thinking = { type: 'enabled', budget_tokens: options.thinkingBudget ?? 1024 };
		}

		const settings: ClaudeChatModelSettings = {
			maxTokens: options.maxTokens ?? 4096,
			thinking,
			effort:
				options.effort !== undefined && options.effort !== 'default' ? options.effort : undefined,
			systemTtl: caching.systemTtl,
			toolsTtl: caching.toolsTtl,
			conversationTtl: caching.conversationTtl,
			betas: (options.betas ?? '')
				.split(',')
				.map((beta) => beta.trim())
				.filter(Boolean),
			requestOverrides: parseJsonParameter.call(
				this,
				options.requestOverridesJson,
				'Request Body Overrides (JSON)',
				itemIndex,
			) as IDataObject | undefined,
			timeout: options.timeout,
		};

		const defaultConfig: ChatModelConfig = {};
		if (options.temperature !== undefined) {
			defaultConfig.temperature = options.temperature;
		}
		if (options.topP !== undefined) {
			defaultConfig.topP = options.topP;
		}
		if (options.topK !== undefined) {
			defaultConfig.topK = options.topK;
		}

		const chatModel = new ClaudeChatModel(this, modelId, settings, defaultConfig);
		// @n8n/ai-utilities resolves its own n8n-workflow copy, so its
		// ISupplyDataFunctions is nominally (not structurally) different
		return supplyModel(this as unknown as Parameters<typeof supplyModel>[0], chatModel);
	}
}

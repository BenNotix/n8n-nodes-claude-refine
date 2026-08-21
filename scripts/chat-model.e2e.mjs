/**
 * Behavioral tests of the Claude Refine Chat Model sub-node, run against the
 * REAL @n8n/ai-utilities LangChain adapter (the one n8n wraps supplyModel
 * models with) and canned Anthropic API responses.
 *
 * These exist because type-checking and linting cannot catch contract bugs in
 * the SDK -> LangChain conversion — e.g. a tool_use block that stops becoming
 * an AIMessage.tool_calls entry silently breaks every tool-using agent.
 *
 * Run with: npm test (requires a prior npm run build)
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('..', import.meta.url));
const { ClaudeChatModel } = require('./dist/nodes/ClaudeRefineChatModel/ClaudeChatModel.js');
const {
	LangchainChatModelAdapter,
} = require('@n8n/ai-utilities/dist/cjs/adapters/langchain-chat-model.js');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');

let failures = 0;
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ✅ ${label}`);
	} else {
		failures++;
		console.error(`  ❌ ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
	}
}

/** Fake ISupplyDataFunctions: replays canned responses, records request bodies. */
function makeCtx(responses) {
	const requests = [];
	return {
		requests,
		getNode: () => ({ name: 'test', type: 'claudeRefineChatModel', typeVersion: 1 }),
		getCredentials: async () => ({ apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' }),
		helpers: {
			httpRequestWithAuthentication: async function (_credential, options) {
				requests.push(options);
				const next = responses.shift();
				if (next === undefined) throw new Error('No canned response left');
				return typeof next === 'function' ? next() : next;
			},
		},
	};
}

const SEARCH_TOOL = {
	name: 'search_projects',
	description: 'Search projects',
	schema: {
		type: 'object',
		properties: { query: { type: 'string' } },
		required: ['query'],
		additionalProperties: false,
	},
};

function makeModel(ctx, settings = {}) {
	return new ClaudeChatModel(ctx, 'claude-sonnet-4-6', { maxTokens: 4096, betas: [], ...settings });
}

// ---------------------------------------------------------------------------
console.log('1. generate: text-only response');
{
	const ctx = makeCtx([
		{
			id: 'msg_1',
			content: [{ type: 'text', text: 'PONG' }],
			stop_reason: 'end_turn',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 10, output_tokens: 2 },
		},
	]);
	const adapter = new LangchainChatModelAdapter(makeModel(ctx), undefined);
	const bound = adapter.bindTools([SEARCH_TOOL]);
	const result = await bound.invoke([new HumanMessage('Reply PONG')]);
	check('text is returned', result.text === 'PONG', JSON.stringify(result.text));
	check('no tool calls', (result.tool_calls ?? []).length === 0);
	check(
		'tools were sent to the API',
		Array.isArray(ctx.requests[0].body.tools) && ctx.requests[0].body.tools.length === 1,
	);
}

// ---------------------------------------------------------------------------
console.log('2. generate: tool_use becomes AIMessage.tool_calls (v1.1.0 regression)');
{
	const ctx = makeCtx([
		{
			id: 'msg_2',
			content: [
				{ type: 'thinking', thinking: 'Looking it up.', signature: 'sig_abc' },
				{ type: 'text', text: 'Checking.' },
				{ type: 'tool_use', id: 'toolu_123', name: 'search_projects', input: { query: 'furious' } },
			],
			stop_reason: 'tool_use',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 9078, output_tokens: 100 },
		},
	]);
	const adapter = new LangchainChatModelAdapter(makeModel(ctx), undefined);
	const bound = adapter.bindTools([SEARCH_TOOL]);
	const result = await bound.invoke([new HumanMessage('Find furious projects')]);
	const toolCalls = result.tool_calls ?? [];
	check('exactly one tool call', toolCalls.length === 1, JSON.stringify(toolCalls));
	check('tool name intact', toolCalls[0]?.name === 'search_projects');
	check('tool args parsed', toolCalls[0]?.args?.query === 'furious');
	check('tool call id preserved', toolCalls[0]?.id === 'toolu_123');
	check('text still present', result.text.includes('Checking.'));
}

// ---------------------------------------------------------------------------
console.log('3. generate: parallel tool calls');
{
	const ctx = makeCtx([
		{
			id: 'msg_3',
			content: [
				{ type: 'tool_use', id: 'toolu_a', name: 'search_projects', input: { query: 'a' } },
				{ type: 'tool_use', id: 'toolu_b', name: 'search_projects', input: { query: 'b' } },
			],
			stop_reason: 'tool_use',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 10, output_tokens: 20 },
		},
	]);
	const adapter = new LangchainChatModelAdapter(makeModel(ctx), undefined);
	const result = await adapter.bindTools([SEARCH_TOOL]).invoke([new HumanMessage('both')]);
	check('two tool calls', (result.tool_calls ?? []).length === 2, JSON.stringify(result.tool_calls));
}

// ---------------------------------------------------------------------------
console.log('4. full agent turn: thinking replay + tool_result + caching');
{
	const ctx = makeCtx([
		{
			id: 'msg_4a',
			content: [
				{ type: 'thinking', thinking: 'Need the tool.', signature: 'sig_턴' },
				{ type: 'tool_use', id: 'toolu_x', name: 'search_projects', input: { query: 'q' } },
			],
			stop_reason: 'tool_use',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 100, output_tokens: 50 },
		},
		{
			id: 'msg_4b',
			content: [{ type: 'text', text: 'Done.' }],
			stop_reason: 'end_turn',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 200, output_tokens: 5, cache_read_input_tokens: 90 },
		},
	]);
	const adapter = new LangchainChatModelAdapter(
		makeModel(ctx, { systemTtl: '5m', toolsTtl: '5m', conversationTtl: '5m' }),
		undefined,
	);
	const bound = adapter.bindTools([SEARCH_TOOL]);
	const history = [new HumanMessage('Find q')];
	const first = await bound.invoke(history);
	history.push(first);
	history.push(
		new ToolMessage({ content: '{"hits":3}', tool_call_id: 'toolu_x', name: 'search_projects' }),
	);
	const second = await bound.invoke(history);
	check('final text', second.text === 'Done.');

	const replayBody = ctx.requests[1].body;
	const assistantMessage = replayBody.messages.find((m) => m.role === 'assistant');
	check('assistant turn replayed', assistantMessage !== undefined);
	const blocks = assistantMessage?.content ?? [];
	check(
		'thinking block replayed first, signature intact',
		blocks[0]?.type === 'thinking' && blocks[0]?.signature === 'sig_턴',
		JSON.stringify(blocks[0]),
	);
	const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
	check(
		'tool_use replayed with original id',
		toolUseBlock?.id === 'toolu_x' && toolUseBlock?.input?.query === 'q',
		JSON.stringify(toolUseBlock),
	);
	const toolResultMessage = replayBody.messages.find(
		(m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
	);
	const toolResultBlock = toolResultMessage?.content.find((b) => b.type === 'tool_result');
	check(
		'tool_result sent back with matching id',
		toolResultMessage?.role === 'user' && toolResultBlock?.tool_use_id === 'toolu_x',
		JSON.stringify(toolResultMessage),
	);
	check(
		'tools carry a cache breakpoint',
		replayBody.tools?.[replayBody.tools.length - 1]?.cache_control?.type === 'ephemeral',
	);
	const lastMessage = replayBody.messages[replayBody.messages.length - 1];
	const lastBlock = lastMessage.content[lastMessage.content.length - 1];
	check('conversation cache breakpoint on last block', lastBlock?.cache_control?.type === 'ephemeral');
	check(
		'usage folds cached tokens into promptTokens',
		second.usage_metadata?.input_tokens === 290,
		JSON.stringify(second.usage_metadata),
	);
}

// ---------------------------------------------------------------------------
console.log('5. streaming: text + single tool call');
{
	const sse = (payload) => Buffer.from(`event: x\ndata: ${JSON.stringify(payload)}\n\n`, 'utf8');
	async function* fakeStream() {
		yield sse({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
		yield sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
		yield sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Che' } });
		yield sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cking' } });
		yield sse({ type: 'content_block_stop', index: 0 });
		yield sse({
			type: 'content_block_start',
			index: 1,
			content_block: { type: 'tool_use', id: 'toolu_s', name: 'search_projects', input: {} },
		});
		yield sse({
			type: 'content_block_delta',
			index: 1,
			delta: { type: 'input_json_delta', partial_json: '{"query":' },
		});
		yield sse({
			type: 'content_block_delta',
			index: 1,
			delta: { type: 'input_json_delta', partial_json: '"furious"}' },
		});
		yield sse({ type: 'content_block_stop', index: 1 });
		yield sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } });
		yield sse({ type: 'message_stop' });
	}
	const ctx = makeCtx([() => fakeStream()]);
	const adapter = new LangchainChatModelAdapter(makeModel(ctx), undefined);
	const bound = adapter.bindTools([SEARCH_TOOL]);

	let assembled;
	for await (const chunk of bound._streamResponseChunks([new HumanMessage('go')], {})) {
		assembled = assembled === undefined ? chunk.message : assembled.concat(chunk.message);
	}
	const chunks = assembled?.tool_call_chunks ?? [];
	check('one merged tool_call_chunk', chunks.length === 1, JSON.stringify(chunks));
	check('streamed tool name not duplicated', chunks[0]?.name === 'search_projects', chunks[0]?.name);
	check('streamed id not duplicated', chunks[0]?.id === 'toolu_s', chunks[0]?.id);
	let parsedArgs;
	try {
		parsedArgs = JSON.parse(chunks[0]?.args ?? '');
	} catch {}
	check('streamed args parse to the full input', parsedArgs?.query === 'furious', chunks[0]?.args);
	check('streamed text intact', assembled?.text === 'Checking', assembled?.text);
}

// ---------------------------------------------------------------------------
console.log('5b. streaming: thinking block is rebuilt with its signature for replay');
{
	const sse = (payload) => Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf8');
	async function* fakeStream() {
		yield sse({ type: 'message_start', message: { usage: { input_tokens: 5 } } });
		yield sse({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'thinking', thinking: '', signature: '' },
		});
		yield sse({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'thinking_delta', thinking: 'Deep thought.' },
		});
		yield sse({
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'signature_delta', signature: 'sig_stream' },
		});
		yield sse({ type: 'content_block_stop', index: 0 });
		yield sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
		yield sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } });
		yield sse({ type: 'content_block_stop', index: 1 });
		yield sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
		yield sse({ type: 'message_stop' });
	}
	const ctx = makeCtx([() => fakeStream()]);
	const adapter = new LangchainChatModelAdapter(makeModel(ctx), undefined);
	let assembled;
	for await (const chunk of adapter._streamResponseChunks([new HumanMessage('hi')], {})) {
		assembled = assembled === undefined ? chunk.message : assembled.concat(chunk.message);
	}
	const nonStandard = (assembled?.content ?? []).find?.((b) => b.type === 'non_standard');
	check(
		'streamed thinking rebuilt as replayable block with full signature',
		nonStandard?.value?.type === 'thinking' &&
			nonStandard?.value?.thinking === 'Deep thought.' &&
			nonStandard?.value?.signature === 'sig_stream',
		JSON.stringify(nonStandard),
	);
	check('streamed text preserved alongside thinking', assembled?.text === 'Hi', assembled?.text);
}

// ---------------------------------------------------------------------------
console.log('6. generate: pause_turn is resumed transparently');
{
	const ctx = makeCtx([
		{
			id: 'msg_6a',
			content: [
				{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
			],
			stop_reason: 'pause_turn',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		{
			id: 'msg_6b',
			content: [{ type: 'text', text: 'Answer.' }],
			stop_reason: 'end_turn',
			model: 'claude-sonnet-4-6',
			usage: { input_tokens: 20, output_tokens: 7 },
		},
	]);
	const adapter = new LangchainChatModelAdapter(makeModel(ctx), undefined);
	const result = await adapter.invoke([new HumanMessage('search x')]);
	check('two API calls made', ctx.requests.length === 2, String(ctx.requests.length));
	check('paused turn replayed verbatim', ctx.requests[1].body.messages.at(-1)?.role === 'assistant');
	check('final text returned', result.text === 'Answer.');
	check('usage summed across resumes', result.usage_metadata?.input_tokens === 30);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
	console.error(`${failures} check(s) FAILED`);
	process.exit(1);
}
console.log('All behavioral checks passed.');

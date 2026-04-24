/**
 * baseAgent.ts — regression guard tests
 *
 * Tests our own deterministic error-handling paths, not LLM decisions:
 *   - 429 rate limit → retry
 *   - DataInspectionFailed → Gemini fallback (successful)
 *   - DataInspectionFailed → Gemini fallback also fails → graceful return
 *   - 502 transient error → retry
 *   - Unknown error → throw
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { runAgentLoop } from './baseAgent.js';
import type { AgentConfig, Message } from './types.js';

// --- Helpers ---

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'test-agent',
    systemPrompt: 'test',
    tools: [],
    executeTool: async () => 'ok',
    model: 'test-model',
    maxToolCalls: 1,
    maxTokens: 100,
    ...overrides,
  };
}

function freshHistory(): Message[] {
  return [{ role: 'user', content: 'hello' }];
}

function makeSuccessResponse(content: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content,
          tool_calls: undefined,
          refusal: null,
        },
        finish_reason: 'stop',
        index: 0,
        logprobs: null,
      },
    ],
    id: 'test-id',
    model: 'test-model',
    object: 'chat.completion' as const,
    created: 0,
  };
}

function makeToolCallResponse(toolName: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
          refusal: null,
        },
        finish_reason: 'tool_calls',
        index: 0,
        logprobs: null,
      },
    ],
    id: 'test-id-tool',
    model: 'test-model',
    object: 'chat.completion' as const,
    created: 0,
  };
}

function makeToolBatchResponse(toolCalls: Array<{ id: string; toolName: string; args: Record<string, unknown> }>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: toolCalls.map(toolCall => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              name: toolCall.toolName,
              arguments: JSON.stringify(toolCall.args),
            },
          })),
          refusal: null,
        },
        finish_reason: 'tool_calls',
        index: 0,
        logprobs: null,
      },
    ],
    id: 'test-id-tool-batch',
    model: 'test-model',
    object: 'chat.completion' as const,
    created: 0,
  };
}

/**
 * Creates a mock OpenAI client that responds according to a sequence of handlers.
 * Each `create()` call invokes the next handler in the sequence.
 */
function makeMockClient(handlers: Array<() => unknown>): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= handlers.length) throw new Error('Unexpected extra API call');
          return handlers[i++]();
        },
      },
    },
  } as unknown as OpenAI;
}

// --- Testler ---

test('normal successful response — returns finalResponse', async () => {
  const client = makeMockClient([
    () => makeSuccessResponse('hello world'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'hello world');
  assert.equal(result.toolCallCount, 0);
});

test('429 rate limit error — returns finalResponse after retry', async () => {
  const client = makeMockClient([
    () => { throw new Error('429 Too Many Requests'); },
    () => makeSuccessResponse('retry successful'),
  ]);

  // _retryDelayMs = 0 → test does not wait 5 seconds
  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'retry successful');
});

test('"rate limit" text in error message — returns finalResponse after retry', async () => {
  const client = makeMockClient([
    () => { throw new Error('OpenRouter: rate limit exceeded'); },
    () => makeSuccessResponse('rate limit retry ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'rate limit retry ok');
});

test('DataInspectionFailed — Gemini fallback successful → returns finalResponse', async () => {
  const client = makeMockClient([
    () => { throw new Error('DataInspectionFailed: Input text may contain inappropriate content'); },
    () => makeSuccessResponse('gemini response'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'gemini response');
});

test('DataInspectionFailed → Gemini also fails → graceful return (no crash)', async () => {
  const client = makeMockClient([
    () => { throw new Error('DataInspectionFailed'); },
    () => { throw new Error('Gemini also rejected'); },
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.ok(
    result.finalResponse.includes('⚠️') || result.finalResponse.includes('content filter'),
    `Expected graceful message, received: "${result.finalResponse}"`,
  );
});

test('"inappropriate content" variant — Gemini fallback successful', async () => {
  const client = makeMockClient([
    () => { throw new Error('Request contains inappropriate content'); },
    () => makeSuccessResponse('fallback ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'fallback ok');
});

test('502 transient error — returns finalResponse after retry', async () => {
  const client = makeMockClient([
    () => { throw new Error('502 Bad Gateway'); },
    () => makeSuccessResponse('502 retry ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, '502 retry ok');
});

test('unknown error — throws', async () => {
  const client = makeMockClient([
    () => { throw new Error('ECONNREFUSED: connection refused'); },
  ]);

  await assert.rejects(
    () => runAgentLoop(freshHistory(), makeConfig(), client, 0),
    /ECONNREFUSED/,
  );
});

test('continuation rebuilds duplicate tool suppression from history', async () => {
  let executeToolCalls = 0;
  const config = makeConfig({
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: 'Searches the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => {
      executeToolCalls++;
      return 'https://example.com/one\nhttps://example.com/two';
    },
    maxToolCalls: 5,
  });

  const firstClient = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target', maxResults: 5 }),
    () => makeSuccessResponse('first pass done'),
  ]);

  const firstHistory = freshHistory();
  const firstResult = await runAgentLoop(firstHistory, config, firstClient, 0);

  assert.equal(firstResult.finalResponse, 'first pass done');
  assert.equal(executeToolCalls, 1);

  const secondClient = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target', maxResults: 5 }),
    () => makeSuccessResponse('second pass done'),
  ]);

  const secondResult = await runAgentLoop(firstHistory, config, secondClient, 0);

  assert.equal(secondResult.finalResponse, 'second pass done');
  assert.equal(executeToolCalls, 1);
  const duplicateToolMessage = secondResult.history?.find(
    message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('[DUPLICATE_CALL]')
  );
  assert.ok(duplicateToolMessage);
});

test('continuation duplicate suppression canonicalizes nested tool arguments', async () => {
  let executeToolCalls = 0;
  const config = makeConfig({
    tools: [
      {
        type: 'function',
        function: {
          name: 'add_custom_node',
          description: 'Adds a custom node',
          parameters: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              properties: { type: 'object' },
            },
            required: ['label', 'properties'],
          },
        },
      },
    ] as any,
    executeTool: async () => {
      executeToolCalls++;
      return 'node created';
    },
    maxToolCalls: 5,
  });

  const firstClient = makeMockClient([
    () => makeToolCallResponse('add_custom_node', { label: 'Profile', properties: { b: '2', a: '1' } }),
    () => makeSuccessResponse('first pass done'),
  ]);

  const firstHistory = freshHistory();
  await runAgentLoop(firstHistory, config, firstClient, 0);

  const secondClient = makeMockClient([
    () => makeToolCallResponse('add_custom_node', { label: 'Profile', properties: { a: '1', b: '2' } }),
    () => makeSuccessResponse('second pass done'),
  ]);

  const secondResult = await runAgentLoop(firstHistory, config, secondClient, 0);

  assert.equal(executeToolCalls, 1);
  const duplicateToolMessage = secondResult.history?.find(
    message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('[DUPLICATE_CALL]')
  );
  assert.ok(duplicateToolMessage);
});

test('stagnation control prompt is appended after the full tool batch', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  for (let index = 0; index < 4; index++) {
    primedHistory.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `primed_call_${index + 1}`,
          type: 'function',
          function: {
            name: 'search_web',
            arguments: JSON.stringify({ query: `seed-${index}` }),
          },
        },
      ],
    } as any);
    primedHistory.push({
      role: 'tool',
      tool_call_id: `primed_call_${index + 1}`,
      content: 'https://example.com/one\nhttps://example.com/two',
    } as any);
  }

  const config = makeConfig({
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: 'Searches the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'web_fetch',
          description: 'Fetches a page',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        },
      },
    ] as any,
    executeTool: async (toolName) => {
      if (toolName === 'search_web') return 'https://example.com/one\nhttps://example.com/two';
      return 'Fetched page body';
    },
    maxToolCalls: 5,
  });

  const client = makeMockClient([
    () => makeToolBatchResponse([
      { id: 'call_1', toolName: 'search_web', args: { query: 'sample target' } },
      { id: 'call_2', toolName: 'web_fetch', args: { url: 'https://example.com/one' } },
    ]),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const builtHistory = result.history ?? [];
  const assistantIndexes = builtHistory
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'assistant' && Boolean((entry.message as any).tool_calls?.length))
    .map(entry => entry.index);
  const assistantIndex = assistantIndexes[assistantIndexes.length - 1];
  const toolIndexes = builtHistory
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.index > assistantIndex && entry.message.role === 'tool')
    .map(entry => entry.index);
  const stagnationIndex = builtHistory.findIndex(
    (message, index) => index > assistantIndex && message.role === 'user' && typeof message.content === 'string' && message.content.includes('STAGNATION DETECTED')
  );

  assert.ok(assistantIndex >= 0);
  assert.equal(toolIndexes.length, 2);
  assert.ok(toolIndexes.every(index => index > assistantIndex));
  assert.ok(stagnationIndex > Math.max(...toolIndexes));
});

test('continuation keeps tools disabled after a TOOL_CALL_DISABLED recovery prompt', async () => {
  let seenToolChoice: 'auto' | 'none' | undefined;
  const client = {
    chat: {
      completions: {
        create: async (request: { tool_choice?: 'auto' | 'none' }) => {
          seenToolChoice = request.tool_choice;
          return makeSuccessResponse('text-only continuation');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop([
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'TOOL_CALL_DISABLED. Respond directly in Markdown text using all the information you have collected. Do not call any tools — write text only.' },
  ], makeConfig({
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: 'Searches the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
  }), client, 0);

  assert.equal(seenToolChoice, 'none');
  assert.equal(result.finalResponse, 'text-only continuation');
});

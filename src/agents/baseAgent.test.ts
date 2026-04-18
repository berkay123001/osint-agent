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

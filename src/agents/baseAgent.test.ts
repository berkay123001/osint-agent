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

function appendCompletedToolCall(
  history: Message[],
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  content: string,
) {
  history.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(args),
        },
      },
    ],
  } as any);
  history.push({
    role: 'tool',
    tool_call_id: id,
    content,
  } as any);
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

test('response-body 502 error object — returns finalResponse after retry', async () => {
  const client = makeMockClient([
    () => ({
      error: {
        message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
        type: 'InternalServerError',
        code: 502,
      },
      id: 'response-body-502',
      model: 'test-model',
      object: 'error',
      created: 0,
    }),
    () => makeSuccessResponse('response body 502 retry ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'response body 502 retry ok');
});

test('response-body 500 internal error — throws instead of fabricating recovery', async () => {
  const client = makeMockClient([
    () => ({
      error: {
        message: 'Internal server error',
        type: 'InternalServerError',
        code: 500,
      },
      id: 'response-body-500',
      model: 'test-model',
      object: 'error',
      created: 0,
    }),
  ]);

  await assert.rejects(
    () => runAgentLoop(freshHistory(), makeConfig(), client, 0),
    /Upstream API error/
  );
});

test('response-body 502 with no tool history — throws instead of synthesizing empty recovery', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-loop',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const client = makeMockClient([
    errorBody,
    errorBody,
    errorBody,
    errorBody,
    () => makeSuccessResponse('fabricated recovery should not be used'),
  ]);

  await assert.rejects(
    () => runAgentLoop(freshHistory(), makeConfig(), client, 0),
    /502\/tokenization error/
  );
});

test('response-body 502 with tool history — synthesizes a truncated recovery report', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const recoveredReport = 'Recovered report from truncated tool history with enough detail to satisfy the recovery guard.';
  const history = freshHistory();
  appendCompletedToolCall(
    history,
    'seed_call_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data with enough context to summarize into a final report.'
  );

  const client = makeMockClient([
    errorBody,
    () => { throw new Error('fallback one failed'); },
    () => { throw new Error('fallback two failed'); },
    () => { throw new Error('fallback three failed'); },
    () => makeSuccessResponse(recoveredReport),
  ]);

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, recoveredReport);
});

test('response-body 502 recovery uses array-form tool content as evidence', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-array-tool-content',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history = freshHistory();
  history.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'seed_call_array_1',
        type: 'function',
        function: {
          name: 'search_web',
          arguments: JSON.stringify({ query: 'sample target' }),
        },
      },
    ],
  } as any);
  history.push({
    role: 'tool',
    tool_call_id: 'seed_call_array_1',
    content: [{ text: 'https://example.com/profile\nCollected research data stored as array-form tool content.' }],
  } as any);

  const client = makeMockClient([
    errorBody,
    () => { throw new Error('fallback one failed'); },
    () => { throw new Error('fallback two failed'); },
    () => { throw new Error('fallback three failed'); },
    () => makeSuccessResponse('Recovered report from array-form tool content with enough detail to pass the acceptance threshold.'),
  ]);

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report from array-form tool content with enough detail to pass the acceptance threshold.');
});

test('response-body 502 with only tool-error history — throws instead of synthesizing from errors', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-error-only',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history = freshHistory();
  appendCompletedToolCall(
    history,
    'seed_call_error_only_1',
    'search_web',
    { query: 'sample target' },
    'Tool error (search_web): request failed'
  );

  const client = makeMockClient([
    errorBody,
    () => { throw new Error('fallback one failed'); },
    () => { throw new Error('fallback two failed'); },
    () => { throw new Error('fallback three failed'); },
  ]);

  await assert.rejects(
    () => runAgentLoop(history, makeConfig(), client, 0),
    /502\/tokenization error/
  );
});

test('response-body 502 recovery keeps the original task constraints in the clean synthesis call', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-constraints',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history: Message[] = [
    { role: 'system', content: 'Only list verified candidates and preserve company/YOE filters.' },
    { role: 'user', content: 'Find 1-4 YOE candidates currently working at Example Labs.' },
  ];
  appendCompletedToolCall(
    history,
    'seed_call_constraints_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data with matching company and timeline evidence.'
  );

  let recoveryRequest: { messages?: Array<{ role: string; content?: string | null }> } | undefined;
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages?: Array<{ role: string; content?: string | null }> }) => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          recoveryRequest = request;
          return makeSuccessResponse('Recovered report with preserved constraints and evidence rules.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report with preserved constraints and evidence rules.');
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /Tool: search_web/);
  assert.match(String(recoveryRequest?.messages?.[0]?.content), /Only list verified candidates/);
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /Find 1-4 YOE candidates currently working at Example Labs\./);
});

test('response-body 502 recovery uses the last external user task instead of later control prompts', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-control-prompt',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history: Message[] = [
    { role: 'system', content: 'Preserve the original task.' },
    { role: 'user', content: 'Investigate Jane Doe at Example Labs.' },
    { role: 'user', content: 'TOOL_CALL_DISABLED FAILED. Stop calling tools and summarize the collected data directly in Markdown text. Do not call any tools — not save_finding, not generate_report, NOTHING. Write plain text only.' },
  ];
  appendCompletedToolCall(
    history,
    'seed_call_control_prompt_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data tied to the original investigation target.'
  );

  let recoveryRequest: { messages?: Array<{ role: string; content?: string | null }> } | undefined;
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages?: Array<{ role: string; content?: string | null }> }) => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          recoveryRequest = request;
          return makeSuccessResponse('Recovered report for the original user task with enough detail to pass the recovery acceptance threshold.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report for the original user task with enough detail to pass the recovery acceptance threshold.');
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /Investigate Jane Doe at Example Labs\./);
  assert.doesNotMatch(String(recoveryRequest?.messages?.[1]?.content), /TOOL_CALL_DISABLED FAILED/);
});

test('response-body 502 recovery ignores later tool-diversity control prompts', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-diversity-prompt',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history: Message[] = [
    { role: 'system', content: 'Preserve the original task.' },
    { role: 'user', content: 'Investigate Jane Doe at Example Labs.' },
    { role: 'user', content: '⚠️ TOOL DIVERSITY REQUIREMENT: You have made 4 search calls but used ZERO verification/deep-dive tools. Before making any more searches, you MUST call at least one verification tool.' },
  ];
  appendCompletedToolCall(
    history,
    'seed_call_diversity_prompt_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data tied to the original investigation target.'
  );

  let recoveryRequest: { messages?: Array<{ role: string; content?: string | null }> } | undefined;
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages?: Array<{ role: string; content?: string | null }> }) => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          recoveryRequest = request;
          return makeSuccessResponse('Recovered report for the original investigation task with enough detail to pass the acceptance threshold.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report for the original investigation task with enough detail to pass the acceptance threshold.');
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /Investigate Jane Doe at Example Labs\./);
  assert.doesNotMatch(String(recoveryRequest?.messages?.[1]?.content), /TOOL DIVERSITY REQUIREMENT/);
});

test('response-body 502 recovery ignores later forced-text control prompts', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-forced-text-prompt',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history: Message[] = [
    { role: 'system', content: 'Preserve the original task.' },
    { role: 'user', content: 'Investigate Jane Doe at Example Labs.' },
    { role: 'user', content: 'Stop calling tools. Summarize ALL the information you have collected above as PLAIN TEXT ONLY. Use Markdown headings and lists. Do NOT use <think> tags — write only the final answer.' },
  ];
  appendCompletedToolCall(
    history,
    'seed_call_forced_text_prompt_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data tied to the original investigation target.'
  );

  let recoveryRequest: { messages?: Array<{ role: string; content?: string | null }> } | undefined;
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages?: Array<{ role: string; content?: string | null }> }) => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          recoveryRequest = request;
          return makeSuccessResponse('Recovered report for the original investigation task with enough detail to pass the acceptance threshold.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report for the original investigation task with enough detail to pass the acceptance threshold.');
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /Investigate Jane Doe at Example Labs\./);
  assert.doesNotMatch(String(recoveryRequest?.messages?.[1]?.content), /Stop calling tools\./);
});

test('response-body 502 recovery ignores later strategy-review control prompts', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-strategy-review',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history: Message[] = [
    { role: 'system', content: 'Preserve the original task.' },
    { role: 'user', content: 'Investigate Jane Doe at Example Labs.' },
    { role: 'user', content: '[STRATEGY REVIEW — Correction Required]\nFocus on stronger evidence and preserve limitations.' },
  ];
  appendCompletedToolCall(
    history,
    'seed_call_strategy_review_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data tied to the original investigation target.'
  );

  let recoveryRequest: { messages?: Array<{ role: string; content?: string | null }> } | undefined;
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages?: Array<{ role: string; content?: string | null }> }) => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          recoveryRequest = request;
          return makeSuccessResponse('Recovered report for the original investigation task with enough detail to pass the acceptance threshold.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report for the original investigation task with enough detail to pass the acceptance threshold.');
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /Investigate Jane Doe at Example Labs\./);
  assert.doesNotMatch(String(recoveryRequest?.messages?.[1]?.content), /STRATEGY REVIEW/);
});

test('response-body 502 recovery keeps JSON-prefixed real user tasks', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-json-task',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history: Message[] = [
    { role: 'system', content: 'Preserve the original task.' },
    { role: 'user', content: 'JSON summary of the collected OSINT evidence.' },
  ];
  appendCompletedToolCall(
    history,
    'seed_call_json_task_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data tied to the original investigation target.'
  );

  let recoveryRequest: { messages?: Array<{ role: string; content?: string | null }> } | undefined;
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages?: Array<{ role: string; content?: string | null }> }) => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          recoveryRequest = request;
          return makeSuccessResponse('Recovered JSON-oriented report with enough detail to pass the acceptance threshold.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered JSON-oriented report with enough detail to pass the acceptance threshold.');
  assert.match(String(recoveryRequest?.messages?.[1]?.content), /JSON summary of the collected OSINT evidence\./);
});

test('response-body 502 recovery strips think blocks before returning the synthesized report', async () => {
  const errorBody = () => ({
    error: {
      message: 'Internal server error: TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
      type: 'InternalServerError',
      code: 502,
    },
    id: 'response-body-502-recovery-think-block',
    model: 'test-model',
    object: 'error',
    created: 0,
  });

  const history = freshHistory();
  appendCompletedToolCall(
    history,
    'seed_call_think_block_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data with enough context to summarize into a final report.'
  );

  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          if (callCount === 1) return errorBody();
          if (callCount <= 4) throw new Error('fallback failed');
          return makeSuccessResponse('<think>internal reasoning</think>Recovered report after stripping think blocks with enough detail to pass the acceptance threshold.');
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runAgentLoop(history, makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'Recovered report after stripping think blocks with enough detail to pass the acceptance threshold.');
});

test('generic response-body 502 with tool history — throws instead of synthesizing recovery text', async () => {
  const history = freshHistory();
  appendCompletedToolCall(
    history,
    'seed_call_generic_1',
    'search_web',
    { query: 'sample target' },
    'https://example.com/profile\nCollected research data that should not mask a generic upstream failure.'
  );

  const client = makeMockClient([
    () => ({
      error: {
        message: 'Internal server error',
        type: 'InternalServerError',
        code: 502,
      },
      id: 'response-body-generic-502',
      model: 'test-model',
      object: 'error',
      created: 0,
    }),
  ]);

  await assert.rejects(
    () => runAgentLoop(history, makeConfig(), client, 0),
    /Upstream API error/
  );
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
    appendCompletedToolCall(
      primedHistory,
      `primed_call_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two'
    );
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

test('tool diversity prompt fires on the fourth consecutive search when verification tools exist', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'cross_reference',
          description: 'Cross references collected evidence',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 5,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
  assert.match(String(diversityMessage?.content), /4 search calls/);
});

test('tool diversity prompt stays silent after verification work has already happened', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
  }
  appendCompletedToolCall(
    primedHistory,
    'verification_seed_1',
    'cross_reference',
    { query: 'sample target' },
    'Çapraz doğrulama sonuçları (“sample target” için doğrulanmış tanımlayıcılar):\n- Email: sample@example.com\n- Bağlı handle: sampletarget'
  );

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
          name: 'cross_reference',
          description: 'Cross references collected evidence',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 5,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.equal(diversityMessage, undefined);
});

test('tool diversity prompt stays silent after a localized successful claim verification', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
  }
  appendCompletedToolCall(
    primedHistory,
    'localized_verify_claim_seed',
    'verify_claim',
    { query: 'sample target' },
    '✅ İDDİA DOĞRULAMA — Güven: ORTA\nİddia: "Örnek iddia"\nKontrol edilen kaynaklar: https://example.com\n\nDestekleyen kanıtlar:\n  1. Örnek kanıt'
  );

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
          name: 'verify_claim',
          description: 'Verifies a claim',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.equal(diversityMessage, undefined);
});

test('tool diversity prompt stays silent when the same batch already includes verification work', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'cross_reference',
          description: 'Cross references collected evidence',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async (toolName) => toolName === 'cross_reference'
      ? 'Verified match through independent evidence'
      : 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolBatchResponse([
      { id: 'call_1', toolName: 'search_web', args: { query: 'sample target' } },
      { id: 'call_2', toolName: 'cross_reference', args: { query: 'sample target' } },
    ]),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.equal(diversityMessage, undefined);
});

test('tool diversity prompt still fires when same-batch verification work fails', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'cross_reference',
          description: 'Cross references collected evidence',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async (toolName) => {
      if (toolName === 'cross_reference') {
        throw new Error('verification failed');
      }
      return 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three';
    },
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolBatchResponse([
      { id: 'call_1', toolName: 'search_web', args: { query: 'sample target' } },
      { id: 'call_2', toolName: 'cross_reference', args: { query: 'sample target' } },
    ]),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
});

test('tool diversity prompt still fires after a failed earlier verification attempt', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'failed_verification_seed',
    'cross_reference',
    { query: 'sample target' },
    'Tool error (cross_reference): verification failed'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'cross_reference',
          description: 'Cross references collected evidence',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
});

test('tool diversity prompt still fires after a plain-text infrastructure verification failure', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'infra_verification_seed',
    'cross_reference',
    { query: 'sample target' },
    'Neo4j bağlantısı kurulamadı.'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'cross_reference',
          description: 'Cross references collected evidence',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
});

test('tool diversity prompt still fires after a no-result verification attempt', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'empty_verification_seed',
    'verify_profiles',
    { query: 'sample target' },
    'No profiles found to verify.'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'verify_profiles',
          description: 'Verifies collected profiles',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
});

test('tool diversity prompt still fires after a zero-verified Turkish profile summary', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'turkish_zero_verified_seed',
    'verify_profiles',
    { query: 'sample target' },
    'Sonuç: 0 doğrulandı, 2 doğrulanmadı, 0 atlandı'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'verify_profiles',
          description: 'Verifies collected profiles',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
});

test('tool diversity prompt still fires after a blocked profile verification attempt', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'blocked_verification_seed',
    'scrape_profile',
    { query: 'sample target' },
    'Sign in to continue. Create an account to view this profile.'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'scrape_profile',
          description: 'Scrapes a profile',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
});

test('tool diversity prompt stays silent after a deep-dive web fetch already happened', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'deep_dive_seed',
    'web_fetch',
    { url: 'https://example.com/profile' },
    'Page content for https://example.com/profile:\nDetailed biography and corroborating profile evidence.'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          description: 'Fetches web content',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.equal(diversityMessage, undefined);
});

test('tool diversity prompt still fires after a localized inconclusive verification result', async () => {
  const primedHistory: Message[] = [{ role: 'user', content: 'hello' }];
  appendCompletedToolCall(
    primedHistory,
    'localized_verification_seed',
    'verify_claim',
    { query: 'sample target' },
    'YETERSİZ KANIT: Bu iddia doğrulanamadı.'
  );
  for (let index = 0; index < 3; index++) {
    appendCompletedToolCall(
      primedHistory,
      `search_seed_${index + 1}`,
      'search_web',
      { query: `seed-${index}` },
      'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three'
    );
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
          name: 'verify_claim',
          description: 'Verifies a claim',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ] as any,
    executeTool: async () => 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/three',
    maxToolCalls: 6,
  });

  const client = makeMockClient([
    () => makeToolCallResponse('search_web', { query: 'sample target' }),
    () => makeSuccessResponse('done'),
  ]);

  const result = await runAgentLoop(primedHistory, config, client, 0);
  const diversityMessage = result.history?.find(
    message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('TOOL DIVERSITY REQUIREMENT')
  );

  assert.ok(diversityMessage);
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

/**
 * baseAgent.ts — regression guard testleri
 *
 * Agent'ın LLM kararlarını değil, bizim yazdığımız deterministik
 * error-handling pathlerini test eder:
 *   - 429 rate limit → retry
 *   - DataInspectionFailed → Gemini fallback (başarılı)
 *   - DataInspectionFailed → Gemini fallback da başarısız → graceful return
 *   - 502 geçici hata → retry
 *   - Bilinmeyen hata → throw
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { runAgentLoop } from './baseAgent.js';
import type { AgentConfig, Message } from './types.js';

// --- Yardımcılar ---

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
  return [{ role: 'user', content: 'merhaba' }];
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
 * Çağrılar dizisine göre davranan sahte OpenAI client'ı oluşturur.
 * Her `create()` çağrısında sıradaki handler çalışır.
 */
function makeMockClient(handlers: Array<() => unknown>): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= handlers.length) throw new Error('Beklenmedik ekstra API çağrısı');
          return handlers[i++]();
        },
      },
    },
  } as unknown as OpenAI;
}

// --- Testler ---

test('normal başarılı yanıt — finalResponse döner', async () => {
  const client = makeMockClient([
    () => makeSuccessResponse('merhaba dünya'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'merhaba dünya');
  assert.equal(result.toolCallCount, 0);
});

test('429 rate limit hatası — retry sonrası finalResponse döner', async () => {
  const client = makeMockClient([
    () => { throw new Error('429 Too Many Requests'); },
    () => makeSuccessResponse('retry başarılı'),
  ]);

  // _retryDelayMs = 0 → test 5 saniye beklemez
  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'retry başarılı');
});

test('"rate limit" metni içeren hata — retry sonrası finalResponse döner', async () => {
  const client = makeMockClient([
    () => { throw new Error('OpenRouter: rate limit exceeded'); },
    () => makeSuccessResponse('rate limit retry ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'rate limit retry ok');
});

test('DataInspectionFailed — Gemini fallback başarılı → finalResponse döner', async () => {
  const client = makeMockClient([
    () => { throw new Error('DataInspectionFailed: Input text may contain inappropriate content'); },
    () => makeSuccessResponse('gemini yanıtı'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'gemini yanıtı');
});

test('DataInspectionFailed → Gemini da başarısız → graceful return (crash yok)', async () => {
  const client = makeMockClient([
    () => { throw new Error('DataInspectionFailed'); },
    () => { throw new Error('Gemini da reddetti'); },
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.ok(
    result.finalResponse.includes('⚠️') || result.finalResponse.includes('içerik filtresi'),
    `Beklenen graceful mesaj, alınan: "${result.finalResponse}"`,
  );
});

test('"inappropriate content" variant — Gemini fallback başarılı', async () => {
  const client = makeMockClient([
    () => { throw new Error('Request contains inappropriate content'); },
    () => makeSuccessResponse('fallback ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, 'fallback ok');
});

test('502 geçici hata — retry sonrası finalResponse döner', async () => {
  const client = makeMockClient([
    () => { throw new Error('502 Bad Gateway'); },
    () => makeSuccessResponse('502 retry ok'),
  ]);

  const result = await runAgentLoop(freshHistory(), makeConfig(), client, 0);

  assert.equal(result.finalResponse, '502 retry ok');
});

test('bilinmeyen hata — throw edilir', async () => {
  const client = makeMockClient([
    () => { throw new Error('ECONNREFUSED: connection refused'); },
  ]);

  await assert.rejects(
    () => runAgentLoop(freshHistory(), makeConfig(), client, 0),
    /ECONNREFUSED/,
  );
});

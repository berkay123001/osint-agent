import assert from 'node:assert/strict'
import test from 'node:test'

import { buildLLMTelemetryEvent, estimateMessageChars, formatLLMTelemetryLine } from './llmTelemetry.js'

test('estimateMessageChars counts content arrays and tool calls', () => {
  const chars = estimateMessageChars([
    { role: 'user', content: 'hello world' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'structured output' }],
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    },
  ])

  assert.ok(chars > 'hello world'.length)
})

test('buildLLMTelemetryEvent normalizes usage, context, and cost fields', () => {
  const event = buildLLMTelemetryEvent({
    agent: 'Supervisor',
    phase: 'initial',
    reason: 'initial',
    attempt: 1,
    requestedModel: 'minimax/minimax-m2.7',
    status: 'success',
    latencyMs: 842,
    messages: [
      { role: 'system', content: 'You are a test system prompt.' },
      { role: 'user', content: 'Investigate this account.' },
    ],
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      input_tokens_details: { cached_tokens: 150 },
      output_tokens_details: { reasoning_tokens: 45 },
    },
  })

  assert.equal(event.promptTokens, 1200)
  assert.equal(event.completionTokens, 300)
  assert.equal(event.totalTokens, 1500)
  assert.equal(event.cachedPromptTokens, 150)
  assert.equal(event.reasoningTokens, 45)
  assert.equal(event.contextLimit, 196608)
  assert.equal(event.contextPct, 0.6)
  assert.equal(event.costEstimated, true)
  assert.ok(event.totalCostUsd)
  assert.equal(event.actualModel, 'minimax/minimax-m2.7')
})

test('formatLLMTelemetryLine includes model, tokens, context, and cost', () => {
  const event = buildLLMTelemetryEvent({
    agent: 'IdentityAgent',
    reason: 'tool retry',
    attempt: 2,
    requestedModel: 'minimax/minimax-m2.7',
    status: 'error',
    latencyMs: 1550,
    messages: [{ role: 'user', content: 'lookup example' }],
    usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 },
    errorMessage: 'provider timeout',
  })

  const line = formatLLMTelemetryLine(event)

  assert.ok(line.includes('[IdentityAgent]'))
  assert.ok(line.includes('model=minimax/minimax-m2.7'))
  assert.ok(line.includes('prompt=900'))
  assert.ok(line.includes('ctx='))
  assert.ok(line.includes('cost='))
  assert.ok(line.includes('error=provider timeout'))
})
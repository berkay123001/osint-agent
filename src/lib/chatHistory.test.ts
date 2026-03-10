import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAssistantMessage, normalizeToolContent, sanitizeHistoryForProvider } from './chatHistory.js'

test('normalizeAssistantMessage replaces null final content with a fallback', () => {
  const normalized = normalizeAssistantMessage({
    role: 'assistant',
    content: null,
    tool_calls: undefined,
    refusal: null,
  } as any)

  assert.equal(normalized.role, 'assistant')
  assert.equal(normalized.content, 'Araçlar çalıştı ancak model boş yanıt döndürdü.')
})

test('normalizeAssistantMessage preserves refusal text', () => {
  const normalized = normalizeAssistantMessage({
    role: 'assistant',
    content: null,
    tool_calls: undefined,
    refusal: 'unsafe request',
  } as any)

  assert.equal(normalized.role, 'assistant')
  assert.equal(normalized.content, 'unsafe request')
})

test('sanitizeHistoryForProvider converts assistant tool-call content null to empty string', () => {
  const repaired = sanitizeHistoryForProvider([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'run_github_osint',
            arguments: '{"username":"Sadelimon"}',
          },
        },
      ],
    } as any,
  ])

  assert.equal(repaired[0]?.role, 'assistant')
  assert.equal((repaired[0] as any).content, '')
})

test('normalizeToolContent prevents empty tool messages', () => {
  assert.equal(normalizeToolContent('   '), 'Tool sonuç üretemedi.')
})
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../agents/types.js'
import { STRATEGY_REVIEW_FINAL_REPORT_HEADER } from '../agents/reviewContinuation.js'
import { buildToolCacheKey, rebuildAgentSession } from './agentSession.js'

test('rebuildAgentSession extracts durable runtime from prior tool history', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Investigate the sample target.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"sample target"}',
          },
        },
      ],
    } as any,
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'https://example.com/a\nhttps://example.com/b\nhttps://example.com/c',
    } as any,
    {
      role: 'user',
      content: '⚠️ STAGNATION DETECTED: Your recent searches are returning no new information. STOP searching immediately.',
    },
  ]

  const session = rebuildAgentSession('AcademicAgent', history)
  const cacheKey = buildToolCacheKey('search_web', { query: 'sample target' })

  assert.equal(session.agentName, 'AcademicAgent')
  assert.equal(session.workingMemory.objective, 'Investigate the sample target.')
  assert.equal(session.runtime.toolCallCount, 1)
  assert.equal(session.runtime.toolsUsed.search_web, 1)
  assert.ok(session.runtime.duplicateToolCache[cacheKey]?.includes('example.com'))
  assert.equal(session.runtime.seenUrls.length, 3)
  assert.ok(session.workingMemory.nextActions.some(action => action.includes('STOP searching immediately')))
  assert.ok(session.episodes.some(episode => episode.toolCalls.some(call => call.toolName === 'search_web')))
})

test('rebuildAgentSession ignores forced text-recovery prompts as external user intent', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Investigate sample_handle.' },
    { role: 'user', content: 'Do not call any tools. Present all collected data directly as text.' },
  ]

  const session = rebuildAgentSession('IdentityAgent', history)

  assert.equal(session.workingMemory.objective, 'Investigate sample_handle.')
  assert.equal(session.workingMemory.latestExternalUserMessage, 'Investigate sample_handle.')
  assert.ok(session.workingMemory.nextActions.some(action => action.includes('Do not call any tools')))
})

test('rebuildAgentSession treats strategy final-report prompts as internal control messages', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Find exactly 3 peer-reviewed papers.' },
    {
      role: 'user',
      content: `${STRATEGY_REVIEW_FINAL_REPORT_HEADER}\n\nWrite the corrected final Markdown report now.`,
    },
  ]

  const session = rebuildAgentSession('AcademicAgent', history)

  assert.equal(session.workingMemory.objective, 'Find exactly 3 peer-reviewed papers.')
  assert.equal(session.workingMemory.latestExternalUserMessage, 'Find exactly 3 peer-reviewed papers.')
  assert.equal(session.workingMemory.phase, 'revision')
  assert.ok(session.workingMemory.nextActions.some(action => action.includes('STRATEGY REVIEW — Final Report Required')))
})

test('rebuildAgentSession preserves later tool results when control prompts split a tool batch', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Investigate sample target.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"sample target"}',
          },
        },
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'web_fetch',
            arguments: '{"url":"https://example.com/report"}',
          },
        },
      ],
    } as any,
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'https://example.com/a\nhttps://example.com/b',
    } as any,
    {
      role: 'user',
      content: '⚠️ STAGNATION DETECTED: Your recent searches are returning no new information. STOP searching immediately.',
    },
    {
      role: 'tool',
      tool_call_id: 'call_2',
      content: 'Fetched report body from https://example.com/report',
    } as any,
  ]

  const session = rebuildAgentSession('AcademicAgent', history)

  assert.equal(session.runtime.toolCallCount, 2)
  assert.equal(session.runtime.toolsUsed.search_web, 1)
  assert.equal(session.runtime.toolsUsed.web_fetch, 1)
  assert.ok(session.runtime.seenUrls.includes('https://example.com/report'))
  assert.ok(session.episodes.some(episode => episode.toolCalls.length === 2))
})

test('rebuildAgentSession preserves the original duplicate cache payload across duplicate attempts', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Investigate duplicate search behavior.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"sample target"}',
          },
        },
      ],
    } as any,
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'https://example.com/original-result',
    } as any,
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"sample target"}',
          },
        },
      ],
    } as any,
    {
      role: 'tool',
      tool_call_id: 'call_2',
      content: '[DUPLICATE_CALL] This query was called before.\n\n[cached: https://example.com/original-result...]',
    } as any,
  ]

  const session = rebuildAgentSession('IdentityAgent', history)
  const cacheKey = buildToolCacheKey('search_web', { query: 'sample target' })

  assert.equal(session.runtime.toolCallCount, 2)
  assert.equal(session.runtime.seenUrls.length, 1)
  assert.ok(session.runtime.duplicateToolCache[cacheKey].includes('https://example.com/original-result'))
  assert.ok(!session.runtime.duplicateToolCache[cacheKey].startsWith('[DUPLICATE_CALL]'))
})

test('rebuildAgentSession keeps null-valued arguments in duplicate cache keys', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Investigate null-bearing arguments.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"sample target","cursor":null}',
          },
        },
      ],
    } as any,
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'https://example.com/with-null-args',
    } as any,
  ]

  const session = rebuildAgentSession('IdentityAgent', history)
  const cacheKey = buildToolCacheKey('search_web', { query: 'sample target', cursor: null })

  assert.ok(session.runtime.duplicateToolCache[cacheKey].includes('https://example.com/with-null-args'))
})

test('rebuildAgentSession uses full tool history content instead of provider-truncated previews', () => {
  const longPrefix = 'Result line. '.repeat(320)
  const history: Message[] = [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Investigate long search results.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"long results"}',
          },
        },
      ],
    } as any,
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: `${longPrefix} https://example.com/a https://example.com/b https://example.com/c`,
    } as any,
  ]

  const session = rebuildAgentSession('AcademicAgent', history)

  assert.equal(session.runtime.seenUrls.length, 3)
  assert.equal(session.runtime.lowYieldStreak, 0)
})

test('rebuildAgentSession resets lowYieldStreak after a stagnation control prompt', () => {
  const history: Message[] = [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: 'Investigate stagnation reset.' }]

  for (let index = 0; index < 5; index++) {
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `call_${index + 1}`,
          type: 'function',
          function: {
            name: 'search_web',
            arguments: `{"query":"seed-${index}"}`,
          },
        },
      ],
    } as any)
    history.push({
      role: 'tool',
      tool_call_id: `call_${index + 1}`,
      content: 'https://example.com/one\nhttps://example.com/two',
    } as any)
  }

  history.push({
    role: 'user',
    content: '⚠️ STAGNATION DETECTED: Your recent searches are returning no new information. STOP searching immediately.',
  })

  const session = rebuildAgentSession('AcademicAgent', history)

  assert.equal(session.runtime.lowYieldStreak, 0)
})
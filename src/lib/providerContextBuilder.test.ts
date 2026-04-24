import assert from 'node:assert/strict'
import test from 'node:test'
import { STRATEGY_REVIEW_FINAL_REPORT_HEADER } from '../agents/reviewContinuation.js'
import type { AgentSessionSnapshot, Message } from '../agents/types.js'
import { buildProviderMessages } from './providerContextBuilder.js'

function totalChars(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? JSON.stringify(message.content)
        : ''
    const toolCalls = 'tool_calls' in message && message.tool_calls
      ? JSON.stringify(message.tool_calls)
      : ''
    return sum + content.length + toolCalls.length
  }, 0)
}

test('buildProviderMessages injects durable memory when history exceeds budget', () => {
  const hugeToolOutput = 'Result line. '.repeat(900)
  const history: Message[] = [
    { role: 'system', content: 'You are the AcademicAgent.' },
    { role: 'user', content: 'Find quantitative credibility scores.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_academic_papers',
            arguments: '{"query":"credibility scores"}',
          },
        },
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_1', content: hugeToolOutput } as any,
    { role: 'assistant', content: 'Interim note: still researching.' },
    { role: 'user', content: 'Continue and prioritize numeric ranges.' },
  ]

  const built = buildProviderMessages(history, {
    agentName: 'AcademicAgent',
    modelName: 'minimax/minimax-m2.5',
    budgetOverride: {
      maxPromptChars: 2000,
      maxMemoryChars: 900,
      maxRecentChars: 900,
      maxEpisodePreviewChars: 160,
      maxRecentUnits: 4,
    },
  })

  assert.equal(built.messages[0]?.role, 'system')
  assert.ok(built.messages.some(message => typeof message.content === 'string' && message.content.includes('[DURABLE WORKING MEMORY]')))
  assert.ok(built.messages.some(message => typeof message.content === 'string' && message.content.includes('Find quantitative credibility scores.')))
  assert.ok(totalChars(built.messages) <= 2000)
})

test('buildProviderMessages keeps a recent tool episode intact when it fits', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are the IdentityAgent.' },
    { role: 'user', content: 'Investigate sample_handle.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'run_sherlock',
            arguments: '{"username":"sample_handle"}',
          },
        },
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_1', content: 'Found on GitHub and Reddit.' } as any,
    { role: 'assistant', content: 'I found two likely profiles.' },
  ]

  const built = buildProviderMessages(history, {
    agentName: 'IdentityAgent',
    modelName: 'minimax/minimax-m2.5',
    budgetOverride: {
      maxPromptChars: 8000,
      maxMemoryChars: 800,
      maxRecentChars: 6000,
      maxEpisodePreviewChars: 200,
      maxRecentUnits: 8,
    },
  })

  const assistantToolCall = built.messages.find(message => message.role === 'assistant' && Boolean((message as any).tool_calls?.length))
  const toolResult = built.messages.find(message => message.role === 'tool')

  assert.ok(assistantToolCall)
  assert.ok(toolResult)
  assert.ok(totalChars(built.messages) <= 8000)
})

test('buildProviderMessages keeps split tool batches atomic when control prompts are interleaved', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are the IdentityAgent.' },
    { role: 'user', content: 'Investigate sample_handle.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"sample_handle"}',
          },
        },
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'web_fetch',
            arguments: '{"url":"https://example.com/profile"}',
          },
        },
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_1', content: 'https://example.com/profile' } as any,
    { role: 'user', content: '⚠️ STAGNATION DETECTED: Your recent searches are returning no new information. STOP searching immediately.' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Fetched https://example.com/profile' } as any,
  ]

  const built = buildProviderMessages(history, {
    agentName: 'IdentityAgent',
    modelName: 'minimax/minimax-m2.5',
    budgetOverride: {
      maxPromptChars: 8_000,
      maxMemoryChars: 800,
      maxRecentChars: 6_000,
      maxEpisodePreviewChars: 200,
      maxRecentUnits: 1,
    },
  })

  const assistantIndex = built.messages.findIndex(message => message.role === 'assistant' && Boolean((message as any).tool_calls?.length))
  const toolIndexes = built.messages
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'tool')
    .map(entry => entry.index)
  const controlIndex = built.messages.findIndex((message, index) => index > assistantIndex && message.role === 'user' && typeof message.content === 'string' && message.content.includes('STAGNATION DETECTED'))

  assert.ok(assistantIndex >= 0)
  assert.equal(toolIndexes.length, 2)
  assert.ok(toolIndexes.every(index => index > assistantIndex))
  assert.ok(controlIndex === -1 || toolIndexes.every(index => index < controlIndex))
  assert.ok(totalChars(built.messages) <= 8_000)
})

test('buildProviderMessages keeps the newest oversized user turn', () => {
  const hugeFollowUp = 'Need the latest turn preserved. '.repeat(300)
  const history: Message[] = [
    { role: 'system', content: 'You are the AcademicAgent.' },
    { role: 'user', content: 'Older small user turn.' },
    { role: 'user', content: hugeFollowUp },
  ]

  const built = buildProviderMessages(history, {
    agentName: 'AcademicAgent',
    modelName: 'minimax/minimax-m2.5',
    budgetOverride: {
      maxPromptChars: 1400,
      maxMemoryChars: 200,
      maxRecentChars: 900,
      maxEpisodePreviewChars: 120,
      maxRecentUnits: 2,
    },
  })

  assert.ok(built.messages.some(message => typeof message.content === 'string' && message.content.includes('Need the latest turn preserved.')))
  assert.ok(totalChars(built.messages) <= 1400)
})

test('buildProviderMessages never exceeds budget when system prompt leaves almost no room', () => {
  const history: Message[] = [
    { role: 'system', content: 'S'.repeat(89_950) },
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
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_1', content: 'https://example.com/a\nhttps://example.com/b' } as any,
  ]

  const built = buildProviderMessages(history, {
    agentName: 'AcademicAgent',
    modelName: 'qwen/qwen3.6-plus',
    budgetOverride: {
      maxPromptChars: 90_000,
      maxMemoryChars: 900,
      maxRecentChars: 4_000,
      maxEpisodePreviewChars: 160,
      maxRecentUnits: 4,
    },
  })

  assert.ok(totalChars(built.messages) <= 90_000)
})

test('buildProviderMessages trims an oversized system prefix to stay within budget', () => {
  const built = buildProviderMessages([
    { role: 'system', content: 'S'.repeat(1_400) },
  ], {
    agentName: 'AcademicAgent',
    modelName: 'qwen/qwen3.6-plus',
    budgetOverride: {
      maxPromptChars: 1_000,
      maxMemoryChars: 200,
      maxRecentChars: 400,
      maxEpisodePreviewChars: 120,
      maxRecentUnits: 2,
    },
  })

  assert.ok(totalChars(built.messages) <= 1_000)
})

test('buildProviderMessages does not re-add a standalone internal control prompt when the latest unit is omitted', () => {
  const hugeToolOutput = 'Result line. '.repeat(900)
  const built = buildProviderMessages([
    { role: 'system', content: 'You are the AcademicAgent.' },
    { role: 'user', content: 'Find quantitative credibility scores.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search_academic_papers',
            arguments: '{"query":"credibility scores"}',
          },
        },
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_1', content: hugeToolOutput } as any,
    { role: 'user', content: 'TOOL_CALL_DISABLED. Respond directly in Markdown text using all the information you have collected.' },
  ], {
    agentName: 'AcademicAgent',
    modelName: 'qwen/qwen3.6-plus',
    budgetOverride: {
      maxPromptChars: 1_200,
      maxMemoryChars: 300,
      maxRecentChars: 250,
      maxEpisodePreviewChars: 120,
      maxRecentUnits: 1,
    },
  })

  assert.ok(!built.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('TOOL_CALL_DISABLED.')))
  assert.ok(totalChars(built.messages) <= 1_200)
})

test('buildProviderMessages recalculates body budget after shrinking an oversized durable-memory prefix', () => {
  const session: AgentSessionSnapshot = {
    schemaVersion: 1,
    agentName: 'AcademicAgent',
    workingMemory: {
      objective: 'Find quantitative credibility scores.',
      latestExternalUserMessage: 'Latest user must survive.',
      latestAssistantSummary: 'Summary. '.repeat(80),
      phase: 'research',
      nextActions: ['Action one '.repeat(20), 'Action two '.repeat(20)],
    },
    runtime: {
      toolCallCount: 4,
      toolsUsed: { search_academic_papers: 4 },
      perToolCount: { search_academic_papers: 4 },
      duplicateToolCache: {},
      seenUrls: ['https://example.com/a'],
      lowYieldStreak: 0,
      toolsDisabled: false,
    },
    episodes: [
      {
        id: 'episode-1',
        startIndex: 0,
        endIndex: 0,
        headline: 'search_academic_papers',
        toolCalls: [
          {
            toolName: 'search_academic_papers',
            argsHash: 'hash-1',
            argsPreview: 'query="credibility scores"',
            resultPreview: 'Preview '.repeat(40),
            yieldedNewUrls: 3,
          },
        ],
      },
    ],
    processedMessageCount: 2,
    updatedAt: new Date().toISOString(),
  }

  const history: Message[] = [
    { role: 'system', content: 'S'.repeat(520) },
    { role: 'user', content: 'Older user turn.' },
    { role: 'user', content: 'Latest user must survive.' },
  ]

  const built = buildProviderMessages(history, {
    agentName: 'AcademicAgent',
    modelName: 'qwen/qwen3.6-plus',
    session,
    budgetOverride: {
      maxPromptChars: 1_200,
      maxMemoryChars: 800,
      maxRecentChars: 500,
      maxEpisodePreviewChars: 160,
      maxRecentUnits: 2,
    },
  })

  assert.ok(built.messages.some(message => typeof message.content === 'string' && message.content.includes('Latest user must survive.')))
  assert.ok(totalChars(built.messages) <= 1_200)
})

test('buildProviderMessages keeps strategy final-report prompts in guardrails, not as the latest external user request', () => {
  const history: Message[] = [
    { role: 'system', content: 'You are the AcademicAgent.' },
    { role: 'user', content: 'Find exactly 3 peer-reviewed papers.' },
    {
      role: 'user',
      content: `${STRATEGY_REVIEW_FINAL_REPORT_HEADER}\n\nWrite the corrected final Markdown report now.`,
    },
  ]

  const built = buildProviderMessages(history, {
    agentName: 'AcademicAgent',
    modelName: 'minimax/minimax-m2.5',
    budgetOverride: {
      maxPromptChars: 2_000,
      maxMemoryChars: 900,
      maxRecentChars: 900,
      maxEpisodePreviewChars: 160,
      maxRecentUnits: 4,
    },
  })

  const durableMemory = built.messages.find(
    (message) => typeof message.content === 'string' && message.content.includes('[DURABLE WORKING MEMORY]'),
  )

  assert.ok(durableMemory)
  assert.match(String(durableMemory?.content), /Latest user request: Find exactly 3 peer-reviewed papers\./)
  assert.match(String(durableMemory?.content), /STRATEGY REVIEW — Final Report Required/)
  assert.doesNotMatch(String(durableMemory?.content), /Latest user request: \[STRATEGY REVIEW — Final Report Required\]/)
})
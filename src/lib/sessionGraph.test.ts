import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../agents/types.js'
import {
  buildSessionGraph,
  extractToolInvocations,
  pairDetailEventsToInvocations,
  type SessionGraphReplayEvent,
} from './sessionGraph.js'

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      },
    ],
  } as any
}

test('extractToolInvocations preserves tool order and parsed arguments', () => {
  const history: Message[] = [
    { role: 'user', content: 'Investigate octocat' },
    assistantToolCall('call_1', 'run_github_osint', { username: 'octocat' }),
    { role: 'tool', tool_call_id: 'call_1', content: 'github output' } as any,
    assistantToolCall('call_2', 'parse_gpg_key', { username: 'octocat' }),
    { role: 'tool', tool_call_id: 'call_2', content: 'gpg output' } as any,
  ]

  const invocations = extractToolInvocations(history)

  assert.equal(invocations.length, 2)
  assert.equal(invocations[0]?.toolName, 'run_github_osint')
  assert.equal(invocations[0]?.occurrence, 0)
  assert.equal(invocations[0]?.args.username, 'octocat')
  assert.equal(invocations[1]?.toolName, 'parse_gpg_key')
  assert.equal(invocations[1]?.occurrence, 0)
})

test('pairDetailEventsToInvocations matches repeated tool names by occurrence order', () => {
  const history: Message[] = [
    { role: 'user', content: 'Find recent papers' },
    assistantToolCall('call_1', 'search_web', { query: 'paper a' }),
    { role: 'tool', tool_call_id: 'call_1', content: 'result a' } as any,
    assistantToolCall('call_2', 'search_web', { query: 'paper b' }),
    { role: 'tool', tool_call_id: 'call_2', content: 'result b' } as any,
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    { type: 'progress', msg: '🔧 search_web(query=paper a)', ts: '10:00:00' },
    { type: 'detail', toolName: 'search_web', output: 'detail result for A' },
    { type: 'telemetry', msg: '📈 model=qwen', ts: '10:00:01' },
    { type: 'detail', toolName: 'search_web', output: 'detail result for B' },
  ]

  const paired = pairDetailEventsToInvocations(extractToolInvocations(history), replayEvents)

  assert.equal(paired.length, 2)
  assert.equal(paired[0]?.args.query, 'paper a')
  assert.equal(paired[0]?.output, 'detail result for A')
  assert.equal(paired[1]?.args.query, 'paper b')
  assert.equal(paired[1]?.output, 'detail result for B')
})

test('pairDetailEventsToInvocations prefers toolCallId over occurrence order when available', () => {
  const history: Message[] = [
    { role: 'user', content: 'Find recent papers' },
    assistantToolCall('call_a', 'search_web', { query: 'paper a' }),
    { role: 'tool', tool_call_id: 'call_a', content: 'result a' } as any,
    assistantToolCall('call_b', 'search_web', { query: 'paper b' }),
    { role: 'tool', tool_call_id: 'call_b', content: 'result b' } as any,
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    { type: 'detail', toolName: 'search_web', toolCallId: 'call_b', output: 'detail result for B' },
    { type: 'detail', toolName: 'search_web', toolCallId: 'call_a', output: 'detail result for A' },
  ]

  const paired = pairDetailEventsToInvocations(extractToolInvocations(history), replayEvents)

  assert.equal(paired[0]?.args.query, 'paper a')
  assert.equal(paired[0]?.output, 'detail result for A')
  assert.equal(paired[1]?.args.query, 'paper b')
  assert.equal(paired[1]?.output, 'detail result for B')
})

test('buildSessionGraph creates session-local identity graph from GitHub OSINT output', () => {
  const history: Message[] = [
    { role: 'user', content: 'Investigate octocat on GitHub' },
    assistantToolCall('call_1', 'run_github_osint', { username: 'octocat' }),
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' } as any,
    { role: 'assistant', content: '# Findings\n\nOctocat appears linked to a GitHub identity.' },
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    { type: 'progress', msg: '🕵️ IdentityAgent → "Investigate octocat on GitHub"', ts: '10:00:00' },
    {
      type: 'detail',
      toolName: 'run_github_osint',
      output: [
        '=== GitHub OSINT: octocat ===',
        'Name: The Octocat',
        'Company: GitHub',
        'Location: San Francisco',
        'Email (profile): octocat@github.com',
        'Bio: mascot',
        'Blog: https://github.blog',
        'Twitter: octocat',
        'Followers: 10 | Following: 20',
        'Public repos: 8',
        'Created: 2011-01-25',
        'Emails found in commits: octocat@github.com, commit@example.com',
        'GPG key: https://github.com/octocat.gpg',
        'SSH keys: none',
      ].join('\n'),
    },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents })

  assert.ok(graph.nodes.some(node => node.kind === 'session' && node.label === 'Current Session'))
  assert.ok(graph.nodes.some(node => node.kind === 'agent' && node.label === 'Identity'))
  assert.ok(graph.nodes.some(node => node.kind === 'tool' && node.label === 'GitHub OSINT'))
  assert.ok(graph.nodes.some(node => node.subtype === 'username' && node.label === 'octocat'))
  assert.ok(graph.nodes.some(node => node.subtype === 'email' && node.label === 'octocat@github.com'))
  assert.ok(graph.nodes.some(node => node.subtype === 'person' && node.label === 'The Octocat'))
  assert.ok(graph.nodes.some(node => node.subtype === 'location' && node.label === 'San Francisco'))
  assert.ok(graph.edges.some(edge => edge.relation === 'USES_EMAIL'))
  assert.ok(graph.edges.some(edge => edge.relation === 'POSSIBLE_REAL_NAME'))
})

test('buildSessionGraph deduplicates repeated evidence from GitHub and GPG outputs', () => {
  const history: Message[] = [
    { role: 'user', content: 'Investigate octocat' },
    assistantToolCall('call_1', 'run_github_osint', { username: 'octocat' }),
    { role: 'tool', tool_call_id: 'call_1', content: 'github output' } as any,
    assistantToolCall('call_2', 'parse_gpg_key', { username: 'octocat' }),
    { role: 'tool', tool_call_id: 'call_2', content: 'gpg output' } as any,
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    {
      type: 'detail',
      toolName: 'run_github_osint',
      output: [
        '=== GitHub OSINT: octocat ===',
        'Name: The Octocat',
        'Email (profile): octocat@github.com',
        'Emails found in commits: octocat@github.com',
      ].join('\n'),
    },
    {
      type: 'detail',
      toolName: 'parse_gpg_key',
      output: [
        '=== GPG Key Analizi: octocat ===',
        '',
        '📧 Bulunan email adresleri:',
        '  - octocat@github.com',
        '',
        '👤 Bulunan isimler:',
        '  - The Octocat',
      ].join('\n'),
    },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents })
  const octocatEmailNodes = graph.nodes.filter(node => node.subtype === 'email' && node.label === 'octocat@github.com')
  const octocatNameNodes = graph.nodes.filter(node => node.subtype === 'person' && node.label === 'The Octocat')

  assert.equal(octocatEmailNodes.length, 1)
  assert.equal(octocatNameNodes.length, 1)
  assert.ok(graph.edges.some(edge => edge.relation === 'USES_EMAIL' && edge.weight >= 2))
})

test('buildSessionGraph prefers full tool outputs from history over truncated replay details', () => {
  const fullOutput = [
    '=== GitHub OSINT: octocat ===',
    'Name: The Octocat',
    'Email (profile): octocat@github.com',
    'Emails found in commits: commit@example.com',
  ].join('\n')
  const history: Message[] = [
    { role: 'user', content: 'Investigate octocat' },
    assistantToolCall('call_1', 'run_github_osint', { username: 'octocat' }),
    { role: 'tool', tool_call_id: 'call_1', content: fullOutput } as any,
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    { type: 'detail', toolName: 'run_github_osint', toolCallId: 'call_1', output: '=== GitHub OSINT: octocat ===' },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents })

  assert.ok(graph.nodes.some(node => node.subtype === 'email' && node.label === 'octocat@github.com'))
  assert.ok(graph.nodes.some(node => node.subtype === 'email' && node.label === 'commit@example.com'))
  assert.ok(graph.nodes.some(node => node.subtype === 'person' && node.label === 'The Octocat'))
})

test('buildSessionGraph consumes replay-only delegated sub-agent detail events', () => {
  const history: Message[] = [
    { role: 'user', content: 'Investigate octocat on GitHub' },
    assistantToolCall('call_delegate', 'ask_identity_agent', { query: 'Investigate octocat on GitHub' }),
    { role: 'tool', tool_call_id: 'call_delegate', content: '# Identity summary' } as any,
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    { type: 'progress', msg: '🕵️ IdentityAgent → "Investigate octocat on GitHub"', ts: '10:00:00' },
    {
      type: 'detail',
      toolName: 'run_github_osint',
      toolCallId: 'call_sub_1',
      output: [
        '=== GitHub OSINT: octocat ===',
        'Name: The Octocat',
        'Email (profile): octocat@github.com',
      ].join('\n'),
    },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents })

  assert.ok(graph.nodes.some(node => node.kind === 'tool' && node.label === 'GitHub OSINT'))
  assert.ok(graph.nodes.some(node => node.subtype === 'username' && node.label === 'octocat'))
  assert.ok(graph.nodes.some(node => node.subtype === 'email' && node.label === 'octocat@github.com'))
})

test('buildSessionGraph keeps distinct non-ASCII query nodes separate', () => {
  const history: Message[] = [
    { role: 'user', content: '调查 张伟 的 GitHub 资料' },
    { role: 'user', content: '研究 李雷 的学术论文' },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents: [] })
  const queryNodes = graph.nodes.filter(node => node.kind === 'query')

  assert.equal(queryNodes.length, 2)
  assert.notEqual(queryNodes[0]?.id, queryNodes[1]?.id)
})

test('buildSessionGraph parses email registration platforms and ignores obfuscated recovery values', () => {
  const history: Message[] = [
    { role: 'user', content: 'Check registrations for octocat@github.com' },
    assistantToolCall('call_1', 'check_email_registrations', { email: 'octocat@github.com' }),
    { role: 'tool', tool_call_id: 'call_1', content: 'holehe output' } as any,
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    {
      type: 'detail',
      toolName: 'check_email_registrations',
      output: [
        '📧 Email Registration Check: octocat@github.com',
        'Platforms scanned: 120 | Registered on: 2',
        '',
        '[+] GitHub',
        '[+] Spotify (recovery: o***@g***.com)',
      ].join('\n'),
    },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents })

  assert.ok(graph.nodes.some(node => node.subtype === 'email' && node.label === 'octocat@github.com'))
  assert.ok(graph.nodes.some(node => node.subtype === 'platform' && node.label === 'GitHub'))
  assert.ok(graph.nodes.some(node => node.subtype === 'platform' && node.label === 'Spotify'))
  assert.ok(!graph.nodes.some(node => node.label === 'o***@g***.com'))
  assert.ok(graph.edges.some(edge => edge.relation === 'REGISTERED_ON'))
})

test('buildSessionGraph creates source nodes from generic search results for academic sessions', () => {
  const history: Message[] = [
    { role: 'user', content: 'Research ReAct papers from 2023 to 2025' },
    assistantToolCall('call_1', 'search_web', { query: 'ReAct papers 2023 2025' }),
    { role: 'tool', tool_call_id: 'call_1', content: 'search output' } as any,
    { role: 'assistant', content: '# ReAct Papers\n\n## Recent sources\n\n- arXiv\n- OpenReview' },
  ]
  const replayEvents: SessionGraphReplayEvent[] = [
    { type: 'progress', msg: '📚 AcademicAgent → "Research ReAct papers"', ts: '10:00:00' },
    {
      type: 'detail',
      toolName: 'search_web',
      output: [
        '1. ReAct: Synergizing Reasoning and Acting in Language Models',
        '   https://openreview.net/forum?id=WE_vluYUL-X',
        '2. Reflexion paper entry',
        '   https://arxiv.org/abs/2303.11366',
      ].join('\n'),
    },
  ]

  const graph = buildSessionGraph({ sessionId: 'session-1', history, replayEvents })

  assert.ok(graph.nodes.some(node => node.kind === 'agent' && node.label === 'Academic'))
  assert.ok(graph.nodes.some(node => node.subtype === 'domain' && node.label === 'openreview.net'))
  assert.ok(graph.nodes.some(node => node.subtype === 'domain' && node.label === 'arxiv.org'))
  assert.ok(graph.nodes.some(node => node.kind === 'topic' && node.label === 'ReAct Papers'))
})
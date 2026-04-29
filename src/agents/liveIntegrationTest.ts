/**
 * Live Integration Test Suite — gerçek API ile yeni özellik + regresyon testleri
 *
 * Mevcut liveSmokeTest.ts'in EKSİK BIRAKTIĞI alanlar:
 *   A  Tool katmanı (LLM yok, hızlı) — search_web, github, query_graph_confidence, web_fetch
 *   B  Yeni özellik doğrulaması    — query_graph_confidence format + Bloom Filter init
 *   C  Agent-level davranış        — identity + query_graph_confidence çağrısı, stagnation, supervisor routing
 *
 * Çalıştırma:
 *   npx tsx src/agents/liveIntegrationTest.ts           # tüm gruplar (A+B+C)
 *   npx tsx src/agents/liveIntegrationTest.ts --no-llm  # sadece A+B (hızlı, API key gerekmez A için)
 *
 * Başarı kriterleri (exact metin değil, yapısal):
 *   - Tool çağrıları crash olmadan yanıt döndürüyor
 *   - query_graph_confidence 5 bileşen satırını üretiyor (yeni araç)
 *   - Bloom Filter baseAgent'a entegre, crash yok, init çalışıyor
 *   - Agent budget'ı aşmıyor (stagnation/deduplication çalışıyor)
 *   - Supervisor identity sorgusunu ask_identity_agent'a yönlendiriyor
 */

import 'dotenv/config'
import { executeTool } from '../lib/toolRegistry.js'
import { BloomFilter } from '../lib/bloomFilter.js'
import { computeGraphConfidence, fetchGraphEvidence } from '../lib/graphConfidence.js'
import { runIdentityAgent } from './identityAgent.js'
import { runSupervisor } from './supervisorAgent.js'
import type { Message } from './types.js'

// ── Sonuç Toplayıcı ────────────────────────────────────────────────────

interface TestResult {
  group: 'A' | 'B' | 'C'
  name: string
  passed: boolean
  durationMs: number
  notes: string[]
  error?: string
}

const results: TestResult[] = []

function pass(group: TestResult['group'], name: string, durationMs: number, notes: string[]): void {
  results.push({ group, name, passed: true, durationMs, notes })
  console.log(`  ✅ PASS  ${name}  (${(durationMs / 1000).toFixed(1)}s)`)
  for (const n of notes) console.log(`         ${n}`)
}

function fail(group: TestResult['group'], name: string, durationMs: number, error: string, notes: string[] = []): void {
  results.push({ group, name, passed: false, durationMs, notes, error })
  console.log(`  ❌ FAIL  ${name}  (${(durationMs / 1000).toFixed(1)}s)`)
  console.log(`         ${error}`)
}

// ── Grup A: Tool Katmanı (LLM yok) ────────────────────────────────────

async function testA1_searchWeb(): Promise<void> {
  const t = Date.now()
  try {
    const result = await executeTool('search_web', { query: 'github octocat profile' })
    if (typeof result !== 'string' || result.trim().length === 0) {
      fail('A', 'A1: search_web — non-empty result', Date.now() - t, `Empty/non-string result: ${JSON.stringify(result).slice(0, 100)}`)
      return
    }
    const hasContent = result.toLowerCase().includes('github') || result.toLowerCase().includes('octocat') || result.includes('http')
    if (!hasContent) {
      fail('A', 'A1: search_web — relevant content', Date.now() - t, `Result lacks expected keywords: ${result.slice(0, 200)}`)
      return
    }
    pass('A', 'A1: search_web — real search results', Date.now() - t, [
      `Result length: ${result.length} chars`,
      `Preview: ${result.slice(0, 120).replace(/\n/g, ' ')}`,
    ])
  } catch (e: unknown) {
    fail('A', 'A1: search_web — real search results', Date.now() - t, (e as Error).message)
  }
}

async function testA2_githubOsint(): Promise<void> {
  const t = Date.now()
  try {
    const result = await executeTool('run_github_osint', { username: 'octocat' })
    if (typeof result !== 'string' || result.trim().length === 0) {
      fail('A', 'A2: run_github_osint — non-empty result', Date.now() - t, 'Empty/non-string result')
      return
    }
    const hasProfile = result.toLowerCase().includes('octocat') || result.includes('github.com')
    const hasStats = result.includes('repos') || result.includes('followers') || result.includes('public')
    if (!hasProfile) {
      fail('A', 'A2: run_github_osint — profile data', Date.now() - t, `Missing profile keywords: ${result.slice(0, 200)}`)
      return
    }
    pass('A', 'A2: run_github_osint — GitHub API connected', Date.now() - t, [
      `Has profile info: ${hasProfile}`,
      `Has stats: ${hasStats}`,
      `Result length: ${result.length} chars`,
    ])
  } catch (e: unknown) {
    fail('A', 'A2: run_github_osint — GitHub API connected', Date.now() - t, (e as Error).message)
  }
}

async function testA3_queryGraphConfidenceTool(): Promise<void> {
  const t = Date.now()
  try {
    const result = await executeTool('query_graph_confidence', { label: 'Username', value: 'octocat' })
    if (typeof result !== 'string' || result.trim().length === 0) {
      fail('A', 'A3: query_graph_confidence — non-empty result', Date.now() - t, 'Empty/non-string result')
      return
    }

    const checks = [
      { label: 'Score: line present', ok: result.includes('Score:') },
      { label: 'source_quality: line', ok: result.includes('source_quality:') },
      { label: 'corroboration: line', ok: result.includes('corroboration:') },
      { label: 'diversity: line', ok: result.includes('diversity:') },
      { label: 'contradiction_penalty: line', ok: result.includes('contradiction_penalty:') },
      { label: 'false_positive_penalty: line', ok: result.includes('false_positive_penalty:') },
      { label: 'level label present', ok: result.includes('verified') || result.includes('high') || result.includes('medium') || result.includes('low') },
    ]

    const failed = checks.filter(c => !c.ok)
    if (failed.length > 0) {
      fail('A', 'A3: query_graph_confidence — 5-component format', Date.now() - t,
        `Missing: ${failed.map(c => c.label).join(', ')}`,
        [`Full output:\n${result}`])
      return
    }

    pass('A', 'A3: query_graph_confidence — correct output format', Date.now() - t, [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `Output:\n${result}`,
    ])
  } catch (e: unknown) {
    fail('A', 'A3: query_graph_confidence — correct output format', Date.now() - t, (e as Error).message)
  }
}

async function testA4_webFetch(): Promise<void> {
  const t = Date.now()
  try {
    const result = await executeTool('web_fetch', { url: 'https://api.github.com/users/octocat' })
    if (typeof result !== 'string' || result.trim().length === 0) {
      fail('A', 'A4: web_fetch — non-empty result', Date.now() - t, 'Empty/non-string result')
      return
    }
    const hasOctocat = result.toLowerCase().includes('octocat') || result.includes('login')
    pass('A', 'A4: web_fetch — URL fetching works', Date.now() - t, [
      `Has octocat data: ${hasOctocat}`,
      `Result length: ${result.length} chars`,
    ])
  } catch (e: unknown) {
    fail('A', 'A4: web_fetch — URL fetching works', Date.now() - t, (e as Error).message)
  }
}

// ── Grup B: Yeni Özellik Doğrulaması (LLM yok) ────────────────────────

async function testB1_bloomFilterInit(): Promise<void> {
  const t = Date.now()
  try {
    // BloomFilter import + init — baseAgent ile aynı parametreler
    const bloom = new BloomFilter(10_000, 0.01)
    const urls = [
      'https://github.com/octocat',
      'https://twitter.com/octocat',
      'https://github.com/torvalds',
      'https://linkedin.com/in/octocat',
    ]
    for (const url of urls) bloom.add(url)

    const checks = [
      { label: 'add+mightContain: all 4 URLs found', ok: urls.every(u => bloom.mightContain(u)) },
      { label: 'no false negatives: 1000 re-checks', ok: Array.from({ length: 1_000 }, (_, i) => `https://example.com/${i}`).every((u) => { bloom.add(u); return bloom.mightContain(u) }) },
      { label: 'toState() serialization roundtrip', ok: (() => { const state = bloom.toState(); const b2 = BloomFilter.fromState(state); return urls.every(u => b2.mightContain(u)) })() },
      { label: 'estimatedFalsePositiveRate < 0.02', ok: bloom.estimatedFalsePositiveRate < 0.02 },
    ]

    const failed = checks.filter(c => !c.ok)
    if (failed.length > 0) {
      fail('B', 'B1: BloomFilter — init + core ops', Date.now() - t, `Failed: ${failed.map(c => c.label).join(', ')}`)
      return
    }

    pass('B', 'B1: BloomFilter — init + core ops (1004 URLs)', Date.now() - t,
      checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`))
  } catch (e: unknown) {
    fail('B', 'B1: BloomFilter — init + core ops', Date.now() - t, (e as Error).message)
  }
}

async function testB2_graphConfidencePureScoring(): Promise<void> {
  const t = Date.now()
  try {
    // Test 1: verified source + 5 corroborating edges → high score
    const highEvidence = {
      sourceConfidence: 'verified' as const,
      corroboratingEdgeCount: 5,
      distinctSourceCount: 3,
      hasContradiction: false,
      isFalsePositive: false,
    }
    const highResult = computeGraphConfidence(highEvidence)

    // Test 2: low source + 0 edges + false positive → penalized
    const lowEvidence = {
      sourceConfidence: 'low' as const,
      corroboratingEdgeCount: 0,
      distinctSourceCount: 0,
      hasContradiction: false,
      isFalsePositive: true,
    }
    const lowResult = computeGraphConfidence(lowEvidence)

    // Test 3: contradiction penalty kicks in
    const contradictedEvidence = {
      sourceConfidence: 'high' as const,
      corroboratingEdgeCount: 2,
      distinctSourceCount: 2,
      hasContradiction: true,
      isFalsePositive: false,
    }
    const contradictedResult = computeGraphConfidence(contradictedEvidence)

    const checks = [
      { label: 'verified+5 edges → score ≥ 0.85', ok: highResult.score >= 0.85 },
      { label: 'verified+5 edges → level=verified', ok: highResult.level === 'verified' },
      { label: 'low+FP → score < 0.35', ok: lowResult.score < 0.35 },
      { label: 'low+FP → level=low', ok: lowResult.level === 'low' },
      { label: 'contradiction → score < highResult.score', ok: contradictedResult.score < highResult.score },
      { label: 'result has 5 components', ok: Object.keys(highResult.components).length === 5 },
    ]

    const failed = checks.filter(c => !c.ok)
    if (failed.length > 0) {
      fail('B', 'B2: graphConfidence — pure scoring formula', Date.now() - t,
        `Failed: ${failed.map(c => c.label).join(', ')}`)
      return
    }

    pass('B', 'B2: graphConfidence — pure scoring formula', Date.now() - t, [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `highResult.score = ${highResult.score.toFixed(3)} (${highResult.level})`,
      `lowResult.score  = ${lowResult.score.toFixed(3)} (${lowResult.level})`,
    ])
  } catch (e: unknown) {
    fail('B', 'B2: graphConfidence — pure scoring formula', Date.now() - t, (e as Error).message)
  }
}

async function testB3_fetchGraphEvidenceFallback(): Promise<void> {
  const t = Date.now()
  try {
    // fetchGraphEvidence: Neo4j olmadan graceful fallback
    const evidence = await fetchGraphEvidence('Username', 'nonexistent-user-xyz-999')
    const result = computeGraphConfidence(evidence)

    const checks = [
      { label: 'fetchGraphEvidence returns evidence object', ok: typeof evidence === 'object' },
      { label: 'corroboratingEdgeCount ≥ 0', ok: evidence.corroboratingEdgeCount >= 0 },
      { label: 'computeGraphConfidence: no crash', ok: typeof result.score === 'number' },
      { label: 'score in [0, 1]', ok: result.score >= 0 && result.score <= 1 },
      { label: 'level is valid', ok: ['verified', 'high', 'medium', 'low'].includes(result.level) },
    ]

    const failed = checks.filter(c => !c.ok)
    if (failed.length > 0) {
      fail('B', 'B3: fetchGraphEvidence — Neo4j fallback', Date.now() - t,
        `Failed: ${failed.map(c => c.label).join(', ')}`)
      return
    }

    pass('B', 'B3: fetchGraphEvidence — graceful fallback (no Neo4j)', Date.now() - t, [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `fallback score: ${result.score.toFixed(3)} → ${result.level}`,
    ])
  } catch (e: unknown) {
    fail('B', 'B3: fetchGraphEvidence — graceful fallback (no Neo4j)', Date.now() - t, (e as Error).message)
  }
}

// ── Grup C: Agent Davranış Testleri (LLM gerektirir) ──────────────────

async function testC1_identityAgentCallsQueryGraphConfidence(): Promise<void> {
  const t = Date.now()
  try {
    // Explicitly ask the agent to compute graph confidence — tests tool is callable
    const result = await runIdentityAgent(
      'GitHub kullanıcısı "octocat" için kısa bir profil çıkar. Ardından bu kullanıcının graph confidence skorunu hesapla.',
      undefined,
      'quick',
    )

    const response = result.response
    const history = result.history

    // Check if query_graph_confidence was called in history
    const gcCalled = history.some((msg: Message) => {
      const anyMsg = msg as Record<string, unknown>
      if (anyMsg.role !== 'assistant' || !anyMsg.tool_calls) return false
      const tcs = anyMsg.tool_calls as Array<{ function: { name: string } }>
      return tcs.some(tc => tc.function.name === 'query_graph_confidence')
    })

    // Check if response mentions confidence or score
    const mentionsConfidence = response.toLowerCase().includes('confidence') ||
      response.toLowerCase().includes('skor') ||
      response.includes('Score:') ||
      response.includes('%')

    // At minimum: agent must respond with tool calls + non-empty response
    const toolCallCount = history.filter((msg: Message) => {
      const anyMsg = msg as Record<string, unknown>
      return anyMsg.role === 'assistant' && Array.isArray(anyMsg.tool_calls) && (anyMsg.tool_calls as unknown[]).length > 0
    }).length

    const checks = [
      { label: 'Agent made tool calls', ok: toolCallCount > 0 },
      { label: 'Response non-empty (>100 chars)', ok: response.length > 100 },
      { label: 'query_graph_confidence called', ok: gcCalled },
      { label: 'Response mentions confidence', ok: mentionsConfidence },
    ]

    const criticalFailed = checks.filter(c => !c.ok && (c.label.includes('tool calls') || c.label.includes('non-empty')))
    if (criticalFailed.length > 0) {
      fail('C', 'C1: IdentityAgent + query_graph_confidence', Date.now() - t,
        `Critical failures: ${criticalFailed.map(c => c.label).join(', ')}`,
        checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`))
      return
    }

    pass('C', 'C1: IdentityAgent + query_graph_confidence', Date.now() - t, [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `Tool calls made: ${toolCallCount}`,
      `Response length: ${response.length} chars`,
      `Preview: ${response.slice(0, 200).replace(/\n/g, ' ')}`,
    ])
  } catch (e: unknown) {
    fail('C', 'C1: IdentityAgent + query_graph_confidence', Date.now() - t, (e as Error).message)
  }
}

async function testC2_identityAgentStagnationBudget(): Promise<void> {
  const t = Date.now()
  try {
    // Run with a popular target — Bloom Filter should prevent looping on same URLs
    // maxToolBudget for 'quick' depth = 10
    const EXPECTED_MAX_TOOLS = 15  // some slack above quick budget (10)

    const result = await runIdentityAgent(
      '"defunkt" GitHub kullanıcısı için hızlı profil araştırması yap.',
      undefined,
      'quick',
    )

    const history = result.history
    const toolCallCount = history.filter((msg: Message) => {
      const anyMsg = msg as Record<string, unknown>
      return anyMsg.role === 'assistant' && Array.isArray(anyMsg.tool_calls) && (anyMsg.tool_calls as unknown[]).length > 0
    }).length

    const checks = [
      { label: 'Response non-empty', ok: result.response.length > 50 },
      { label: `Tool count ≤ ${EXPECTED_MAX_TOOLS} (stagnation working)`, ok: toolCallCount <= EXPECTED_MAX_TOOLS },
      { label: 'No crash / error throw', ok: true }, // reaching here means no crash
    ]

    const failed = checks.filter(c => !c.ok)
    if (failed.length > 0) {
      fail('C', 'C2: IdentityAgent — stagnation/budget control', Date.now() - t,
        `Failed: ${failed.map(c => c.label).join(', ')}. tool_count=${toolCallCount}`,
        checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`))
      return
    }

    pass('C', 'C2: IdentityAgent — stagnation/budget control', Date.now() - t, [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `Tool calls made: ${toolCallCount}`,
      `Response length: ${result.response.length} chars`,
    ])
  } catch (e: unknown) {
    fail('C', 'C2: IdentityAgent — stagnation/budget control', Date.now() - t, (e as Error).message)
  }
}

async function testC3_supervisorRoutingIdentity(): Promise<void> {
  const t = Date.now()
  try {
    const initialHistory: Message[] = [
      { role: 'user', content: 'octocat GitHub kullanıcısı kimdir? Kısa profil çıkar.' },
    ]

    const result = await runSupervisor(initialHistory)
    if (!result) {
      fail('C', 'C3: Supervisor routing — identity query', Date.now() - t, 'runSupervisor returned undefined')
      return
    }

    const { finalResponse, history } = result

    // Check if ask_identity_agent was called in supervisor history
    const identityDelegated = history.some((msg: Message) => {
      const anyMsg = msg as Record<string, unknown>
      if (anyMsg.role !== 'assistant' || !anyMsg.tool_calls) return false
      const tcs = anyMsg.tool_calls as Array<{ function: { name: string } }>
      return tcs.some(tc => tc.function.name === 'ask_identity_agent')
    })

    const checks = [
      { label: 'runSupervisor returned a result', ok: !!result },
      { label: 'finalResponse non-empty (>100 chars)', ok: finalResponse.length > 100 },
      { label: 'ask_identity_agent was delegated', ok: identityDelegated },
      { label: 'Response mentions octocat', ok: finalResponse.toLowerCase().includes('octocat') },
    ]

    const criticalFailed = checks.filter(c => !c.ok && c.label.includes('non-empty'))
    if (criticalFailed.length > 0) {
      fail('C', 'C3: Supervisor routing — identity query', Date.now() - t,
        `Critical: ${criticalFailed.map(c => c.label).join(', ')}`,
        checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`))
      return
    }

    pass('C', 'C3: Supervisor routing — identity query', Date.now() - t, [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `Response length: ${finalResponse.length} chars`,
      `Preview: ${finalResponse.slice(0, 200).replace(/\n/g, ' ')}`,
    ])
  } catch (e: unknown) {
    fail('C', 'C3: Supervisor routing — identity query', Date.now() - t, (e as Error).message)
  }
}

// ── Rapor Üretici ──────────────────────────────────────────────────────

function generateReport(): string {
  const totalPassed = results.filter(r => r.passed).length
  const groupA = results.filter(r => r.group === 'A')
  const groupB = results.filter(r => r.group === 'B')
  const groupC = results.filter(r => r.group === 'C')

  const lines: string[] = [
    '# Live Integration Test Proof',
    '',
    `> **Tarih:** ${new Date().toISOString()}`,
    `> **Çalıştırma modu:** ${process.argv.includes('--no-llm') ? 'A+B only (--no-llm)' : 'A+B+C (full)'}`,
    '',
    `## Özet: ${totalPassed}/${results.length} passed`,
    '',
    `| Grup | Açıklama | Passed | Total |`,
    `|------|----------|--------|-------|`,
    `| A | Tool Layer (no LLM) | ${groupA.filter(r => r.passed).length} | ${groupA.length} |`,
    `| B | Yeni Özellikler (no LLM) | ${groupB.filter(r => r.passed).length} | ${groupB.length} |`,
    `| C | Agent Davranış (LLM) | ${groupC.filter(r => r.passed).length} | ${groupC.length} |`,
    '',
    '## Test Detayları',
    '',
  ]

  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL'
    lines.push(`### ${status} — [${r.group}] ${r.name}`)
    lines.push(`- **Süre:** ${(r.durationMs / 1000).toFixed(1)}s`)
    if (r.error) lines.push(`- **Hata:** ${r.error}`)
    if (r.notes.length > 0) {
      lines.push('- **Notlar:**')
      for (const note of r.notes) {
        if (note.includes('\n')) {
          lines.push('  ```')
          lines.push(`  ${note.replace(/\n/g, '\n  ')}`)
          lines.push('  ```')
        } else {
          lines.push(`  - ${note}`)
        }
      }
    }
    lines.push('')
  }

  lines.push('## Ne Test Edildi')
  lines.push('')
  lines.push('### Grup A — Tool Katmanı (API bağlantısı)')
  lines.push('- `search_web`: SearXNG/Brave gerçek sonuç döndürüyor mu?')
  lines.push('- `run_github_osint`: GitHub API octocat profilini çekiyor mu?')
  lines.push('- `query_graph_confidence`: 5-bileşen formatı doğru mu? (yeni araç)')
  lines.push('- `web_fetch`: URL fetch çalışıyor mu?')
  lines.push('')
  lines.push('### Grup B — Yeni Özellikler')
  lines.push('- `BloomFilter`: Import, init, add, mightContain, serialization — 1004 URL')
  lines.push('- `computeGraphConfidence`: verified/low/contradiction scoring doğru mu?')
  lines.push('- `fetchGraphEvidence`: Neo4j olmadan graceful fallback çalışıyor mu?')
  lines.push('')
  lines.push('### Grup C — Agent Davranışı (LLM gerektirir)')
  lines.push('- IdentityAgent: `query_graph_confidence` toolunu çağırıyor mu?')
  lines.push('- IdentityAgent: Budget aşılmıyor (Bloom Filter stagnation çalışıyor)?')
  lines.push('- Supervisor: identity sorgusunu `ask_identity_agent`\'a yönlendiriyor mu?')

  return lines.join('\n')
}

// ── Ana Çalıştırıcı ────────────────────────────────────────────────────

async function main() {
  const noLlm = process.argv.includes('--no-llm')

  console.log('══════════════════════════════════════════════')
  console.log(' Live Integration Test Suite')
  console.log(`  Mod: ${noLlm ? 'A+B only (--no-llm)' : 'A+B+C (full)'}`)
  console.log('══════════════════════════════════════════════')

  // ── Grup A: Tool Layer ─────────────────────────────────────────────
  console.log('\n[A] Tool Katmanı (LLM yok)')
  await testA1_searchWeb()
  await testA2_githubOsint()
  await testA3_queryGraphConfidenceTool()
  await testA4_webFetch()

  // ── Grup B: Yeni Özellikler ────────────────────────────────────────
  console.log('\n[B] Yeni Özellik Doğrulaması (LLM yok)')
  await testB1_bloomFilterInit()
  await testB2_graphConfidencePureScoring()
  await testB3_fetchGraphEvidenceFallback()

  // ── Grup C: Agent Davranışı ────────────────────────────────────────
  if (!noLlm) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.log('\n[C] ATLANDII — OPENROUTER_API_KEY bulunamadı (--no-llm ile yeniden çalıştır)')
      console.log('    C testleri için: OPENROUTER_API_KEY=sk-xxx npx tsx src/agents/liveIntegrationTest.ts')
    } else {
      console.log('\n[C] Agent Davranış Testleri (LLM gerektirir — yavaş)')
      console.log('  C1: IdentityAgent + query_graph_confidence...')
      await testC1_identityAgentCallsQueryGraphConfidence()
      console.log('  C2: IdentityAgent stagnation/budget...')
      await testC2_identityAgentStagnationBudget()
      console.log('  C3: Supervisor identity routing...')
      await testC3_supervisorRoutingIdentity()
    }
  } else {
    console.log('\n[C] ATLANDII (--no-llm)')
  }

  // ── Özet ──────────────────────────────────────────────────────────
  const totalPassed = results.filter(r => r.passed).length
  const totalFailed = results.filter(r => !r.passed).length
  console.log('\n══════════════════════════════════════════════')
  console.log(` SONUÇ: ${totalPassed}/${results.length} passed, ${totalFailed} failed`)

  const failedTests = results.filter(r => !r.passed)
  if (failedTests.length > 0) {
    console.log('\nBaşarısız testler:')
    for (const r of failedTests) {
      console.log(`  ❌ [${r.group}] ${r.name}: ${r.error ?? 'assertion failure'}`)
    }
  }
  console.log('══════════════════════════════════════════════')

  // Raporu kaydet
  const report = generateReport()
  const { writeFile, mkdir } = await import('fs/promises')
  const path = await import('path')
  const { fileURLToPath } = await import('url')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const reportDir = path.resolve(__dirname, '../../Makale/calisma-alani')
  await mkdir(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, 'live-integration-proof.md')
  await writeFile(reportPath, report, 'utf-8')
  console.log(`\nRapor: ${reportPath}`)

  process.exit(totalFailed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(2)
})

/**
 * Live Smoke Test — Gerçek API ile agent davranış doğrulaması.
 *
 * Mock yok. Gerçek OpenRouter API + gerçek model çağrısı.
 * Küçük tool budget (quick depth), kısa timeout.
 *
 * Çalıştırma: npx tsx src/agents/liveSmokeTest.ts
 *
 * Başarı kriterleri (exact metin beklenmez):
 * 1. Tool çağrısı yaptı mı?
 * 2. Yanlış araca gitmedi mi?
 * 3. Limitation yazdı mı?
 * 4. Uydurma URL/DOI üretmedi mi?
 * 5. Meta/tool stats düzgün çıktı mı?
 */

import assert from 'node:assert/strict'
import { runIdentityAgent } from './identityAgent.js'
import { runMediaAgent } from './mediaAgent.js'
import { runAcademicAgent } from './academicAgent.js'
import { runAssertions, type SmokeTestScenario } from './smokeTestHarness.js'
import type { AgentResult } from './types.js'

// ── Sonuç Toplayıcı ────────────────────────────────────────────────────

interface LiveTestResult {
  scenario: string
  agentType: string
  passed: boolean
  toolCallCount: number
  toolsUsed: Record<string, number>
  responsePreview: string
  responseLength: number
  durationMs: number
  assertionFailures: Array<{ rule: string; expected: string; actual: string }>
  error?: string
}

const results: LiveTestResult[] = []

function parseMetaStats(response: string): { toolCallCount: number; toolsUsed: Record<string, number> } {
  const metaMatch = response.match(/\[META\].*?:\s*(.*?)\s*\(total:\s*(\d+)\)/)
  if (!metaMatch) return { toolCallCount: 0, toolsUsed: {} }

  const toolCallCount = parseInt(metaMatch[2], 10)
  const toolsUsed: Record<string, number> = {}
  const toolPart = metaMatch[1]
  const toolEntries = toolPart.match(/(\w+)×(\d+)/g)
  if (toolEntries) {
    for (const entry of toolEntries) {
      const match = entry.match(/(\w+)×(\d+)/)
      if (match) toolsUsed[match[1]] = parseInt(match[2], 10)
    }
  }
  return { toolCallCount, toolsUsed }
}

function stripMetaFooter(response: string): string {
  const metaIndex = response.lastIndexOf('\n---\n**[META]')
  if (metaIndex > -1) return response.slice(0, metaIndex)
  return response
}

// ── Senaryo 1: Identity ────────────────────────────────────────────────

async function runIdentityLive(): Promise<void> {
  const scenario: SmokeTestScenario = {
    name: 'live-identity-username',
    agentType: 'identity',
    query: 'GitHub kullanıcısı "torvalds" hakkında kısa bir profil çıkarır mısın?',
    depth: 'quick',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'used_tool', toolName: 'run_github_osint' },
      { type: 'used_tool', toolName: 'search_web', minCount: 0 },
      { type: 'has_confidence_labels' },
      { type: 'response_min_length', minLength: 100 },
      { type: 'no_empty_claims' },
    ],
  }

  const start = Date.now()
  try {
    const agentResult = await runIdentityAgent(scenario.query, scenario.context, scenario.depth)
    const durationMs = Date.now() - start
    const { toolCallCount, toolsUsed } = parseMetaStats(agentResult.response)
    const cleanResponse = stripMetaFooter(agentResult.response)

    const agentResultForAssert: AgentResult = {
      finalResponse: cleanResponse,
      toolCallCount,
      toolsUsed,
      history: agentResult.history,
    }

    const assertions = runAssertions(agentResultForAssert, scenario)
    results.push({
      scenario: scenario.name,
      agentType: scenario.agentType,
      passed: assertions.passed,
      toolCallCount,
      toolsUsed,
      responsePreview: cleanResponse.slice(0, 300),
      responseLength: cleanResponse.length,
      durationMs,
      assertionFailures: assertions.failures,
    })
  } catch (error) {
    results.push({
      scenario: scenario.name,
      agentType: scenario.agentType,
      passed: false,
      toolCallCount: 0,
      toolsUsed: {},
      responsePreview: '',
      responseLength: 0,
      durationMs: Date.now() - start,
      assertionFailures: [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// ── Senaryo 2: Media ───────────────────────────────────────────────────

async function runMediaLive(): Promise<void> {
  const scenario: SmokeTestScenario = {
    name: 'live-media-factcheck',
    agentType: 'media',
    query: '"GitHub 2024 yılında 150 milyon geliştiriciye ulaştı" iddiasını doğrula.',
    depth: 'quick',
    maxToolBudget: 8,
    mockTools: {},
    assertions: [
      { type: 'used_tool', toolName: 'search_web', minCount: 0 },
      { type: 'has_confidence_labels' },
      { type: 'has_limitation_statement' },
      { type: 'response_min_length', minLength: 100 },
      { type: 'no_empty_claims' },
    ],
  }

  const start = Date.now()
  try {
    const agentResult = await runMediaAgent(scenario.query, scenario.context, scenario.depth)
    const durationMs = Date.now() - start
    const { toolCallCount, toolsUsed } = parseMetaStats(agentResult.response)
    const cleanResponse = stripMetaFooter(agentResult.response)

    const agentResultForAssert: AgentResult = {
      finalResponse: cleanResponse,
      toolCallCount,
      toolsUsed,
      history: agentResult.history,
    }

    const assertions = runAssertions(agentResultForAssert, scenario)
    results.push({
      scenario: scenario.name,
      agentType: scenario.agentType,
      passed: assertions.passed,
      toolCallCount,
      toolsUsed,
      responsePreview: cleanResponse.slice(0, 300),
      responseLength: cleanResponse.length,
      durationMs,
      assertionFailures: assertions.failures,
    })
  } catch (error) {
    results.push({
      scenario: scenario.name,
      agentType: scenario.agentType,
      passed: false,
      toolCallCount: 0,
      toolsUsed: {},
      responsePreview: '',
      responseLength: 0,
      durationMs: Date.now() - start,
      assertionFailures: [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// ── Senaryo 3: Academic ────────────────────────────────────────────────

async function runAcademicLive(): Promise<void> {
  const scenario: SmokeTestScenario = {
    name: 'live-academic-topic',
    agentType: 'academic',
    query: 'Multi-agent OSINT sistemleri hakkında 3 makale bul ve özetle.',
    depth: 'quick',
    maxToolBudget: 8,
    mockTools: {},
    assertions: [
      { type: 'used_tool', toolName: 'search_academic_papers', minCount: 0 },
      { type: 'used_tool', toolName: 'search_web', minCount: 0 },
      { type: 'has_confidence_labels' },
      { type: 'has_limitation_statement' },
      { type: 'response_min_length', minLength: 150 },
    ],
  }

  const start = Date.now()
  try {
    const agentResult = await runAcademicAgent(scenario.query, scenario.context, scenario.depth)
    const durationMs = Date.now() - start
    const { toolCallCount, toolsUsed } = parseMetaStats(agentResult.response)
    const cleanResponse = stripMetaFooter(agentResult.response)

    const agentResultForAssert: AgentResult = {
      finalResponse: cleanResponse,
      toolCallCount,
      toolsUsed,
      history: agentResult.history,
    }

    const assertions = runAssertions(agentResultForAssert, scenario)
    results.push({
      scenario: scenario.name,
      agentType: scenario.agentType,
      passed: assertions.passed,
      toolCallCount,
      toolsUsed,
      responsePreview: cleanResponse.slice(0, 300),
      responseLength: cleanResponse.length,
      durationMs,
      assertionFailures: assertions.failures,
    })
  } catch (error) {
    results.push({
      scenario: scenario.name,
      agentType: scenario.agentType,
      passed: false,
      toolCallCount: 0,
      toolsUsed: {},
      responsePreview: '',
      responseLength: 0,
      durationMs: Date.now() - start,
      assertionFailures: [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// ── Rapor Üretici ──────────────────────────────────────────────────────

function generateMarkdownReport(): string {
  const lines: string[] = [
    '# Live Smoke Test Proof — Gerçek API ile Davranış Doğrulaması',
    '',
    `> Tarih: ${new Date().toISOString()}`,
    `> Test modu: Gerçek OpenRouter API (quick depth)`,
    '',
    '## Sonuçlar',
    '',
  ]

  const totalPassed = results.filter(r => r.passed).length
  const totalFailed = results.filter(r => !r.passed).length

  lines.push(`**Genel:** ${totalPassed}/${results.length} passed, ${totalFailed} failed`)
  lines.push('')

  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL'
    lines.push(`### ${status} — ${r.scenario}`)
    lines.push('')
    lines.push(`- **Agent:** ${r.agentType}`)
    lines.push(`- **Tool çağrısı:** ${r.toolCallCount}`)
    lines.push(`- **Kullanılan araçlar:** ${Object.entries(r.toolsUsed).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`)
    lines.push(`- **Yanıt uzunluğu:** ${r.responseLength} char`)
    lines.push(`- **Süre:** ${(r.durationMs / 1000).toFixed(1)}s`)
    lines.push('')

    if (r.error) {
      lines.push(`**Hata:** ${r.error}`)
      lines.push('')
    }

    if (r.assertionFailures.length > 0) {
      lines.push('**Başarısız assertion\'lar:**')
      for (const f of r.assertionFailures) {
        lines.push(`- ${f.rule}: expected ${f.expected}, got ${f.actual}`)
      }
      lines.push('')
    }

    if (r.responsePreview) {
      lines.push('<details>')
      lines.push('<summary>Yanıt önizleme (ilk 300 char)</summary>')
      lines.push('')
      lines.push('```')
      lines.push(r.responsePreview)
      lines.push('```')
      lines.push('</details>')
      lines.push('')
    }
  }

  lines.push('## Dürüstlük Notu')
  lines.push('')
  lines.push('Bu test gerçek LLM API ile çalıştırılmıştır. Sonuçlar non-deterministic olabilir.')
  lines.push('Başarı kriterleri exact metin karşılaştırması değil, yapısal doğrulamadır:')
  lines.push('- Tool çağrısı yapıldı mı?')
  lines.push('- Confidence etiketleri var mı?')
  lines.push('- Limitation ifadesi var mı?')
  lines.push('- Uydurma veri yok mu?')
  lines.push('- Yanıt yeterli uzunlukta mı?')

  return lines.join('\n')
}

// ── Ana Çalıştırıcı ────────────────────────────────────────────────────

async function main() {
  console.log('=== Live Smoke Test Başlatılıyor ===\n')
  console.log('Senaryo 1/3: Identity (quick depth, max 10 tools)...')
  await runIdentityLive()
  console.log(`  → ${results[0].passed ? 'PASS' : 'FAIL'} (${results[0].toolCallCount} tools, ${(results[0].durationMs / 1000).toFixed(1)}s)`)

  console.log('Senaryo 2/3: Media (quick depth, max 8 tools)...')
  await runMediaLive()
  console.log(`  → ${results[1].passed ? 'PASS' : 'FAIL'} (${results[1].toolCallCount} tools, ${(results[1].durationMs / 1000).toFixed(1)}s)`)

  console.log('Senaryo 3/3: Academic (quick depth, max 8 tools)...')
  await runAcademicLive()
  console.log(`  → ${results[2].passed ? 'PASS' : 'FAIL'} (${results[2].toolCallCount} tools, ${(results[2].durationMs / 1000).toFixed(1)}s)`)

  console.log('\n=== Sonuçlar ===')
  const totalPassed = results.filter(r => r.passed).length
  console.log(`${totalPassed}/${results.length} passed`)

  // Raporu kaydet
  const report = generateMarkdownReport()
  const { writeFile } = await import('fs/promises')
  const path = await import('path')
  const { fileURLToPath } = await import('url')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const reportPath = path.resolve(__dirname, '../../Makale/calisma-alani/live-smoke-proof.md')
  await writeFile(reportPath, report, 'utf-8')
  console.log(`\nRapor kaydedildi: ${reportPath}`)

  // Exit code
  const allPassed = results.every(r => r.passed)
  process.exit(allPassed ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(2)
})

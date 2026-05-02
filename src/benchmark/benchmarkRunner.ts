/**
 * Benchmark Runner
 * Her test case'i sırayla çalıştırır ve metrikleri toplar
 */

import { progressEmitter } from '../lib/progressEmitter.js'
import { getGraphStats, clearGraph } from '../lib/neo4j.js'
import { runIdentityAgent } from '../agents/identityAgent.js'
import { runMediaAgent } from '../agents/mediaAgent.js'
import { runAcademicAgent } from '../agents/academicAgent.js'
import { runSupervisor } from '../agents/supervisorAgent.js'
import { createCollector, type BenchmarkRunResult } from './metricsCollector.js'
import { collectGraphQuality, generateQualityReport } from './graphQualityMetrics.js'
import type { TestCase } from './testCases.js'
import type { LLMTelemetryEvent } from '../lib/llmTelemetry.js'
import type { Message } from '../agents/types.js'

const DELAY_BETWEEN_TESTS_MS = 5_000 // rate limit koruma

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Supervisor history'sinden tool call istatistiklerini çıkar.
 * assistant mesajlarındaki tool_calls dizilerini tarar.
 */
function extractSupervisorToolStats(history: Message[]): { toolCallCount: number; toolsUsed: Record<string, number> } {
  const toolsUsed: Record<string, number> = {}
  let toolCallCount = 0
  for (const msg of history) {
    const assistantMsg = msg as { role: string; tool_calls?: { function: { name: string } }[] }
    if (assistantMsg.role !== 'assistant' || !assistantMsg.tool_calls) continue
    for (const tc of assistantMsg.tool_calls) {
      const name = tc.function.name
      toolsUsed[name] = (toolsUsed[name] ?? 0) + 1
      toolCallCount++
    }
  }
  return { toolCallCount, toolsUsed }
}

function checkExpectedSignals(response: string, signals: string[]): { found: string[]; missed: string[] } {
  const lower = response.toLowerCase()
  const found: string[] = []
  const missed: string[] = []
  for (const sig of signals) {
    if (lower.includes(sig.toLowerCase())) {
      found.push(sig)
    } else {
      missed.push(sig)
    }
  }
  return { found, missed }
}

async function runSingleTestCase(
  tc: TestCase,
  collector: ReturnType<typeof createCollector>,
  clearGraphBeforeRun = false,
): Promise<BenchmarkRunResult> {
  const startedAt = new Date().toISOString()
  const startMs = Date.now()

  // Per-test graph clear — ensures delta measurement is not polluted by previous runs
  // Only active when NEO4J_ALLOW_CLEAR=1 AND caller passes clearGraphBeforeRun=true
  if (clearGraphBeforeRun && process.env.NEO4J_ALLOW_CLEAR === '1') {
    try {
      await clearGraph()
    } catch { /* Neo4j might not be reachable */ }
  }

  // Telemetry listener — capture all LLM calls during this test
  const telEvents: LLMTelemetryEvent[] = []
  const onTelemetry = (e: LLMTelemetryEvent) => telEvents.push(e)
  progressEmitter.on('telemetry', onTelemetry)

  // Graph snapshot before
  let graphBefore = { nodes: 0, relationships: 0 }
  try {
    graphBefore = await getGraphStats()
  } catch { /* Neo4j might not be reachable during tests */ }

  let response = ''
  let error: string | undefined
  let status: BenchmarkRunResult['status'] = 'success'
  let toolCallCount = 0
  let toolsUsed: Record<string, number> = {}

  try {
    switch (tc.agent) {
      case 'identity': {
        const result = await runIdentityAgent(tc.query, tc.context, tc.depth)
        response = result.response
        toolCallCount = result.toolCallCount ?? 0
        toolsUsed = result.toolsUsed ?? {}
        break
      }
      case 'media': {
        const result = await runMediaAgent(tc.query, tc.context, tc.depth)
        response = result.response
        toolCallCount = result.toolCallCount ?? 0
        toolsUsed = result.toolsUsed ?? {}
        break
      }
      case 'academic': {
        const result = await runAcademicAgent(tc.query, tc.context, tc.depth)
        response = result.response
        toolCallCount = result.toolCallCount ?? 0
        toolsUsed = result.toolsUsed ?? {}
        break
      }
      case 'supervisor': {
        const history: Message[] = [{ role: 'user', content: tc.query }]
        const result = await runSupervisor(history)
        response = result?.finalResponse ?? '(no response)'
        // Supervisor tool calls from returned history
        const supervisorStats = extractSupervisorToolStats(result?.history ?? history)
        toolCallCount = supervisorStats.toolCallCount
        toolsUsed = supervisorStats.toolsUsed
        break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    status = 'error'
    response = error
  }

  // Stop capturing telemetry
  progressEmitter.off('telemetry', onTelemetry)

  const durationMs = Date.now() - startMs
  const completedAt = new Date().toISOString()

  // Graph snapshot after
  let graphAfter = { nodes: 0, relationships: 0 }
  try {
    graphAfter = await getGraphStats()
  } catch { /* ignore */ }

  // Token metrics from captured telemetry events
  const tokenMetrics = collector.computeTokenMetrics(telEvents)

  // Signal check
  const signals = checkExpectedSignals(response, tc.expectedSignals ?? [])

  const result: BenchmarkRunResult = {
    testId: tc.id,
    category: tc.category,
    agent: tc.agent,
    depth: tc.depth,
    description: tc.description,
    query: tc.query,

    startedAt,
    completedAt,
    durationMs,

    toolCallCount,
    toolsUsed,
    uniqueToolsUsed: Object.keys(toolsUsed).length,

    promptTokens: tokenMetrics.promptTokens,
    completionTokens: tokenMetrics.completionTokens,
    totalTokens: tokenMetrics.totalTokens,
    cachedTokens: tokenMetrics.cachedTokens,
    contextPct: tokenMetrics.contextPct,
    totalCostUsd: tokenMetrics.totalCostUsd,
    costEstimated: tokenMetrics.costEstimated,

    graphBefore,
    graphAfter,
    graphNodesDelta: graphAfter.nodes - graphBefore.nodes,
    graphRelsDelta: graphAfter.relationships - graphBefore.relationships,

    cacheHitCount: tokenMetrics.cacheHitCount,
    cacheTotalCalls: telEvents.length,

    responseLength: response.length,
    expectedSignalsFound: signals.found,
    expectedSignalsMissed: signals.missed,
    responsePreview: response.slice(0, 500),

    error,
    status,
  }

  // Graph quality — sadece başarılı ve graf değişikliği olan testler için
  if (status === 'success' && result.graphNodesDelta > 0) {
    try {
      result.graphQuality = await collectGraphQuality()
    } catch { /* Neo4j erişilemiyorsa atla */ }
  }

  return result
}

export interface RunnerOptions {
  onProgress?: (msg: string) => void
  onTestStart?: (tc: TestCase, index: number, total: number) => void
  onTestComplete?: (result: BenchmarkRunResult) => void
  /** Her test case öncesi grafı temizle. NEO4J_ALLOW_CLEAR=1 gerektirir. */
  clearGraphBetweenTests?: boolean
}

export async function runBenchmark(
  testCases: TestCase[],
  options: RunnerOptions = {},
): Promise<BenchmarkRunResult[]> {
  const collector = createCollector()
  const results: BenchmarkRunResult[] = []
  const total = testCases.length

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i]

    options.onTestStart?.(tc, i + 1, total)
    options.onProgress?.(`[${i + 1}/${total}] Running ${tc.id}: ${tc.description}`)

    const result = await runSingleTestCase(tc, collector, options.clearGraphBetweenTests ?? false)
    results.push(result)

    await collector.saveRunResult(result)

    const statusIcon = result.status === 'success' ? '✅' : '❌'
    const toolInfo = result.toolCallCount > 0 ? `${result.toolCallCount} tool calls` : 'no tools'
    const timeInfo = `${(result.durationMs / 1000).toFixed(1)}s`
    const tokenInfo = result.totalTokens > 0 ? ` | ${result.totalTokens} tokens` : ''
    const graphInfo = result.graphNodesDelta !== 0
      ? ` | graph +${result.graphNodesDelta}N +${result.graphRelsDelta}R`
      : ''

    options.onTestComplete?.(result)
    options.onProgress?.(`${statusIcon} ${tc.id} [${timeInfo}${tokenInfo}${graphInfo}] — ${toolInfo}`)

    if (result.status === 'error') {
      options.onProgress?.(`   Error: ${result.error?.slice(0, 120)}`)
    }

    // Wait between tests (skip after last)
    if (i < testCases.length - 1) {
      options.onProgress?.(`   Waiting ${DELAY_BETWEEN_TESTS_MS / 1000}s before next test...`)
      await sleep(DELAY_BETWEEN_TESTS_MS)
    }
  }

  await collector.saveSummary(results)

  // Graf kalite raporu — sessionId'si olan testler için
  const qualityResults = results
    .map(r => r.graphQuality)
    .filter((q): q is NonNullable<typeof q> => q !== undefined)
  if (qualityResults.length > 0) {
    try {
      await generateQualityReport(qualityResults)
    } catch { /* dosya yazma hatası benchmark'ı durdurmasın */ }
  }

  return results
}

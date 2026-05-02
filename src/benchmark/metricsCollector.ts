/**
 * Metrics Collector
 * Her benchmark run için JSON dosyası üretir ve özet rapor oluşturur
 */

import { writeFile, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { TestCase } from './testCases.js'
import type { LLMTelemetryEvent } from '../lib/llmTelemetry.js'
import type { GraphQualityResult } from './graphQualityMetrics.js'

export interface GraphSnapshot {
  nodes: number
  relationships: number
}

export interface BenchmarkRunResult {
  testId: string
  category: string
  agent: string
  depth: string
  description: string
  query: string

  // Timing
  startedAt: string
  completedAt: string
  durationMs: number

  // Agent metrics
  toolCallCount: number
  toolsUsed: Record<string, number>
  uniqueToolsUsed: number

  // Token / cost
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  contextPct: number     // % of context window used (max across calls)
  totalCostUsd: number
  costEstimated: boolean

  // Graph impact
  graphBefore: GraphSnapshot
  graphAfter: GraphSnapshot
  graphNodesDelta: number
  graphRelsDelta: number

  // Cache
  cacheHitCount: number   // LLM calls where cachedTokens > 0
  cacheTotalCalls: number // total LLM calls captured

  // Response quality (heuristic)
  responseLength: number
  expectedSignalsFound: string[]
  expectedSignalsMissed: string[]

  // Raw response (first 500 chars)
  responsePreview: string

  // Error (if any)
  error?: string
  status: 'success' | 'error' | 'timeout'

  // Graph quality (post-run Neo4j analysis)
  graphQuality?: GraphQualityResult
}

export interface BenchmarkSummary {
  generatedAt: string
  totalCases: number
  successCount: number
  errorCount: number
  totalDurationMs: number

  // Table IV — Ajan bazlı performans
  agentPerformance: Record<string, {
    runCount: number
    avgDurationMs: number
    avgToolCalls: number
    avgTokens: number
    avgCostUsd: number
    avgContextPct: number
    successRate: number
  }>

  // Table V — Arama zinciri etkinliği
  searchChainEffectiveness: {
    avgUniqueToolsPerRun: number
    mostUsedTools: Array<{ tool: string; totalCalls: number; avgPerRun: number }>
    cacheHitRate: number
  }

  // Table VI — Strateji ajanı etkinliği (cross-domain runs)
  strategyAgentEffectiveness: {
    crossDomainRuns: number
    avgSubAgentDelegations: number   // supervisor → sub-agent calls
    avgGraphNodesDelta: number
    avgGraphRelsDelta: number
  }

  // Table VII — Yanlış pozitif filtreleme
  falsePositiveFiltering: {
    fpRuns: number
    signalHitRate: number   // % test cases where expectedSignals were found
  }

  // All individual results
  runs: BenchmarkRunResult[]
}

const BENCHMARK_DIR = '.osint-sessions/benchmark'

export function createCollector() {
  const events: LLMTelemetryEvent[] = []

  function captureTelemetry(event: LLMTelemetryEvent): void {
    events.push(event)
  }

  function computeTokenMetrics(telEvents: LLMTelemetryEvent[]) {
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    let cachedTokens = 0
    let maxContextPct = 0
    let totalCostUsd = 0
    let costEstimated = false
    let cacheHitCount = 0

    for (const e of telEvents) {
      promptTokens += e.promptTokens ?? 0
      completionTokens += e.completionTokens ?? 0
      totalTokens += e.totalTokens ?? 0
      cachedTokens += e.cachedPromptTokens ?? 0
      if ((e.cachedPromptTokens ?? 0) > 0) cacheHitCount++
      if ((e.contextPct ?? 0) > maxContextPct) maxContextPct = e.contextPct ?? 0
      totalCostUsd += e.totalCostUsd ?? 0
      if (e.costEstimated) costEstimated = true
    }

    return { promptTokens, completionTokens, totalTokens, cachedTokens, contextPct: maxContextPct, totalCostUsd, costEstimated, cacheHitCount }
  }

  async function saveRunResult(result: BenchmarkRunResult): Promise<void> {
    await mkdir(BENCHMARK_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${result.testId}_${ts}.json`
    await writeFile(
      path.join(BENCHMARK_DIR, filename),
      JSON.stringify(result, null, 2),
      'utf8',
    )
  }

  async function saveSummary(results: BenchmarkRunResult[]): Promise<void> {
    await mkdir(BENCHMARK_DIR, { recursive: true })

    const successRuns = results.filter(r => r.status === 'success')

    // Agent-level stats
    const agentPerformance: BenchmarkSummary['agentPerformance'] = {}
    for (const r of results) {
      const a = r.agent
      if (!agentPerformance[a]) {
        agentPerformance[a] = { runCount: 0, avgDurationMs: 0, avgToolCalls: 0, avgTokens: 0, avgCostUsd: 0, avgContextPct: 0, successRate: 0 }
      }
      const ap = agentPerformance[a]
      ap.runCount++
      ap.avgDurationMs += r.durationMs
      ap.avgToolCalls += r.toolCallCount
      ap.avgTokens += r.totalTokens
      ap.avgCostUsd += r.totalCostUsd
      ap.avgContextPct += r.contextPct
      if (r.status === 'success') ap.successRate++
    }
    for (const a of Object.keys(agentPerformance)) {
      const ap = agentPerformance[a]
      const n = ap.runCount
      ap.avgDurationMs = Math.round(ap.avgDurationMs / n)
      ap.avgToolCalls = parseFloat((ap.avgToolCalls / n).toFixed(2))
      ap.avgTokens = Math.round(ap.avgTokens / n)
      ap.avgCostUsd = parseFloat((ap.avgCostUsd / n).toFixed(6))
      ap.avgContextPct = parseFloat((ap.avgContextPct / n).toFixed(1))
      ap.successRate = parseFloat(((ap.successRate / n) * 100).toFixed(1))
    }

    // Search chain
    const toolTotals: Record<string, number> = {}
    let totalUnique = 0
    let totalCacheHits = 0
    let totalCacheCalls = 0
    for (const r of successRuns) {
      totalUnique += r.uniqueToolsUsed
      totalCacheHits += r.cacheHitCount
      totalCacheCalls += r.cacheTotalCalls
      for (const [t, c] of Object.entries(r.toolsUsed)) {
        toolTotals[t] = (toolTotals[t] ?? 0) + c
      }
    }
    const mostUsedTools = Object.entries(toolTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, totalCalls]) => ({
        tool,
        totalCalls,
        avgPerRun: parseFloat((totalCalls / (successRuns.length || 1)).toFixed(2)),
      }))

    // Cross-domain (supervisor) runs
    const cdRuns = successRuns.filter(r => r.category === 'cross-domain')
    const supervisorSubAgentTools = ['ask_identity_agent', 'ask_media_agent', 'ask_academic_agent']
    let totalDelegations = 0
    let totalGraphNodesDelta = 0
    let totalGraphRelsDelta = 0
    for (const r of cdRuns) {
      for (const t of supervisorSubAgentTools) {
        totalDelegations += r.toolsUsed[t] ?? 0
      }
      totalGraphNodesDelta += r.graphNodesDelta
      totalGraphRelsDelta += r.graphRelsDelta
    }

    // False-positive
    const fpRuns = results.filter(r => r.category === 'false-positive')
    const fpHits = fpRuns.filter(r => r.expectedSignalsFound.length > 0).length

    const summary: BenchmarkSummary = {
      generatedAt: new Date().toISOString(),
      totalCases: results.length,
      successCount: successRuns.length,
      errorCount: results.filter(r => r.status === 'error').length,
      totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
      agentPerformance,
      searchChainEffectiveness: {
        avgUniqueToolsPerRun: parseFloat((totalUnique / (successRuns.length || 1)).toFixed(2)),
        mostUsedTools,
        cacheHitRate: parseFloat(((totalCacheHits / (totalCacheCalls || 1)) * 100).toFixed(1)),
      },
      strategyAgentEffectiveness: {
        crossDomainRuns: cdRuns.length,
        avgSubAgentDelegations: parseFloat((totalDelegations / (cdRuns.length || 1)).toFixed(2)),
        avgGraphNodesDelta: parseFloat((totalGraphNodesDelta / (cdRuns.length || 1)).toFixed(2)),
        avgGraphRelsDelta: parseFloat((totalGraphRelsDelta / (cdRuns.length || 1)).toFixed(2)),
      },
      falsePositiveFiltering: {
        fpRuns: fpRuns.length,
        signalHitRate: parseFloat(((fpHits / (fpRuns.length || 1)) * 100).toFixed(1)),
      },
      runs: results,
    }

    await writeFile(
      path.join(BENCHMARK_DIR, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    )
  }

  return { captureTelemetry, computeTokenMetrics, saveRunResult, saveSummary }
}

export type MetricsCollector = ReturnType<typeof createCollector>

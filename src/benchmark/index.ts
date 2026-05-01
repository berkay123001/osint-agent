/**
 * Benchmark CLI Entry Point
 *
 * Usage:
 *   npx tsx src/benchmark/index.ts                      # Tüm senaryoları çalıştır
 *   npx tsx src/benchmark/index.ts --category identity  # Sadece identity testleri
 *   npx tsx src/benchmark/index.ts --id I-1             # Tek bir test
 *   npx tsx src/benchmark/index.ts --list               # Senaryoları listele
 *   npx tsx src/benchmark/index.ts --clean              # Graf veritabanını temizle ve çalıştır
 */

import 'dotenv/config'
import chalk from 'chalk'
import { TEST_CASES, getTestCasesByCategory, getTestCaseById } from './testCases.js'
import { runBenchmark } from './benchmarkRunner.js'
import type { BenchmarkRunResult } from './metricsCollector.js'
import type { TestCase, TestCategory } from './testCases.js'

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getFlag(name: string): boolean {
  return args.includes(name)
}

function getFlagValue(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  return args[idx + 1]
}

const shouldList = getFlag('--list')
const shouldClean = getFlag('--clean')
const categoryFilter = getFlagValue('--category') as TestCategory | undefined
const idFilter = getFlagValue('--id')
const dryRun = getFlag('--dry-run')

// ── List mode ─────────────────────────────────────────────────────────────────

function listTestCases(): void {
  console.log(chalk.bold('\n📋 Benchmark Test Cases\n'))
  const byCategory: Record<string, TestCase[]> = {}
  for (const tc of TEST_CASES) {
    if (!byCategory[tc.category]) byCategory[tc.category] = []
    byCategory[tc.category].push(tc)
  }

  const catColors: Record<string, (s: string) => string> = {
    identity: chalk.cyan,
    media: chalk.magenta,
    academic: chalk.yellow,
    'cross-domain': chalk.blue,
    'false-positive': chalk.red,
  }

  for (const [cat, cases] of Object.entries(byCategory)) {
    const color = catColors[cat] ?? chalk.white
    console.log(color.bold(`[${cat.toUpperCase()}]`))
    for (const tc of cases) {
      console.log(`  ${chalk.bold(tc.id.padEnd(6))} ${chalk.dim(`[${tc.agent}/${tc.depth}]`)} ${tc.description}`)
    }
    console.log()
  }
  console.log(chalk.dim(`Total: ${TEST_CASES.length} test cases\n`))
}

// ── Clean graph ───────────────────────────────────────────────────────────────

async function cleanGraph(): Promise<void> {
  const { clearGraph } = await import('../lib/neo4j.js')
  if (process.env.NEO4J_ALLOW_CLEAR !== '1') {
    console.warn(chalk.yellow('⚠ --clean requires NEO4J_ALLOW_CLEAR=1 in .env'))
    console.warn(chalk.yellow('  Skipping graph clear.'))
    return
  }
  console.log(chalk.yellow('🗑  Clearing Neo4j graph...'))
  await clearGraph()
  console.log(chalk.green('✓ Graph cleared'))
}

// ── Print summary ─────────────────────────────────────────────────────────────

function printSummary(results: BenchmarkRunResult[]): void {
  const success = results.filter(r => r.status === 'success')
  const errors = results.filter(r => r.status === 'error')
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0)
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0)
  const totalCost = results.reduce((s, r) => s + r.totalCostUsd, 0)
  const totalTools = results.reduce((s, r) => s + r.toolCallCount, 0)
  const graphDeltaNodes = results.reduce((s, r) => s + r.graphNodesDelta, 0)
  const graphDeltaRels = results.reduce((s, r) => s + r.graphRelsDelta, 0)

  console.log(chalk.bold('\n════════════════════════════════════════════════════'))
  console.log(chalk.bold(' BENCHMARK RESULTS'))
  console.log(chalk.bold('════════════════════════════════════════════════════'))
  console.log(`  Tests run:      ${results.length}`)
  console.log(`  Success:        ${chalk.green(success.length)}`)
  console.log(`  Errors:         ${errors.length > 0 ? chalk.red(errors.length) : errors.length}`)
  console.log(`  Total time:     ${(totalMs / 1000).toFixed(1)}s`)
  console.log(`  Total tokens:   ${totalTokens.toLocaleString()}`)
  console.log(`  Est. cost:      $${totalCost.toFixed(4)}`)
  console.log(`  Total tools:    ${totalTools}`)
  console.log(`  Graph growth:   +${graphDeltaNodes} nodes, +${graphDeltaRels} relationships`)

  // Per-agent breakdown
  const agentGroups: Record<string, BenchmarkRunResult[]> = {}
  for (const r of results) {
    if (!agentGroups[r.agent]) agentGroups[r.agent] = []
    agentGroups[r.agent].push(r)
  }
  console.log(chalk.bold('\n  Agent Breakdown:'))
  for (const [agent, runs] of Object.entries(agentGroups)) {
    const avgMs = Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length)
    const avgTools = (runs.reduce((s, r) => s + r.toolCallCount, 0) / runs.length).toFixed(1)
    const avgTokens = Math.round(runs.reduce((s, r) => s + r.totalTokens, 0) / runs.length)
    const successes = runs.filter(r => r.status === 'success').length
    console.log(`    ${agent.padEnd(12)} ${runs.length} runs | ${successes}/${runs.length} OK | avg ${(avgMs/1000).toFixed(1)}s | avg ${avgTools} tools | avg ${avgTokens} tokens`)
  }

  // Failed tests
  if (errors.length > 0) {
    console.log(chalk.red.bold('\n  Failed Tests:'))
    for (const r of errors) {
      console.log(chalk.red(`    ❌ ${r.testId}: ${r.error?.slice(0, 100)}`))
    }
  }

  console.log(chalk.bold('\n  Output:'))
  console.log(`    Per-test JSON: .osint-sessions/benchmark/{testId}_{ts}.json`)
  console.log(`    Summary:       .osint-sessions/benchmark/summary.json`)
  console.log(chalk.bold('════════════════════════════════════════════════════\n'))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (shouldList) {
    listTestCases()
    process.exit(0)
  }

  // Select test cases
  let testCases: TestCase[]
  if (idFilter) {
    const tc = getTestCaseById(idFilter)
    if (!tc) {
      console.error(chalk.red(`❌ Test case not found: ${idFilter}`))
      console.error(chalk.dim('  Run with --list to see available test IDs'))
      process.exit(1)
    }
    testCases = [tc]
  } else if (categoryFilter) {
    testCases = getTestCasesByCategory(categoryFilter)
    if (testCases.length === 0) {
      console.error(chalk.red(`❌ No test cases found for category: ${categoryFilter}`))
      process.exit(1)
    }
  } else {
    testCases = TEST_CASES
  }

  console.log(chalk.bold('\n════════════════════════════════════════════════════'))
  console.log(chalk.bold(' OSINT Agent Benchmark Runner'))
  console.log(chalk.bold('════════════════════════════════════════════════════'))
  console.log(`  Test cases:  ${testCases.length}`)
  if (categoryFilter) console.log(`  Category:    ${categoryFilter}`)
  if (idFilter) console.log(`  Test ID:     ${idFilter}`)
  if (shouldClean) console.log(`  Graph:       ${chalk.yellow('will be cleared')}`)
  if (dryRun) console.log(chalk.yellow('  DRY RUN — no agents will be called'))
  console.log(chalk.bold('════════════════════════════════════════════════════\n'))

  if (shouldClean) {
    await cleanGraph()
    console.log()
  }

  if (dryRun) {
    console.log(chalk.yellow('Dry run mode — listing selected test cases:\n'))
    for (const tc of testCases) {
      console.log(`  ${chalk.bold(tc.id)} [${tc.category}/${tc.agent}/${tc.depth}]`)
      console.log(`    ${tc.description}`)
      console.log(`    Query: ${tc.query.slice(0, 80)}...`)
      console.log()
    }
    process.exit(0)
  }

  const results = await runBenchmark(testCases, {
    onProgress: (msg) => console.log(`  ${msg}`),
    onTestStart: (tc, idx, total) => {
      console.log(chalk.bold(`\n[${idx}/${total}] ${tc.id} — ${tc.category} / ${tc.agent} / ${tc.depth}`))
      console.log(chalk.dim(`  ${tc.description}`))
    },
    onTestComplete: () => {},
  })

  printSummary(results)
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err)
  process.exit(1)
})

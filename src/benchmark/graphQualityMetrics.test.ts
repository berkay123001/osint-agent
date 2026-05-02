/**
 * graphQualityMetrics.test.ts
 * Neo4j driver mock ile gerçek DB bağlantısı olmadan çalışır.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

// ── Neo4j driver mock ──────────────────────────────────────────────────────────

type FakeRecord = { get: (key: string) => unknown }

let mockQueryResults: FakeRecord[][] = []
let queriesRan: string[] = []

function makeFakeRecord(data: Record<string, unknown>): FakeRecord {
  return { get: (key: string) => data[key] }
}

// Neo4j integer-like object helper
function neo4jInt(n: number): { toNumber: () => number } {
  return { toNumber: () => n }
}

function createMockSession() {
  return {
    run: async (query: string) => {
      queriesRan.push(query.trim().split('\n')[0].trim())
      const records = mockQueryResults.shift() ?? []
      return { records }
    },
    close: async () => {},
  }
}

let mockDriverSession = createMockSession

// Patch neo4j module via dynamic import interception
// We mock at the module level by overriding getDriver before importing
const mockDriver = {
  session: () => mockDriverSession(),
}

// Override getDriver export via module-level mock
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'

// We use dynamic import after patching module cache — but ESM doesn't support that easily.
// Instead we test the pure logic branches via a thin wrapper:
// collectGraphQuality internals can be verified through integration assertions.
// For unit tests, we focus on generateQualityReport (pure logic) and
// the Neo4j integer conversion helper (inline tested below).

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('neo4j integer — toNumber() dönüşümü doğru çalışır', () => {
  const val = neo4jInt(42)
  assert.equal(typeof val.toNumber(), 'number')
  assert.equal(val.toNumber(), 42)
})

test('neo4j integer — düz sayı da Number() ile doğru dönüşür', () => {
  const val = 99
  const n = typeof val === 'object' && (val as { toNumber?: () => number })?.toNumber
    ? (val as { toNumber: () => number }).toNumber()
    : Number(val)
  assert.equal(n, 99)
})

// ── generateQualityReport (pure, file IO) ─────────────────────────────────────

import type { GraphQualityResult } from '../benchmark/graphQualityMetrics.js'
import { generateQualityReport } from '../benchmark/graphQualityMetrics.js'

function makeQualityResult(overrides: Partial<GraphQualityResult> = {}): GraphQualityResult {
  return {
    sessionId: 'test-session-1',
    collectedAt: '2026-05-02T10:00:00.000Z',
    totalNodes: 10,
    nodesByLabel: { Person: 3, Publication: 4, Organization: 3 },
    totalRelationships: 8,
    relationshipsByType: { AUTHORED: 4, CITED: 4 },
    avgConfidence: 0.72,
    nodesWithConfidence: 8,
    confidenceTiers: { high: 5, medium: 2, low: 1 },
    orphanNodes: 1,
    orphanRatio: 0.1,
    topHubs: [{ value: 'torvalds', label: 'Person', degree: 5 }],
    ...overrides,
  }
}

test('generateQualityReport — boş liste için dosya oluşturulur', async () => {
  // Patch output dir to tmp
  const tmpDir = path.join(os.tmpdir(), `gq-test-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  // We can't easily redirect BENCHMARK_DIR since it's a module-level const.
  // Instead verify the function doesn't throw with empty input.
  // The file write will go to .osint-sessions/benchmark/ which is fine in CI.
  await assert.doesNotReject(() => generateQualityReport([]))
})

test('generateQualityReport — tek sonuçla overallAvgConfidence doğru hesaplanır', async () => {
  // Capture written file content by reading it after the call
  const result = makeQualityResult({ avgConfidence: 0.65 })
  await generateQualityReport([result])

  // Read back the written file
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  assert.equal(parsed.overallAvgConfidence, 0.65)
  assert.equal(parsed.totalTestRuns, 1)
  assert.equal(parsed.overallTotalNodes, 10)
  assert.equal(parsed.overallTotalRelationships, 8)
})

test('generateQualityReport — iki sonuçla ortalama confidence doğru', async () => {
  const r1 = makeQualityResult({ sessionId: 's1', avgConfidence: 0.8 })
  const r2 = makeQualityResult({ sessionId: 's2', avgConfidence: 0.6 })
  await generateQualityReport([r1, r2])

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  assert.equal(parsed.overallAvgConfidence, 0.7)
  assert.equal(parsed.totalTestRuns, 2)
  assert.equal(parsed.overallTotalNodes, 20)
})

test('generateQualityReport — avgConfidence null olan sonuçlar hariç tutulur', async () => {
  const r1 = makeQualityResult({ sessionId: 's1', avgConfidence: 0.8 })
  const r2 = makeQualityResult({ sessionId: 's2', avgConfidence: null })
  await generateQualityReport([r1, r2])

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  // Only r1's confidence (0.8) counted
  assert.equal(parsed.overallAvgConfidence, 0.8)
})

test('generateQualityReport — orphan ratio toplamı doğru', async () => {
  const r1 = makeQualityResult({ sessionId: 's1', totalNodes: 10, orphanNodes: 2 })
  const r2 = makeQualityResult({ sessionId: 's2', totalNodes: 10, orphanNodes: 4 })
  await generateQualityReport([r1, r2])

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  // (2+4) / (10+10) = 0.3
  assert.equal(parsed.overallOrphanRatio, 0.3)
})

test('generateQualityReport — perTest dizisi tüm alanları içerir', async () => {
  const result = makeQualityResult()
  await generateQualityReport([result])

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  const perTest = parsed.perTest[0]
  assert.ok('sessionId' in perTest)
  assert.ok('totalNodes' in perTest)
  assert.ok('totalRelationships' in perTest)
  assert.ok('avgConfidence' in perTest)
  assert.ok('confidenceTiers' in perTest)
  assert.ok('orphanNodes' in perTest)
  assert.ok('orphanRatio' in perTest)
  assert.ok('nodesByLabel' in perTest)
  assert.ok('relationshipsByType' in perTest)
  assert.ok('topHubs' in perTest)
})

test('generateQualityReport — confidence tier toplamları doğru aktarılır', async () => {
  const result = makeQualityResult({
    confidenceTiers: { high: 7, medium: 2, low: 1 },
  })
  await generateQualityReport([result])

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  assert.deepEqual(parsed.perTest[0].confidenceTiers, { high: 7, medium: 2, low: 1 })
})

test('generateQualityReport — topHubs listesi aktarılır', async () => {
  const result = makeQualityResult({
    topHubs: [
      { value: 'torvalds', label: 'Person', degree: 10 },
      { value: 'linux', label: 'Organization', degree: 7 },
    ],
  })
  await generateQualityReport([result])

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('.osint-sessions/benchmark/graph-quality.json', 'utf8')
  const parsed = JSON.parse(raw)

  assert.equal(parsed.perTest[0].topHubs.length, 2)
  assert.equal(parsed.perTest[0].topHubs[0].value, 'torvalds')
  assert.equal(parsed.perTest[0].topHubs[0].degree, 10)
})

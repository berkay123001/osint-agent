/**
 * Graph Quality Metrics
 * Benchmark test session'ları için Neo4j grafındaki düğüm/ilişki kalitesini ölçer.
 */

import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { getDriver } from '../lib/neo4j.js'

export interface ConfidenceTierDistribution {
  high: number    // C_v >= 0.7
  medium: number  // 0.4 <= C_v < 0.7
  low: number     // C_v < 0.4
}

export interface HubNode {
  value: string
  label: string
  degree: number
}

export interface GraphQualityResult {
  sessionId: string
  collectedAt: string

  // Düğüm sayıları
  totalNodes: number
  nodesByLabel: Record<string, number>

  // İlişki sayıları
  totalRelationships: number
  relationshipsByType: Record<string, number>

  // Confidence metrikleri
  avgConfidence: number | null
  nodesWithConfidence: number
  confidenceTiers: ConfidenceTierDistribution

  // Gürültü göstergesi
  orphanNodes: number
  orphanRatio: number   // orphanNodes / totalNodes (0–1)

  // Hub düğümler (en fazla bağlantılı top 5)
  topHubs: HubNode[]
}

const BENCHMARK_DIR = '.osint-sessions/benchmark'

/**
 * Verilen sessionId için Neo4j grafından kalite metriklerini toplar.
 * sessionId verilirse yalnızca o test'e ait düğümler sorgulanır.
 * sessionId verilmezse tüm graf sorgulanır (mevcut düğümler sessionId property'si
 * taşımadığında faydalıdır).
 */
export async function collectGraphQuality(sessionId?: string): Promise<GraphQualityResult> {
  const session = getDriver().session()
  const collectedAt = new Date().toISOString()
  const sid = sessionId ?? ''

  // sessionId filtresi — property mevcut değilse tüm grafı sorgula
  const nodeFilter = sid ? 'WHERE n.sessionId = $sessionId' : ''
  const relFilter  = sid ? 'WHERE r.sessionId = $sessionId' : ''
  const params     = sid ? { sessionId: sid } : {}

  try {
    // 1. Düğüm kategori dağılımı
    const labelResult = await session.run(
      `MATCH (n) ${nodeFilter}
       RETURN labels(n)[0] AS label, count(*) AS count`,
      params
    )
    const nodesByLabel: Record<string, number> = {}
    let totalNodes = 0
    for (const record of labelResult.records) {
      const label = record.get('label') as string ?? 'Unknown'
      const count = (record.get('count') as { toNumber?: () => number } | number)
      const n = typeof count === 'object' && count?.toNumber ? count.toNumber() : Number(count)
      nodesByLabel[label] = n
      totalNodes += n
    }

    // 2. Ortalama confidence
    const avgResult = await session.run(
      `MATCH (n) ${nodeFilter ? nodeFilter + ' AND' : 'WHERE'} n.confidence IS NOT NULL
       RETURN avg(n.confidence) AS avgConfidence, count(*) AS nodesWithConfidence`,
      params
    )
    const avgRow = avgResult.records[0]
    const avgConfidenceRaw = avgRow ? avgRow.get('avgConfidence') : null
    const avgConfidence = avgConfidenceRaw !== null && avgConfidenceRaw !== undefined
      ? parseFloat(Number(avgConfidenceRaw).toFixed(4))
      : null
    const nodesWithConfidenceRaw = avgRow ? avgRow.get('nodesWithConfidence') : 0
    const nodesWithConfidence = typeof nodesWithConfidenceRaw === 'object' && nodesWithConfidenceRaw?.toNumber
      ? nodesWithConfidenceRaw.toNumber()
      : Number(nodesWithConfidenceRaw ?? 0)

    // 3. Güven eşiği dağılımı
    const tierResult = await session.run(
      `MATCH (n) ${nodeFilter ? nodeFilter + ' AND' : 'WHERE'} n.confidence IS NOT NULL
       RETURN
         CASE
           WHEN n.confidence >= 0.7 THEN 'high'
           WHEN n.confidence >= 0.4 THEN 'medium'
           ELSE 'low'
         END AS tier,
         count(*) AS count`,
      params
    )
    const confidenceTiers: ConfidenceTierDistribution = { high: 0, medium: 0, low: 0 }
    for (const record of tierResult.records) {
      const tier = record.get('tier') as 'high' | 'medium' | 'low'
      const c = record.get('count') as { toNumber?: () => number } | number
      const n = typeof c === 'object' && c?.toNumber ? c.toNumber() : Number(c)
      if (tier in confidenceTiers) confidenceTiers[tier] = n
    }

    // 4. Orphan düğümler
    const orphanResult = await session.run(
      `MATCH (n) ${nodeFilter ? nodeFilter + ' AND' : 'WHERE'} COUNT { (n)--() } = 0
       RETURN count(*) AS orphanCount`,
      params
    )
    const orphanRaw = orphanResult.records[0]?.get('orphanCount') ?? 0
    const orphanNodes = typeof orphanRaw === 'object' && orphanRaw?.toNumber
      ? orphanRaw.toNumber()
      : Number(orphanRaw)
    const orphanRatio = totalNodes > 0
      ? parseFloat((orphanNodes / totalNodes).toFixed(4))
      : 0

    // 5. İlişki tipi dağılımı
    const relResult = await session.run(
      `MATCH ()-[r]->() ${relFilter}
       RETURN type(r) AS relType, count(*) AS count`,
      params
    )
    const relationshipsByType: Record<string, number> = {}
    let totalRelationships = 0
    for (const record of relResult.records) {
      const relType = record.get('relType') as string
      const c = record.get('count') as { toNumber?: () => number } | number
      const n = typeof c === 'object' && c?.toNumber ? c.toNumber() : Number(c)
      relationshipsByType[relType] = n
      totalRelationships += n
    }

    // 6. Hub düğümler — top 5
    const hubResult = await session.run(
      `MATCH (n) ${nodeFilter}
       WITH n, COUNT { (n)--() } AS degree
       WHERE degree > 0
       RETURN n.value AS value, labels(n)[0] AS label, degree
       ORDER BY degree DESC
       LIMIT 5`,
      params
    )
    const topHubs: HubNode[] = hubResult.records.map(record => ({
      value: record.get('value') as string ?? '',
      label: record.get('label') as string ?? 'Unknown',
      degree: Number(record.get('degree') ?? 0),
    }))

    return {
      sessionId: sid,
      collectedAt,
      totalNodes,
      nodesByLabel,
      totalRelationships,
      relationshipsByType,
      avgConfidence,
      nodesWithConfidence,
      confidenceTiers,
      orphanNodes,
      orphanRatio,
      topHubs,
    }
  } finally {
    await session.close()
  }
}

/**
 * Tüm test run'larının kalite sonuçlarını özetleyip dosyaya yazar.
 * graph-quality.json → .osint-sessions/benchmark/
 */
export async function generateQualityReport(results: GraphQualityResult[]): Promise<void> {
  await mkdir(BENCHMARK_DIR, { recursive: true })

  const totalNodes = results.reduce((s, r) => s + r.totalNodes, 0)
  const totalRels = results.reduce((s, r) => s + r.totalRelationships, 0)
  const totalOrphans = results.reduce((s, r) => s + r.orphanNodes, 0)

  const confidenceValues = results
    .map(r => r.avgConfidence)
    .filter((v): v is number => v !== null)
  const overallAvgConfidence = confidenceValues.length > 0
    ? parseFloat((confidenceValues.reduce((s, v) => s + v, 0) / confidenceValues.length).toFixed(4))
    : null

  const summary = {
    generatedAt: new Date().toISOString(),
    totalTestRuns: results.length,
    overallAvgConfidence,
    overallTotalNodes: totalNodes,
    overallTotalRelationships: totalRels,
    overallOrphanRatio: totalNodes > 0
      ? parseFloat((totalOrphans / totalNodes).toFixed(4))
      : 0,
    perTest: results.map(r => ({
      sessionId: r.sessionId,
      totalNodes: r.totalNodes,
      totalRelationships: r.totalRelationships,
      avgConfidence: r.avgConfidence,
      confidenceTiers: r.confidenceTiers,
      orphanNodes: r.orphanNodes,
      orphanRatio: r.orphanRatio,
      nodesByLabel: r.nodesByLabel,
      relationshipsByType: r.relationshipsByType,
      topHubs: r.topHubs,
    })),
  }

  await writeFile(
    path.join(BENCHMARK_DIR, 'graph-quality.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  )
}

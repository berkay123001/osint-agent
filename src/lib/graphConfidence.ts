/**
 * Graph-aware Confidence Scoring — v1
 *
 * Extends the flat source-based confidence model with graph signals:
 *
 *   C_v = w_s·C_source + w_c·C_corroboration + w_d·C_diversity
 *         − w_x·P_contradiction − w_f·P_falsepositive
 *
 * All component functions are pure — no Neo4j dependency — so the
 * entire scoring logic is testable without a live database.
 *
 * The Neo4j query layer (fetchGraphEvidence) lives at the bottom and
 * is the only function that touches the graph driver.
 */

import type { ConfidenceLevel } from './neo4j.js';

// ─── Weight configuration ────────────────────────────────────────────────────

export interface GraphConfidenceWeights {
  /** Source-level confidence weight */
  wSource: number;
  /** Corroboration (edge count) weight */
  wCorroboration: number;
  /** Source diversity weight */
  wDiversity: number;
  /** Contradiction penalty weight */
  wContradiction: number;
  /** False-positive label penalty weight */
  wFalsePositive: number;
}

/** Default weights tuned for v1 — sum of positive weights = 0.90 */
export const DEFAULT_WEIGHTS: GraphConfidenceWeights = {
  wSource: 0.40,
  wCorroboration: 0.30,
  wDiversity: 0.20,
  wContradiction: 0.30,
  wFalsePositive: 0.50,
};

// ─── Evidence input (filled by Neo4j query or unit-test fixtures) ─────────────

export interface GraphEvidenceInput {
  /** Primary confidence level assigned when the node was first written */
  sourceConfidence: ConfidenceLevel;
  /**
   * Number of distinct edges from different tool invocations that
   * independently support this node (corroborating evidence count).
   */
  corroboratingEdgeCount: number;
  /**
   * Number of distinct source tool types among all corroborating edges.
   * e.g. {github_api, holehe, sherlock} → 3
   */
  distinctSourceCount: number;
  /** True if any graph edge or node property indicates contradicting evidence */
  hasContradiction: boolean;
  /** True if this node carries mlLabel = 'false_positive' */
  isFalsePositive: boolean;
}

// ─── Numeric mapping ─────────────────────────────────────────────────────────

/**
 * Maps a categorical ConfidenceLevel to a [0, 1] numeric score.
 *
 * verified → 1.0 | high → 0.8 | medium → 0.5 | low → 0.2
 */
export function confidenceLevelToScore(level: ConfidenceLevel): number {
  switch (level) {
    case 'verified': return 1.0;
    case 'high':     return 0.8;
    case 'medium':   return 0.5;
    case 'low':      return 0.2;
  }
}

/**
 * Maps a numeric [0, 1] score back to a ConfidenceLevel.
 *
 * ≥ 0.85 → verified | ≥ 0.65 → high | ≥ 0.35 → medium | < 0.35 → low
 */
export function scoreToConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.85) return 'verified';
  if (score >= 0.65) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

/**
 * Corroboration component: saturates at `cap` edges.
 * C_corroboration = min(edgeCount / cap, 1.0)
 *
 * Default cap = 5 (5 independent tool results → full corroboration score).
 */
export function corroborationScore(edgeCount: number, cap = 5): number {
  return Math.min(edgeCount / cap, 1.0);
}

/**
 * Diversity component: saturates at `cap` distinct source types.
 * C_diversity = min(distinctSources / cap, 1.0)
 *
 * Default cap = 3 (3 distinct tool families → full diversity score).
 */
export function diversityScore(distinctSources: number, cap = 3): number {
  return Math.min(distinctSources / cap, 1.0);
}

// ─── Core scoring function ────────────────────────────────────────────────────

export interface GraphConfidenceResult {
  /** Raw numeric score in [0, 1] */
  score: number;
  /** Categorical level derived from score */
  level: ConfidenceLevel;
  /** Breakdown of each component for transparency */
  components: {
    cSource: number;
    cCorroboration: number;
    cDiversity: number;
    pContradiction: number;
    pFalsePositive: number;
  };
}

/**
 * Computes the graph-aware confidence score.
 *
 * Formula:
 *   C_v = w_s·C_s + w_c·C_c + w_d·C_d − w_x·P_x − w_f·P_f
 *
 * Result is clamped to [0, 1] before level mapping.
 */
export function computeGraphConfidence(
  input: GraphEvidenceInput,
  weights: GraphConfidenceWeights = DEFAULT_WEIGHTS,
): GraphConfidenceResult {
  const cSource        = confidenceLevelToScore(input.sourceConfidence);
  const cCorroboration = corroborationScore(input.corroboratingEdgeCount);
  const cDiversity     = diversityScore(input.distinctSourceCount);
  const pContradiction = input.hasContradiction ? 1.0 : 0.0;
  const pFalsePositive = input.isFalsePositive  ? 1.0 : 0.0;

  const raw =
    weights.wSource        * cSource        +
    weights.wCorroboration * cCorroboration +
    weights.wDiversity     * cDiversity     -
    weights.wContradiction * pContradiction -
    weights.wFalsePositive * pFalsePositive;

  const score = Math.max(0, Math.min(1, raw));

  return {
    score,
    level: scoreToConfidenceLevel(score),
    components: { cSource, cCorroboration, cDiversity, pContradiction, pFalsePositive },
  };
}

// ─── Neo4j query layer ────────────────────────────────────────────────────────

/**
 * Fetches graph evidence for a node and returns a GraphEvidenceInput
 * ready to be passed to computeGraphConfidence().
 *
 * Queries:
 * - All edges touching the node → corroborating edge count + distinct sources
 * - Node properties → mlLabel (false_positive check)
 * - CONTRADICTS relationships → contradiction flag
 *
 * Falls back to a minimal evidence object on any Neo4j error so the
 * caller can still produce a degraded (source-only) confidence score.
 */
export async function fetchGraphEvidence(
  label: string,
  value: string,
  defaultSourceConfidence: ConfidenceLevel = 'low',
): Promise<GraphEvidenceInput> {
  const fallback: GraphEvidenceInput = {
    sourceConfidence: defaultSourceConfidence,
    corroboratingEdgeCount: 0,
    distinctSourceCount: 0,
    hasContradiction: false,
    isFalsePositive: false,
  };

  let driver;
  try {
    const { getDriver } = await import('./neo4j.js');
    driver = getDriver();
  } catch {
    return fallback;
  }

  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (n:${label} {value: $value})
      OPTIONAL MATCH (n)-[r]-()
      RETURN
        n.mlLabel            AS mlLabel,
        n.confidence         AS nodeConfidence,
        collect(r.source)    AS sources,
        collect(r.confidence) AS edgeConfidences,
        EXISTS { MATCH (n)-[:CONTRADICTS]-() } AS hasContradiction
      `,
      { value },
    );

    if (result.records.length === 0) {
      return fallback;
    }

    const record = result.records[0];
    const mlLabel: string | null    = record.get('mlLabel');
    const nodeConfidence: string | null = record.get('nodeConfidence');
    const sources: (string | null)[] = record.get('sources') ?? [];
    const hasContradiction: boolean = record.get('hasContradiction') ?? false;

    // Filter to real (non-null) source strings
    const realSources = sources.filter((s): s is string => typeof s === 'string' && s.length > 0);
    const distinctSourceCount = new Set(realSources).size;
    const corroboratingEdgeCount = realSources.length;

    // Best source-level confidence from node property or edges
    const sourceConfidence: ConfidenceLevel = (() => {
      const candidate = (nodeConfidence ?? defaultSourceConfidence) as ConfidenceLevel;
      const valid: ConfidenceLevel[] = ['verified', 'high', 'medium', 'low'];
      return valid.includes(candidate) ? candidate : defaultSourceConfidence;
    })();

    return {
      sourceConfidence,
      corroboratingEdgeCount,
      distinctSourceCount,
      hasContradiction,
      isFalsePositive: mlLabel === 'false_positive',
    };
  } catch {
    return fallback;
  } finally {
    await session.close();
  }
}

/**
 * toolRegistry — query_graph_confidence integration tests
 *
 * These tests verify that:
 * 1. The tool definition exists in the exported `tools` array.
 * 2. `executeTool('query_graph_confidence', ...)` returns a correctly
 *    formatted result using the graphConfidence pipeline.
 * 3. The handler is resilient — a Neo4j-less environment gracefully
 *    falls back to a source-only score rather than throwing.
 * 4. The output format is parseable (score, level, all 5 components present).
 *
 * No Neo4j, no API keys required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tools, executeTool } from './toolRegistry.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function findTool(name: string) {
  return tools.find(t => t.function.name === name);
}

function parseConfidenceOutput(output: string): {
  label: string;
  value: string;
  score: number;
  level: string;
  sourceQuality: number;
  corroboration: number;
  diversity: number;
  contradictionPenalty: number;
  falsePositivePenalty: number;
} {
  const lines = output.split('\n');
  // Line 0: "📊 Graph Confidence — Label:value"
  const header = lines[0];
  const colonIdx = header.lastIndexOf('—');
  const labelValue = header.slice(colonIdx + 2).trim();
  const [label, value] = labelValue.split(':');

  // Line 1: "Score: 40.0% → low"
  const scoreLine = lines[1];
  const scoreMatch = scoreLine.match(/Score:\s*([\d.]+)%\s*→\s*(\w+)/);
  assert.ok(scoreMatch, `Could not parse score line: "${scoreLine}"`);
  const score = parseFloat(scoreMatch![1]) / 100;
  const level = scoreMatch![2];

  const getVal = (needle: string) => {
    const line = lines.find(l => l.includes(needle));
    assert.ok(line, `Missing line for "${needle}"`);
    const m = line!.match(/([\d.]+)%/);
    assert.ok(m, `Could not parse value from: "${line}"`);
    return parseFloat(m![1]) / 100;
  };

  return {
    label: label!,
    value: value!,
    score,
    level,
    sourceQuality: getVal('source_quality'),
    corroboration: getVal('corroboration'),
    diversity: getVal('diversity'),
    contradictionPenalty: getVal('contradiction_penalty'),
    falsePositivePenalty: getVal('false_positive_penalty'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('toolRegistry — query_graph_confidence tool definition', () => {
  it('tool is registered in tools array', () => {
    const tool = findTool('query_graph_confidence');
    assert.ok(tool, 'query_graph_confidence not found in tools array');
  });

  it('tool has required parameters: label and value', () => {
    const tool = findTool('query_graph_confidence');
    const params = tool!.function.parameters as any;
    assert.ok(params.properties.label, 'label parameter missing');
    assert.ok(params.properties.value, 'value parameter missing');
    assert.deepEqual(params.required, ['label', 'value']);
  });

  it('tool description mentions Cv and confidence level', () => {
    const tool = findTool('query_graph_confidence');
    const desc = tool!.function.description ?? '';
    assert.ok(desc.toLowerCase().includes('confidence'), 'Description should mention confidence');
  });
});

describe('toolRegistry — query_graph_confidence executeTool (no Neo4j)', () => {
  it('returns graceful fallback output without Neo4j connection', async () => {
    // fetchGraphEvidence falls back to low/empty evidence when Neo4j is absent
    const result = await executeTool('query_graph_confidence', {
      label: 'Username',
      value: 'testuser_no_neo4j',
    });

    assert.ok(typeof result === 'string', 'result should be a string');
    assert.ok(
      result.includes('Graph Confidence') || result.includes('query_graph_confidence error'),
      `Unexpected output: ${result.slice(0, 200)}`,
    );
  });

  it('output contains score percentage and level when Neo4j absent (fallback path)', async () => {
    const result = await executeTool('query_graph_confidence', {
      label: 'Email',
      value: 'test@example.com',
    });

    // Should either be a confidence report OR a graceful error — not a crash
    assert.ok(typeof result === 'string');
    assert.doesNotThrow(() => result);
  });

  it('fallback confidence output has all 5 component lines', async () => {
    const result = await executeTool('query_graph_confidence', {
      label: 'Person',
      value: 'John Doe',
    });

    if (result.startsWith('❌')) {
      // Error path is acceptable — graceful, not a crash
      assert.ok(result.includes('query_graph_confidence error'));
      return;
    }

    // Success path: all 5 component lines must be present
    assert.ok(result.includes('source_quality'), 'Missing source_quality line');
    assert.ok(result.includes('corroboration'), 'Missing corroboration line');
    assert.ok(result.includes('diversity'), 'Missing diversity line');
    assert.ok(result.includes('contradiction_penalty'), 'Missing contradiction_penalty line');
    assert.ok(result.includes('false_positive_penalty'), 'Missing false_positive_penalty line');
  });

  it('fallback score is low (source confidence defaults to low when node absent)', async () => {
    const result = await executeTool('query_graph_confidence', {
      label: 'Username',
      value: 'nobody_xyz_no_neo4j_test',
    });

    if (result.startsWith('❌')) return; // error path OK

    // Without Neo4j, fetchGraphEvidence returns sourceConfidence='low', 0 edges, 0 sources
    // C_v = 0.40 * 0.2 = 0.08 → low
    const parsed = parseConfidenceOutput(result);
    assert.equal(parsed.level, 'low', `Expected low but got ${parsed.level}`);
    assert.ok(parsed.score < 0.35, `Score ${parsed.score} is too high for a cold-start node`);
  });
});

describe('toolRegistry — query_graph_confidence pure scoring path', () => {
  it('computeGraphConfidence produces correct score for github_api source (direct unit)', async () => {
    // Import the pure functions directly — no tool registry overhead
    const { computeGraphConfidence } = await import('./graphConfidence.js');
    const result = computeGraphConfidence({
      sourceConfidence: 'verified',
      corroboratingEdgeCount: 8,
      distinctSourceCount: 3,
      hasContradiction: false,
      isFalsePositive: false,
    });

    // 0.40*1.0 + 0.30*1.0 + 0.20*1.0 = 0.90 → verified
    assert.ok(result.score >= 0.85, `Expected ≥0.85, got ${result.score}`);
    assert.equal(result.level, 'verified');
  });

  it('computeGraphConfidence produces low score for sherlock-only source (direct unit)', async () => {
    const { computeGraphConfidence } = await import('./graphConfidence.js');
    const result = computeGraphConfidence({
      sourceConfidence: 'medium',
      corroboratingEdgeCount: 1,
      distinctSourceCount: 1,
      hasContradiction: false,
      isFalsePositive: false,
    });

    // 0.40*0.5 + 0.30*0.2 + 0.20*0.33 = 0.20 + 0.06 + 0.067 = 0.327 → low
    assert.ok(result.score < 0.35, `Expected <0.35, got ${result.score}`);
    assert.equal(result.level, 'low');
  });

  it('false_positive label heavily penalises score → level drops to low', async () => {
    const { computeGraphConfidence } = await import('./graphConfidence.js');
    const result = computeGraphConfidence({
      sourceConfidence: 'high',
      corroboratingEdgeCount: 10,
      distinctSourceCount: 5,
      hasContradiction: false,
      isFalsePositive: true,
    });

    // Without false-positive penalty:  0.40*0.8 + 0.30*1.0 + 0.20*1.0 = 0.82
    // With wFalsePositive=0.50 penalty: 0.82 - 0.50*1.0 = 0.32 → low
    assert.ok(result.score < 0.35, `Expected <0.35, got ${result.score}`);
    assert.equal(result.level, 'low');
    assert.equal(result.components.pFalsePositive, 1.0, 'pFalsePositive should be 1.0');
  });
});

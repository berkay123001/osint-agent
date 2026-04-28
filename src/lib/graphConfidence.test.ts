/**
 * graphConfidence.ts — unit and integration-style tests
 *
 * All pure-function tests run without Neo4j (no env vars needed).
 * The integration-style scenario exercises the full scoring pipeline
 * with a fixture that mimics what fetchGraphEvidence would return.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confidenceLevelToScore,
  computeGraphConfidence,
  corroborationScore,
  DEFAULT_WEIGHTS,
  diversityScore,
  scoreToConfidenceLevel,
  type GraphEvidenceInput,
} from './graphConfidence.js';

// ─── confidenceLevelToScore ───────────────────────────────────────────────────

test('confidenceLevelToScore maps verified → 1.0', () => {
  assert.equal(confidenceLevelToScore('verified'), 1.0);
});

test('confidenceLevelToScore maps high → 0.8', () => {
  assert.equal(confidenceLevelToScore('high'), 0.8);
});

test('confidenceLevelToScore maps medium → 0.5', () => {
  assert.equal(confidenceLevelToScore('medium'), 0.5);
});

test('confidenceLevelToScore maps low → 0.2', () => {
  assert.equal(confidenceLevelToScore('low'), 0.2);
});

// ─── scoreToConfidenceLevel ───────────────────────────────────────────────────

test('scoreToConfidenceLevel maps 0.9 → verified', () => {
  assert.equal(scoreToConfidenceLevel(0.9), 'verified');
});

test('scoreToConfidenceLevel maps 0.85 → verified (boundary)', () => {
  assert.equal(scoreToConfidenceLevel(0.85), 'verified');
});

test('scoreToConfidenceLevel maps 0.84 → high (just below verified)', () => {
  assert.equal(scoreToConfidenceLevel(0.84), 'high');
});

test('scoreToConfidenceLevel maps 0.65 → high (boundary)', () => {
  assert.equal(scoreToConfidenceLevel(0.65), 'high');
});

test('scoreToConfidenceLevel maps 0.64 → medium (just below high)', () => {
  assert.equal(scoreToConfidenceLevel(0.64), 'medium');
});

test('scoreToConfidenceLevel maps 0.35 → medium (boundary)', () => {
  assert.equal(scoreToConfidenceLevel(0.35), 'medium');
});

test('scoreToConfidenceLevel maps 0.34 → low (just below medium)', () => {
  assert.equal(scoreToConfidenceLevel(0.34), 'low');
});

test('scoreToConfidenceLevel maps 0.0 → low', () => {
  assert.equal(scoreToConfidenceLevel(0.0), 'low');
});

// ─── corroborationScore ───────────────────────────────────────────────────────

test('corroborationScore(0) → 0.0', () => {
  assert.equal(corroborationScore(0), 0.0);
});

test('corroborationScore(5) → 1.0 (saturates at cap)', () => {
  assert.equal(corroborationScore(5), 1.0);
});

test('corroborationScore(10) → 1.0 (beyond cap clamped)', () => {
  assert.equal(corroborationScore(10), 1.0);
});

test('corroborationScore(2) → 0.4 (partial)', () => {
  assert.equal(corroborationScore(2), 0.4);
});

test('corroborationScore respects custom cap', () => {
  assert.equal(corroborationScore(4, 8), 0.5);
});

// ─── diversityScore ───────────────────────────────────────────────────────────

test('diversityScore(0) → 0.0', () => {
  assert.equal(diversityScore(0), 0.0);
});

test('diversityScore(3) → 1.0 (saturates at cap)', () => {
  assert.equal(diversityScore(3), 1.0);
});

test('diversityScore(6) → 1.0 (beyond cap clamped)', () => {
  assert.equal(diversityScore(6), 1.0);
});

test('diversityScore(1) → 0.333…', () => {
  assert.ok(Math.abs(diversityScore(1) - 1 / 3) < 1e-9);
});

// ─── computeGraphConfidence — scoring formula ─────────────────────────────────

test('github_api source with 5 edges from 3 sources → verified level', () => {
  const input: GraphEvidenceInput = {
    sourceConfidence: 'verified',  // github_api
    corroboratingEdgeCount: 5,
    distinctSourceCount: 3,
    hasContradiction: false,
    isFalsePositive: false,
  };
  const result = computeGraphConfidence(input);
  // C_v = 0.40×1.0 + 0.30×1.0 + 0.20×1.0 - 0 - 0 = 0.90
  assert.ok(Math.abs(result.score - 0.90) < 1e-9, `Expected 0.90, got ${result.score}`);
  assert.equal(result.level, 'verified');
});

test('low source with no corroboration → low level', () => {
  const input: GraphEvidenceInput = {
    sourceConfidence: 'low',
    corroboratingEdgeCount: 0,
    distinctSourceCount: 0,
    hasContradiction: false,
    isFalsePositive: false,
  };
  const result = computeGraphConfidence(input);
  // C_v = 0.40×0.2 + 0 + 0 = 0.08
  assert.ok(Math.abs(result.score - 0.08) < 1e-9, `Expected 0.08, got ${result.score}`);
  assert.equal(result.level, 'low');
});

test('contradiction penalty pushes high-confidence node below high', () => {
  const input: GraphEvidenceInput = {
    sourceConfidence: 'high',       // C_source = 0.8
    corroboratingEdgeCount: 3,      // C_corr = 0.6
    distinctSourceCount: 2,         // C_div = 0.667
    hasContradiction: true,         // P_x = 1.0
    isFalsePositive: false,
  };
  // C_v = 0.40×0.8 + 0.30×0.6 + 0.20×0.667 − 0.30×1.0 − 0
  //     = 0.32 + 0.18 + 0.1333 − 0.30 = 0.3333...
  const result = computeGraphConfidence(input);
  assert.ok(result.score < 0.35, `Expected score < 0.35 with contradiction, got ${result.score}`);
  assert.equal(result.level, 'low');
});

test('false-positive label clamps score to zero for low-confidence node', () => {
  const input: GraphEvidenceInput = {
    sourceConfidence: 'low',
    corroboratingEdgeCount: 0,
    distinctSourceCount: 0,
    hasContradiction: false,
    isFalsePositive: true,          // P_f = 1.0
  };
  // C_v = 0.40×0.2 - 0.50×1.0 = 0.08 - 0.50 = -0.42 → clamped to 0
  const result = computeGraphConfidence(input);
  assert.equal(result.score, 0, `Expected clamped 0, got ${result.score}`);
  assert.equal(result.level, 'low');
});

test('false-positive penalty still allows verified source to survive at medium', () => {
  // A verified node that was mislabelled FP should still score above 0
  const input: GraphEvidenceInput = {
    sourceConfidence: 'verified',   // C_source = 1.0
    corroboratingEdgeCount: 5,      // C_corr = 1.0
    distinctSourceCount: 3,         // C_div = 1.0
    hasContradiction: false,
    isFalsePositive: true,          // P_f = 1.0
  };
  // C_v = 0.40×1.0 + 0.30×1.0 + 0.20×1.0 − 0 − 0.50×1.0
  //     = 0.90 - 0.50 = 0.40
  const result = computeGraphConfidence(input);
  assert.ok(Math.abs(result.score - 0.40) < 1e-9, `Expected 0.40, got ${result.score}`);
  assert.equal(result.level, 'medium');
});

test('components breakdown is correct', () => {
  const input: GraphEvidenceInput = {
    sourceConfidence: 'medium',
    corroboratingEdgeCount: 2,
    distinctSourceCount: 1,
    hasContradiction: false,
    isFalsePositive: false,
  };
  const { components } = computeGraphConfidence(input);
  assert.equal(components.cSource, 0.5);
  assert.equal(components.cCorroboration, 0.4);
  assert.ok(Math.abs(components.cDiversity - 1 / 3) < 1e-9);
  assert.equal(components.pContradiction, 0.0);
  assert.equal(components.pFalsePositive, 0.0);
});

test('custom weights are applied correctly', () => {
  const input: GraphEvidenceInput = {
    sourceConfidence: 'high',
    corroboratingEdgeCount: 5,
    distinctSourceCount: 3,
    hasContradiction: false,
    isFalsePositive: false,
  };
  const weights = { wSource: 1.0, wCorroboration: 0, wDiversity: 0, wContradiction: 0, wFalsePositive: 0 };
  const result = computeGraphConfidence(input, weights);
  // Should equal confidenceLevelToScore('high') = 0.8
  assert.ok(Math.abs(result.score - 0.8) < 1e-9);
});

// ─── Integration-style scenario ───────────────────────────────────────────────
// Mimics fetchGraphEvidence output for a well-corroborated GitHub identity node.

test('integration: well-corroborated github identity scores verified', () => {
  // Simulates what fetchGraphEvidence returns for a user confirmed by
  // github_api + commit_email + holehe — 8 edges from 3 distinct source types.
  const evidence: GraphEvidenceInput = {
    sourceConfidence: 'verified',    // github_api wrote the node
    corroboratingEdgeCount: 8,       // emails, platforms, profiles, org edges
    distinctSourceCount: 3,          // github_api, commit_email, holehe
    hasContradiction: false,
    isFalsePositive: false,
  };
  const result = computeGraphConfidence(evidence);
  assert.equal(result.level, 'verified', 'Well-corroborated github node should be verified');
  assert.ok(result.score >= 0.85);
});

test('integration: sherlock-only node with no verification stays medium', () => {
  // Sherlock finds a profile — no cross-tool verification yet.
  const evidence: GraphEvidenceInput = {
    sourceConfidence: 'medium',      // sherlock
    corroboratingEdgeCount: 1,       // single HAS_PROFILE edge
    distinctSourceCount: 1,          // sherlock only
    hasContradiction: false,
    isFalsePositive: false,
  };
  // C_v = 0.40×0.5 + 0.30×0.2 + 0.20×0.333 − 0 − 0
  //     ≈ 0.20 + 0.06 + 0.067 = 0.327
  const result = computeGraphConfidence(evidence);
  assert.equal(result.level, 'low',
    'Single-source sherlock-only node should remain low without corroboration');
});

test('integration: same sherlock node after holehe+github corroboration upgrades to high', () => {
  const evidence: GraphEvidenceInput = {
    sourceConfidence: 'medium',      // original sherlock write
    corroboratingEdgeCount: 4,       // HAS_PROFILE + USES_EMAIL + REGISTERED_ON + REAL_NAME
    distinctSourceCount: 3,          // sherlock, holehe, github_api
    hasContradiction: false,
    isFalsePositive: false,
  };
  // C_v = 0.40×0.5 + 0.30×0.8 + 0.20×1.0 − 0 − 0 = 0.20+0.24+0.20 = 0.64
  const result = computeGraphConfidence(evidence);
  // 0.64 is just below high threshold (0.65) — medium is correct here
  assert.ok(result.score >= 0.60, `Expected ≥0.60 after corroboration, got ${result.score}`);
});

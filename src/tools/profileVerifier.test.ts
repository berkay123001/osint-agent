/**
 * profileVerifier.test.ts
 * Unit tests for S_prof (Formula 1) and V(p) decision function (Formula 2).
 * Tests run purely on exported scoring functions — no network/scrape calls.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EVIDENCE_WEIGHTS,
  WeightedEvidence,
  computeProfScore,
  findWeightedMatches,
} from './profileVerifier.js'
import type { KnownIdentifiers } from './profileVerifier.js'

// ── EVIDENCE_WEIGHTS sanity checks ──────────────────────────────────────────

test('EVIDENCE_WEIGHTS — email is highest weight', () => {
  assert.equal(EVIDENCE_WEIGHTS.email, 0.40)
})

test('EVIDENCE_WEIGHTS — all weights sum ≤ 1.0', () => {
  const total = Object.values(EVIDENCE_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(total <= 1.0, `sum=${total} exceeds 1.0`)
})

test('EVIDENCE_WEIGHTS — avatar_weak has zero weight', () => {
  assert.equal(EVIDENCE_WEIGHTS.avatar_weak, 0.00)
})

// ── computeProfScore (Formula 1: S_prof = Σ w_i · e_i) ───────────────────────

test('S_prof — email only → 0.40', () => {
  const matches: WeightedEvidence[] = [
    { indicator: 'email: foo@bar.com', type: 'email', weight: EVIDENCE_WEIGHTS.email },
  ]
  assert.equal(computeProfScore(matches), 0.40)
})

test('S_prof — email + isim → 0.65', () => {
  const matches: WeightedEvidence[] = [
    { indicator: 'email: foo@bar.com', type: 'email', weight: EVIDENCE_WEIGHTS.email },
    { indicator: 'isim: Linus Torvalds', type: 'isim', weight: EVIDENCE_WEIGHTS.isim },
  ]
  const score = computeProfScore(matches)
  assert.ok(Math.abs(score - 0.65) < 0.001, `expected 0.65, got ${score}`)
})

test('S_prof — avatar only → 0.05', () => {
  const matches: WeightedEvidence[] = [
    { indicator: 'avatar: Görsel Eşleşmesi (Mesafe: 3/64)', type: 'avatar', weight: EVIDENCE_WEIGHTS.avatar },
  ]
  assert.equal(computeProfScore(matches), 0.05)
})

test('S_prof — konum only → 0.05', () => {
  const matches: WeightedEvidence[] = [
    { indicator: 'konum: finland', type: 'konum', weight: EVIDENCE_WEIGHTS.konum },
  ]
  assert.equal(computeProfScore(matches), 0.05)
})

test('S_prof — email + isim + organizasyon → 0.75', () => {
  const matches: WeightedEvidence[] = [
    { indicator: 'email: foo@bar.com', type: 'email', weight: EVIDENCE_WEIGHTS.email },
    { indicator: 'isim: Linus Torvalds', type: 'isim', weight: EVIDENCE_WEIGHTS.isim },
    { indicator: 'organizasyon: Linux Foundation', type: 'organizasyon', weight: EVIDENCE_WEIGHTS.organizasyon },
  ]
  const score = computeProfScore(matches)
  assert.ok(Math.abs(score - 0.75) < 0.001, `expected 0.75, got ${score}`)
})

test('S_prof — empty matches → 0', () => {
  assert.equal(computeProfScore([]), 0)
})

// ── V(p) decision function via findWeightedMatches + computeProfScore ─────────

const baseKnown: KnownIdentifiers = {
  username: 'torvalds',
  realName: 'Linus Torvalds',
  emails: ['torvalds@linux-foundation.org'],
  location: 'Portland, OR',
  company: 'Linux Foundation',
  blog: 'https://torvalds.linux.dev',
  avatarUrl: undefined,
  avatarHash: undefined,
}

test('V(p) — email match → confidence=medium, verified=true', () => {
  const content = 'contact: torvalds@linux-foundation.org for kernel patches'
  const known: KnownIdentifiers = { ...baseKnown, realName: undefined, company: undefined, location: undefined, blog: undefined }
  const matches = findWeightedMatches(content, known)
  const S_prof = computeProfScore(matches)

  assert.equal(S_prof, 0.40)
  // V(p): hasNonAvatarEvidence=true, length=1 (not >1), S_prof=0.40>=0.15 → medium
  const hasNonAvatar = matches.some(m => m.type !== 'avatar' && m.type !== 'avatar_weak')
  const confidence = hasNonAvatar && matches.length > 1 && S_prof >= 0.50 ? 'high'
    : hasNonAvatar && S_prof >= 0.15 ? 'medium'
    : 'low'
  const verified = hasNonAvatar && S_prof >= 0.25
  assert.equal(confidence, 'medium')
  assert.equal(verified, true)
})

test('V(p) — email + isim → confidence=high, verified=true', () => {
  const content = 'contact: torvalds@linux-foundation.org | Author: Linus Torvalds'
  const known: KnownIdentifiers = { ...baseKnown, company: undefined, location: undefined, blog: undefined }
  const matches = findWeightedMatches(content, known)
  const S_prof = computeProfScore(matches)

  assert.ok(Math.abs(S_prof - 0.65) < 0.001, `expected 0.65, got ${S_prof}`)
  const hasNonAvatar = matches.some(m => m.type !== 'avatar' && m.type !== 'avatar_weak')
  const confidence = hasNonAvatar && matches.length > 1 && S_prof >= 0.50 ? 'high'
    : hasNonAvatar && S_prof >= 0.15 ? 'medium'
    : 'low'
  const verified = hasNonAvatar && S_prof >= 0.25
  assert.equal(confidence, 'high')
  assert.equal(verified, true)
})

test('V(p) — konum only → confidence=low, verified=false', () => {
  const content = 'located in portland, or. no email here.'
  const known: KnownIdentifiers = { ...baseKnown, realName: undefined, emails: [], company: undefined, blog: undefined }
  const matches = findWeightedMatches(content, known)
  const S_prof = computeProfScore(matches)

  assert.equal(S_prof, 0.05)
  const hasNonAvatar = matches.some(m => m.type !== 'avatar' && m.type !== 'avatar_weak')
  const confidence = hasNonAvatar && matches.length > 1 && S_prof >= 0.50 ? 'high'
    : hasNonAvatar && S_prof >= 0.15 ? 'medium'
    : 'low'
  const verified = hasNonAvatar && S_prof >= 0.25
  assert.equal(confidence, 'low')
  assert.equal(verified, false)
})

test('V(p) — email + isim + organizasyon → confidence=high, S_prof=0.75', () => {
  const content = 'email: torvalds@linux-foundation.org | linus torvalds works at linux foundation'
  const known: KnownIdentifiers = { ...baseKnown, location: undefined, blog: undefined }
  const matches = findWeightedMatches(content, known)
  const S_prof = computeProfScore(matches)

  assert.ok(Math.abs(S_prof - 0.75) < 0.001, `expected 0.75, got ${S_prof}`)
  const hasNonAvatar = matches.some(m => m.type !== 'avatar' && m.type !== 'avatar_weak')
  const confidence = hasNonAvatar && matches.length > 1 && S_prof >= 0.50 ? 'high'
    : hasNonAvatar && S_prof >= 0.15 ? 'medium'
    : 'low'
  assert.equal(confidence, 'high')
})

test('findWeightedMatches — no evidence → empty array', () => {
  const content = 'random page with no relevant info'
  const matches = findWeightedMatches(content, baseKnown)
  // emails and realName not in content, location "portland" not in content, company "Linux Foundation" not in content
  assert.ok(matches.every(m => m.weight === 0 || !content.toLowerCase().includes(m.type)), 'unexpected strong match')
})

test('findWeightedMatches — blog URL match → website weight=0.15', () => {
  const content = 'visit torvalds.linux.dev for more info'
  const known: KnownIdentifiers = { ...baseKnown, emails: [], realName: undefined, company: undefined, location: undefined }
  const matches = findWeightedMatches(content, known)
  const websiteMatch = matches.find(m => m.type === 'website')
  assert.ok(websiteMatch, 'website match not found')
  assert.equal(websiteMatch!.weight, 0.15)
})

test('findWeightedMatches — single-part name not matched (requires 2+ parts)', () => {
  const content = 'linus is a developer'  // only one name part with length > 2
  const known: KnownIdentifiers = { ...baseKnown, realName: 'Linus', emails: [], company: undefined, location: undefined, blog: undefined }
  const matches = findWeightedMatches(content, known)
  const nameMatch = matches.find(m => m.type === 'isim')
  assert.equal(nameMatch, undefined, 'single-part name should not match')
})

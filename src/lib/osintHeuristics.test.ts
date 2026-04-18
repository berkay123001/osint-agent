import assert from 'node:assert/strict'
import test from 'node:test'
import { isLikelyUsernameCandidate, isCommonName, crossReferenceScore } from './osintHeuristics.js'

test('accepts handle-like usernames', () => {
  assert.equal(isLikelyUsernameCandidate('Sadelimon'), true)
  assert.equal(isLikelyUsernameCandidate('salih_dursun'), true)
})

test('rejects full names with spaces', () => {
  assert.equal(isLikelyUsernameCandidate('Salih Dursun'), false)
  assert.equal(isLikelyUsernameCandidate('  John Doe  '), false)
})

test('detects common Turkish names', () => {
  assert.equal(isCommonName('Salih Dursun'), true)
  assert.equal(isCommonName('Mehmet Yılmaz'), true)
  assert.equal(isCommonName('Ali Kaya'), true)
})

test('non-common names return false', () => {
  assert.equal(isCommonName('Xyzabc Qrstuv'), false)
  assert.equal(isCommonName('Sadelimon'), false)  // tek kelime
})

test('crossReferenceScore counts matching identifiers', () => {
  const known = {
    emails: ['test@example.com', 'other@gmail.com'],
    handles: ['sadelimon'],
    websites: ['https://example.com/blog'],
  }
  // Email match
  const r1 = crossReferenceScore(known, { email: 'test@example.com' })
  assert.equal(r1.score, 1)
  assert.ok(r1.matches[0].includes('email'))

  // No match at all
  const r2 = crossReferenceScore(known, { email: 'random@gmail.com', handle: 'someone' })
  assert.equal(r2.score, 0)

  // Multiple matches
  const r3 = crossReferenceScore(known, { email: 'test@example.com', handle: 'sadelimon' })
  assert.equal(r3.score, 2)
})
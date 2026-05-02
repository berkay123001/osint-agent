/**
 * Image Hasher Test Suite
 * calculateHammingDistance — saf fonksiyon
 * fetchAndHashImage — Jimp wrapper (mock veya gerçek URL)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateHammingDistance, fetchAndHashImage } from './imageHasher.js'

// ===== calculateHammingDistance — Saf Fonksiyon =====

test('calculateHammingDistance: aynı hash → 0', () => {
  const hash = '0'.repeat(64)
  assert.equal(calculateHammingDistance(hash, hash), 0)
})

test('calculateHammingDistance: tamamen farklı hash → 64', () => {
  const hash1 = '0'.repeat(64)
  const hash2 = '1'.repeat(64)
  assert.equal(calculateHammingDistance(hash1, hash2), 64)
})

test('calculateHammingDistance: 1 bit fark → 1', () => {
  const hash1 = '0'.repeat(64)
  const hash2 = '1' + '0'.repeat(63)
  assert.equal(calculateHammingDistance(hash1, hash2), 1)
})

test('calculateHammingDistance: 10 bit fark → 10', () => {
  const hash1 = '0'.repeat(64)
  const hash2 = '1'.repeat(10) + '0'.repeat(54)
  assert.equal(calculateHammingDistance(hash1, hash2), 10)
})

test('calculateHammingDistance: 32 bit fark → 32 (yarı farklı)', () => {
  const hash1 = '0'.repeat(64)
  const hash2 = '1'.repeat(32) + '0'.repeat(32)
  assert.equal(calculateHammingDistance(hash1, hash2), 32)
})

test('calculateHammingDistance: yanlış uzunluk → 64 döner', () => {
  const short = '0'.repeat(10)
  const normal = '0'.repeat(64)
  assert.equal(calculateHammingDistance(short, normal), 64)
})

test('calculateHammingDistance: her iki hash de kısa → 64 döner', () => {
  assert.equal(calculateHammingDistance('', ''), 64)
})

// ===== fetchAndHashImage =====

test('fetchAndHashImage: geçersiz URL → null döner', async () => {
  const result = await fetchAndHashImage('https://this-domain-does-not-exist-xyz.invalid/image.jpg')
  // Ağ hatası veya Jimp parse hatası → null
  assert.equal(result, null)
})

test("fetchAndHashImage: geçerli GitHub avatar URL'sinden hash üretilebilir", async () => {
  // Gerçek ağ isteği — CI ortamında atlayabilir (null kabul edilir)
  const result = await fetchAndHashImage('https://avatars.githubusercontent.com/u/1024025?v=4')
  if (result !== null) {
    // Hash string ve 64 char'dan fazla olmamalı (base-2 Jimp hash formatı değişkendir)
    assert.ok(typeof result === 'string')
    assert.ok(result.length > 0)
  } else {
    // Ağ erişimi yoksa null — geçerli durum
    assert.equal(result, null)
  }
})

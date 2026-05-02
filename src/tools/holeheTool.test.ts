/**
 * Holehe Tool Test Suite
 * E-posta format doğrulama + formatHoleheResult saf fonksiyon testleri
 * Gerçek subprocess çalıştırılmaz — validation path'i test edilir
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkEmailRegistrations, formatHoleheResult } from './holeheTool.js'
import type { HoleheResult } from './holeheTool.js'

// ===== checkEmailRegistrations — Giriş Doğrulama =====

test('checkEmailRegistrations: geçersiz email format → error, subprocess yok', async () => {
  const result = await checkEmailRegistrations('bu-bir-email-değil')
  assert.ok(result.error?.includes('Invalid email format'))
  assert.equal(result.services.length, 0)
  assert.equal(result.totalChecked, 0)
})

test('checkEmailRegistrations: @ işareti eksik → error', async () => {
  const result = await checkEmailRegistrations('kullanicidomain.com')
  assert.ok(result.error?.includes('Invalid email format'))
})

test('checkEmailRegistrations: boş string → error', async () => {
  const result = await checkEmailRegistrations('')
  assert.ok(result.error?.includes('Invalid email format'))
})

test('checkEmailRegistrations: alan adı yok → error', async () => {
  const result = await checkEmailRegistrations('user@')
  assert.ok(result.error?.includes('Invalid email format'))
})

test('checkEmailRegistrations: kullanıcı adı yok → error', async () => {
  const result = await checkEmailRegistrations('@example.com')
  assert.ok(result.error?.includes('Invalid email format'))
})

test('checkEmailRegistrations: enjeksiyon girişimi → error (güvenlik)', async () => {
  const result = await checkEmailRegistrations('test@ex.com; rm -rf /')
  assert.ok(result.error?.includes('Invalid email format'))
})

// ===== formatHoleheResult — Saf Fonksiyon =====

test('formatHoleheResult: hata sonucu doğru formatlanıyor', () => {
  const result: HoleheResult = {
    email: 'test@example.com',
    services: [],
    totalChecked: 0,
    error: 'Python bulunamadı',
  }
  const out = formatHoleheResult(result)
  assert.ok(out.includes('Python bulunamadı'))
})

test('formatHoleheResult: boş servis listesi', () => {
  const result: HoleheResult = {
    email: 'test@example.com',
    services: [],
    totalChecked: 150,
  }
  const out = formatHoleheResult(result)
  assert.ok(out.includes('test@example.com'))
  assert.ok(out.includes('150'))
  assert.ok(out.includes('not found') || out.includes('bulunamadı'))
})

test('formatHoleheResult: kayıtlı servisler listeleniyor', () => {
  const result: HoleheResult = {
    email: 'victim@example.com',
    services: [
      { name: 'Twitter', exists: true, emailrecovery: null, phoneNumber: null, others: null },
      { name: 'Spotify', exists: true, emailrecovery: 'v***m@e***.com', phoneNumber: null, others: null },
    ],
    totalChecked: 200,
  }
  const out = formatHoleheResult(result)
  assert.ok(out.includes('victim@example.com'))
  assert.ok(out.includes('Twitter'))
  assert.ok(out.includes('Spotify'))
  assert.ok(out.includes('200'))
})

test('formatHoleheResult: rate limit bilgisi gösteriliyor', () => {
  const result: HoleheResult = {
    email: 'test@example.com',
    services: [],
    totalChecked: 100,
    rateLimitedCount: 15,
    rateLimitedPlatforms: ['Instagram', 'Facebook'],
  }
  const out = formatHoleheResult(result)
  assert.ok(out.includes('15') || out.includes('Rate limit') || out.includes('rate limit'))
})

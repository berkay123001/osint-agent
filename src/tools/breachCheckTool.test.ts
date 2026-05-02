/**
 * Breach Check Tool Test Suite
 * formatBreachResult saf fonksiyon + local fallback + fetch mock testleri
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkBreaches, formatBreachResult } from './breachCheckTool.js'
import type { BreachCheckResult } from './breachCheckTool.js'

// ===== formatBreachResult — Saf Fonksiyon =====

test('formatBreachResult: hata mesajı doğru formatlanıyor', () => {
  const result: BreachCheckResult = {
    email: 'test@example.com',
    breaches: [],
    source: 'none',
    error: 'API key bulunamadı',
  }
  const out = formatBreachResult(result)
  assert.ok(out.includes('API key bulunamadı'))
})

test('formatBreachResult: temiz email doğru mesaj', () => {
  const result: BreachCheckResult = {
    email: 'clean@example.com',
    breaches: [],
    source: 'hibp',
  }
  const out = formatBreachResult(result)
  assert.ok(out.includes('clean@example.com'))
  assert.ok(out.includes('✅') || out.includes('bulunamadı') || out.includes('not found'))
})

test('formatBreachResult: ihlal listesi doğru gösteriliyor', () => {
  const result: BreachCheckResult = {
    email: 'victim@example.com',
    breaches: [
      {
        name: 'Adobe',
        domain: 'adobe.com',
        breachDate: '2013-10-04',
        dataClasses: ['Email', 'Password', 'Username'],
      },
      {
        name: 'LinkedIn',
        domain: 'linkedin.com',
        breachDate: '2012-05-05',
        dataClasses: ['Email', 'Password'],
      },
    ],
    source: 'hibp',
  }
  const out = formatBreachResult(result)
  assert.ok(out.includes('victim@example.com'))
  assert.ok(out.includes('Adobe'))
  assert.ok(out.includes('adobe.com'))
  assert.ok(out.includes('LinkedIn'))
  assert.ok(out.includes('2013-10-04'))
  assert.ok(out.includes('Email'))
  assert.ok(out.includes('⚠️') || out.includes('2 veri') || out.includes('sızıntı'))
})

test('formatBreachResult: kaynak etiketi doğru — HIBP', () => {
  const result: BreachCheckResult = { email: 'x@y.com', breaches: [], source: 'hibp' }
  const out = formatBreachResult(result)
  assert.ok(out.includes('HIBP') || out.includes('Have I Been'))
})

test('formatBreachResult: kaynak etiketi doğru — LeakCheck', () => {
  const result: BreachCheckResult = { email: 'x@y.com', breaches: [], source: 'leakcheck' }
  const out = formatBreachResult(result)
  assert.ok(out.includes('LeakCheck') || out.includes('leakcheck'))
})

test('formatBreachResult: kaynak etiketi doğru — local', () => {
  const result: BreachCheckResult = { email: 'x@y.com', breaches: [], source: 'local' }
  const out = formatBreachResult(result)
  assert.ok(out.includes('okal') || out.includes('test'))
})

// ===== checkBreaches — Local Fallback (API key yok) =====

test('checkBreaches: API key yoksa local veya none source döner', async (t) => {
  // API key'leri temizle, sadece local DB'ye düşmesini sağla
  const saved = { hibp: process.env.HIBP_API_KEY }
  delete process.env.HIBP_API_KEY

  // LeakCheck fetch'ini başarısız yap
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network unreachable')
  })

  try {
    const result = await checkBreaches('nokey@example.com')
    assert.ok(['local', 'none'].includes(result.source))
    assert.ok(Array.isArray(result.breaches))
    assert.equal(result.email, 'nokey@example.com')
  } finally {
    if (saved.hibp) process.env.HIBP_API_KEY = saved.hibp
  }
})

test('checkBreaches: LeakCheck başarılı yanıt → leakcheck source', async (t) => {
  const saved = { hibp: process.env.HIBP_API_KEY }
  delete process.env.HIBP_API_KEY

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      found: 2,
      fields: ['email', 'password'],
      sources: [
        { name: 'TestBreach', date: '2022' },
        { name: 'AnotherBreach', date: '2023' },
      ],
    }),
  }))

  try {
    const result = await checkBreaches('hacked@example.com')
    assert.equal(result.source, 'leakcheck')
    assert.equal(result.breaches.length, 2)
    assert.equal(result.breaches[0].name, 'TestBreach')
    assert.ok(result.breaches[0].dataClasses.includes('email'))
  } finally {
    if (saved.hibp) process.env.HIBP_API_KEY = saved.hibp
  }
})

test('checkBreaches: LeakCheck found=0 → boş breach listesi', async (t) => {
  const saved = { hibp: process.env.HIBP_API_KEY }
  delete process.env.HIBP_API_KEY

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, found: 0 }),
  }))

  try {
    const result = await checkBreaches('clean@example.com')
    assert.equal(result.source, 'leakcheck')
    assert.equal(result.breaches.length, 0)
    assert.ok(!result.error)
  } finally {
    if (saved.hibp) process.env.HIBP_API_KEY = saved.hibp
  }
})

test('checkBreaches: LeakCheck HTTP 429 → local fallback', async (t) => {
  const saved = { hibp: process.env.HIBP_API_KEY }
  delete process.env.HIBP_API_KEY

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
  }))

  try {
    const result = await checkBreaches('ratelimited@example.com')
    // 429 → local fallback'e düşmeli
    assert.ok(['local', 'none'].includes(result.source))
  } finally {
    if (saved.hibp) process.env.HIBP_API_KEY = saved.hibp
  }
})

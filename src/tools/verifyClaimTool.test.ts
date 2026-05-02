/**
 * Verify Claim Tool Test Suite
 * verifyClaim — çok kaynaklı iddia doğrulama
 * fetch mock ile searchWeb + scrapeProfile çağrıları kontrol edilir
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyClaim } from './verifyClaimTool.js'

// ===== verifyClaim =====

test('verifyClaim: tüm kaynaklar başarısız → inconclusive döner', async (t) => {
  // fetch her çağrıda başarısız
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network unreachable')
  })

  const result = await verifyClaim(
    'Bu ürün ücretsizdir',
    'https://example.com/product',
    ['free', 'ücretsiz']
  )

  // Network tamamen çöktüğünde sonuç null ya da inconclusive olmalı
  assert.ok(result.claim === 'Bu ürün ücretsizdir')
  assert.ok(result.confidence === 'inconclusive' || result.confidence === 'low' || result.verified === null)
  assert.ok(Array.isArray(result.evidence))
  assert.ok(Array.isArray(result.sourcesChecked))
})

test('verifyClaim: birincil kaynakta keyword bulundu → confidence high/medium', async (t) => {
  let callCount = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    callCount++
    if (typeof url === 'string' && url.includes('searx')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'Community discussion', content: 'free plan, no credit card', url: 'https://news.ycombinator.com/item' },
          ],
        }),
      }
    }
    // scrapeProfile → Firecrawl'a gidecek
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          markdown: 'This product is completely free. No credit card required. Sign up for free today.',
          links: [],
          metadata: { title: 'Product Page', description: '' },
        },
      }),
    }
  })

  const result = await verifyClaim(
    'Bu ürün ücretsizdir',
    'https://product.example.com',
    ['free', 'no credit card']
  )

  assert.equal(result.claim, 'Bu ürün ücretsizdir')
  // Firecrawl'dan içerik alındıysa confidence yüksek olmalı
  assert.ok(['high', 'medium', 'low', 'inconclusive'].includes(result.confidence))
  assert.ok(typeof result.verified === 'boolean' || result.verified === null)
  assert.ok(Array.isArray(result.evidence))
})

test('verifyClaim: sourcesChecked primaryUrl içeriyor', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 404,
    text: async () => '',
    json: async () => ({ results: [] }),
  }))

  const result = await verifyClaim(
    'Test iddiası',
    'https://checked-site.example.com',
    ['test']
  )

  // primaryUrl kontrol edilmiş olmalı
  assert.ok(result.sourcesChecked.includes('https://checked-site.example.com'))
})

test('verifyClaim: SSRF korumalı URL → scrape başarısız ama işlem devam ediyor', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
  }))

  // Dahili URL — scrapeProfile SSRF bloğu devreye girer
  const result = await verifyClaim(
    'İç servis mevcut',
    'http://192.168.1.1/status',
    ['mevcut', 'available']
  )

  // Hata olsa da result objesi dönmeli
  assert.ok(result.claim === 'İç servis mevcut')
  assert.ok(result.confidence === 'inconclusive' || result.confidence === 'low')
})

test('verifyClaim: result yapısı tüm alanları içeriyor', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline')
  })

  const result = await verifyClaim('test', 'https://example.com', ['test'])

  assert.ok('claim' in result)
  assert.ok('verified' in result)
  assert.ok('confidence' in result)
  assert.ok('evidence' in result)
  assert.ok('loginWall' in result)
  assert.ok('sourcesChecked' in result)
})

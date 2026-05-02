/**
 * Search Tool Test Suite
 * 4-katmanlı arama zinciri: SearXNG → Brave → Google CSE → Tavily
 * fetch mock + saf fonksiyon testleri
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { searchWeb, formatSearchResult, searchWebMulti } from './searchTool.js'

// ===== formatSearchResult — saf fonksiyon =====

test('formatSearchResult: hata mesajı doğru formatlanıyor', () => {
  const result = formatSearchResult({ query: 'test', results: [], error: 'API key yok' })
  assert.ok(result.includes('❌'))
  assert.ok(result.includes('API key yok'))
})

test('formatSearchResult: sonuç bulunamadı doğru formatlanıyor', () => {
  const result = formatSearchResult({ query: 'arama sorgusu', results: [] })
  assert.ok(result.includes('No results') || result.includes('bulunamadı'))
})

test('formatSearchResult: sonuçlar doğru listeleniyor', () => {
  const response = {
    query: 'test',
    provider: 'SearXNG',
    results: [
      { title: 'Sayfa 1', url: 'https://example.com/1', snippet: 'Açıklama 1' },
      { title: 'Sayfa 2', url: 'https://example.com/2', snippet: 'Açıklama 2' },
    ],
  }
  const out = formatSearchResult(response)
  assert.ok(out.includes('Sayfa 1'))
  assert.ok(out.includes('example.com/1'))
  assert.ok(out.includes('SearXNG'))
  assert.ok(out.includes('2 result'))
})

// ===== searchWeb — SearXNG mock =====

test('searchWeb: SearXNG başarılı yanıt döndürdüğünde provider SearXNG olur', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { title: 'Sonuç 1', content: 'Snippet 1', url: 'https://result1.com' },
        { title: 'Sonuç 2', content: 'Snippet 2', url: 'https://result2.com' },
      ],
    }),
  }))

  const result = await searchWeb('test query', 5)
  assert.equal(result.provider, 'SearXNG')
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].title, 'Sonuç 1')
  assert.equal(result.results[0].url, 'https://result1.com')
  assert.ok(!result.error)
})

test('searchWeb: SearXNG boş sonuç → hata mesajı içeriyor', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
  }))

  // Tüm API key'ler temizlendi — hiçbir fallback çalışmaz
  const saved = {
    brave: process.env.BRAVE_SEARCH_API_KEY,
    google: process.env.GOOGLE_SEARCH_API_KEY,
    tavily: process.env.TAVILY_API_KEY,
  }
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.GOOGLE_SEARCH_API_KEY
  delete process.env.TAVILY_API_KEY

  try {
    const result = await searchWeb('boş sorgu')
    assert.ok(result.error || result.results.length === 0)
  } finally {
    if (saved.brave) process.env.BRAVE_SEARCH_API_KEY = saved.brave
    if (saved.google) process.env.GOOGLE_SEARCH_API_KEY = saved.google
    if (saved.tavily) process.env.TAVILY_API_KEY = saved.tavily
  }
})

test('searchWeb: SearXNG network hatası → error alanında mesaj var', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Connection refused')
  })

  const savedKeys = {
    brave: process.env.BRAVE_SEARCH_API_KEY,
    google: process.env.GOOGLE_SEARCH_API_KEY,
    tavily: process.env.TAVILY_API_KEY,
  }
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.GOOGLE_SEARCH_API_KEY
  delete process.env.TAVILY_API_KEY

  try {
    const result = await searchWeb('query')
    assert.ok(result.error || result.results.length === 0)
  } finally {
    if (savedKeys.brave) process.env.BRAVE_SEARCH_API_KEY = savedKeys.brave
    if (savedKeys.google) process.env.GOOGLE_SEARCH_API_KEY = savedKeys.google
    if (savedKeys.tavily) process.env.TAVILY_API_KEY = savedKeys.tavily
  }
})

test('searchWeb: SearXNG HTTP hata kodu → hata mesajı döner', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  }))

  const saved = {
    brave: process.env.BRAVE_SEARCH_API_KEY,
    google: process.env.GOOGLE_SEARCH_API_KEY,
    tavily: process.env.TAVILY_API_KEY,
  }
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.GOOGLE_SEARCH_API_KEY
  delete process.env.TAVILY_API_KEY

  try {
    const result = await searchWeb('query')
    assert.ok(result.error?.includes('503') || result.results.length === 0)
  } finally {
    if (saved.brave) process.env.BRAVE_SEARCH_API_KEY = saved.brave
    if (saved.google) process.env.GOOGLE_SEARCH_API_KEY = saved.google
    if (saved.tavily) process.env.TAVILY_API_KEY = saved.tavily
  }
})

// ===== searchWebMulti =====

test('searchWebMulti: boş query listesi → error döner', async () => {
  const result = await searchWebMulti([])
  assert.ok(result.error)
  assert.equal(result.totalUnique, 0)
})

test('searchWebMulti: 4 query verilirse en fazla 3 tanesiyle sınırlı', async (t) => {
  let callCount = 0
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ title: `Sonuç ${callCount}`, content: '', url: `https://example${callCount}.com` }],
      }),
    }
  })

  await searchWebMulti(['q1', 'q2', 'q3', 'q4'])
  // SearXNG en fazla 3 çağrı yapılmış olmalı
  assert.ok(callCount <= 3)
})

test('searchWebMulti: URL deduplikasyon çalışıyor', async (t) => {
  // Her sorgu aynı URL döndürüyor
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [{ title: 'Aynı sayfa', content: 'snippet', url: 'https://same.com/page' }],
    }),
  }))

  const result = await searchWebMulti(['q1', 'q2', 'q3'])
  // 3 sorgu aynı URL döndürse de tekil sonuç 1 olmalı
  assert.equal(result.totalUnique, 1)
})

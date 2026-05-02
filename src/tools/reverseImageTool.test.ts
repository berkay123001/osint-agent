/**
 * Reverse Image Tool Test Suite
 * API key yoksa hata döner + fetch mock ile başarı/başarısızlık yolları
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { searchReverseImage, formatReverseImageResult } from './reverseImageTool.js'
import type { ReverseImageResult } from './reverseImageTool.js'

// ===== API Key Kontrolü =====

test('searchReverseImage: SERP_API_KEY yoksa hata döner', async () => {
  const saved = process.env.SERP_API_KEY
  delete process.env.SERP_API_KEY

  try {
    const result = await searchReverseImage('https://example.com/image.jpg')
    assert.ok(result.error?.includes('SERPAPI') || result.error?.includes('SERP') || result.error?.includes('not found'))
    assert.equal(result.totalMatches, 0)
    assert.equal(result.bestMatches.length, 0)
  } finally {
    if (saved) process.env.SERP_API_KEY = saved
  }
})

// ===== Fetch Mock — Başarılı Yanıt =====

test('searchReverseImage: API key ile başarılı yanıt işleniyor', async (t) => {
  process.env.SERP_API_KEY = 'test-key'

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      visual_matches: [
        { title: 'Orijinal fotoğraf', link: 'https://news.com/photo1', source: 'News Site', thumbnail: 'https://thumb.com/1.jpg' },
        { title: 'Başka kullanım', link: 'https://blog.com/photo2', source: 'Blog', thumbnail: 'https://thumb.com/2.jpg' },
        { title: 'Sosyal medya paylaşımı', link: 'https://twitter.com/photo3', source: 'Twitter', thumbnail: null },
      ],
    }),
  }))

  try {
    const result = await searchReverseImage('https://example.com/mystery.jpg')
    assert.equal(result.totalMatches, 3)
    assert.ok(result.bestMatches.length <= 5)
    assert.equal(result.bestMatches[0].title, 'Orijinal fotoğraf')
    assert.equal(result.bestMatches[0].link, 'https://news.com/photo1')
    assert.equal(result.bestMatches[0].source, 'News Site')
    assert.ok(!result.error)
  } finally {
    delete process.env.SERP_API_KEY
  }
})

test('searchReverseImage: SerpAPI error alanı döndürüyor', async (t) => {
  process.env.SERP_API_KEY = 'invalid-key'

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: 'Invalid API key' }),
  }))

  try {
    const result = await searchReverseImage('https://example.com/img.jpg')
    assert.ok(result.error?.includes('Invalid API key') || result.error?.includes('SerpApi'))
    assert.equal(result.totalMatches, 0)
  } finally {
    delete process.env.SERP_API_KEY
  }
})

test('searchReverseImage: fetch throws → request failed hatası', async (t) => {
  process.env.SERP_API_KEY = 'test-key'

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Connection timeout')
  })

  try {
    const result = await searchReverseImage('https://example.com/img.jpg')
    assert.ok(result.error?.includes('Request failed') || result.error?.includes('Connection'))
    assert.equal(result.totalMatches, 0)
  } finally {
    delete process.env.SERP_API_KEY
  }
})

test('searchReverseImage: boş visual_matches → 0 eşleşme', async (t) => {
  process.env.SERP_API_KEY = 'test-key'

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ visual_matches: [] }),
  }))

  try {
    const result = await searchReverseImage('https://example.com/new-image.jpg')
    assert.equal(result.totalMatches, 0)
    assert.equal(result.bestMatches.length, 0)
    assert.ok(!result.error)
  } finally {
    delete process.env.SERP_API_KEY
  }
})

// ===== formatReverseImageResult — Saf Fonksiyon =====

test('formatReverseImageResult: hata sonucu doğru formatlanıyor', () => {
  const result: ReverseImageResult = {
    imageUrl: 'https://example.com/img.jpg',
    totalMatches: 0,
    bestMatches: [],
    error: 'SerpAPI hatası',
  }
  const out = formatReverseImageResult(result)
  assert.ok(out.includes('❌') || out.includes('Error'))
  assert.ok(out.includes('SerpAPI hatası'))
})

test('formatReverseImageResult: eşleşme yok — bilgi mesajı', () => {
  const result: ReverseImageResult = {
    imageUrl: 'https://example.com/unique.jpg',
    totalMatches: 0,
    bestMatches: [],
  }
  const out = formatReverseImageResult(result)
  assert.ok(out.length > 0)
})

test('formatReverseImageResult: eşleşmeler listeleniyor', () => {
  const result: ReverseImageResult = {
    imageUrl: 'https://example.com/fake.jpg',
    totalMatches: 10,
    bestMatches: [
      { title: 'Gerçek kaynak', link: 'https://original.com', source: 'News' },
      { title: 'Sahte paylaşım', link: 'https://spam.com', source: 'Unknown' },
    ],
  }
  const out = formatReverseImageResult(result)
  assert.ok(out.includes('Gerçek kaynak') || out.includes('original.com'))
})

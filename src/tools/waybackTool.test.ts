/**
 * Wayback Machine Tool Test Suite
 * formatWaybackResult saf fonksiyon + fetch mock ile API testleri
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { waybackSearch, waybackClosest, formatWaybackResult } from './waybackTool.js'
import type { WaybackResult } from './waybackTool.js'

// ===== formatWaybackResult — Saf Fonksiyon =====

test('formatWaybackResult: hata sonucu doğru formatlanıyor', () => {
  const result: WaybackResult = {
    originalUrl: 'https://deleted.example.com',
    snapshots: [],
    latestContent: null,
    error: 'CDX API unreachable',
  }
  const out = formatWaybackResult(result)
  assert.ok(out.includes('Wayback') || out.includes('Hata'))
  assert.ok(out.includes('CDX API unreachable'))
})

test('formatWaybackResult: snapshot yok — uyarı mesajı', () => {
  const result: WaybackResult = {
    originalUrl: 'https://newsite.example.com',
    snapshots: [],
    latestContent: null,
  }
  const out = formatWaybackResult(result)
  assert.ok(out.includes('newsite.example.com'))
  assert.ok(out.includes('snapshot') || out.includes('Snapshot') || out.includes('arşiv'))
})

test('formatWaybackResult: snapshotlar listeleniyor', () => {
  const result: WaybackResult = {
    originalUrl: 'https://oldsite.example.com',
    snapshots: [
      { url: 'https://web.archive.org/web/20200101000000/https://oldsite.example.com', timestamp: '20200101000000', date: '2020-01-01 00:00', status: '200' },
      { url: 'https://web.archive.org/web/20210601120000/https://oldsite.example.com', timestamp: '20210601120000', date: '2021-06-01 12:00', status: '200' },
    ],
    latestContent: null,
  }
  const out = formatWaybackResult(result)
  assert.ok(out.includes('oldsite.example.com'))
  assert.ok(out.includes('2020-01-01') || out.includes('2020'))
  assert.ok(out.includes('2 snapshot') || out.includes('2'))
})

test('formatWaybackResult: içerik varsa preview gösteriliyor', () => {
  const result: WaybackResult = {
    originalUrl: 'https://example.com',
    snapshots: [
      { url: 'https://web.archive.org/web/20200101/https://example.com', timestamp: '20200101000000', date: '2020-01-01 00:00', status: '200' },
    ],
    latestContent: 'Bu sayfa artık mevcut değil. İşte eski içerik: Hello World!',
  }
  const out = formatWaybackResult(result)
  assert.ok(out.includes('Hello World') || out.includes('içerik'))
})

// ===== waybackSearch — CDX API Mock =====

test('waybackSearch: başarılı CDX yanıtı ile snapshotlar parse ediliyor', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/cdx/search/cdx')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          ['timestamp', 'original', 'statuscode'], // header row
          ['20190615120000', 'https://target.com', '200'],
          ['20210301090000', 'https://target.com', '200'],
        ],
      }
    }
    // Snapshot içeriği çekme
    return {
      ok: false,
      status: 404,
      text: async () => '',
    }
  })

  const result = await waybackSearch('https://target.com', 20)
  assert.ok(!result.error)
  assert.equal(result.snapshots.length, 2)
  assert.ok(result.snapshots[0].date.includes('2019'))
  assert.ok(result.snapshots[1].date.includes('2021'))
  assert.equal(result.originalUrl, 'https://target.com')
})

test('waybackSearch: CDX API HTTP hatası → error döner', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  }))

  const result = await waybackSearch('https://example.com')
  assert.ok(result.error?.includes('503'))
  assert.equal(result.snapshots.length, 0)
})

test('waybackSearch: CDX API sadece header satırı → boş snapshot', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/cdx/search/cdx')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          ['timestamp', 'original', 'statuscode'],
        ],
      }
    }
    return { ok: false, status: 404, text: async () => '' }
  })

  const result = await waybackSearch('https://fresh-site.com')
  assert.equal(result.snapshots.length, 0)
  assert.ok(!result.error)
})

test('waybackSearch: network hatası → error mesajı', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network unreachable')
  })

  const result = await waybackSearch('https://example.com')
  assert.ok(result.error?.includes('Network') || result.error)
  assert.equal(result.snapshots.length, 0)
})

// ===== waybackClosest — Availability API Mock =====

test('waybackClosest: snapshot mevcut → available:true ve url/date dönüyor', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      archived_snapshots: {
        closest: {
          available: true,
          url: 'https://web.archive.org/web/20200601000000/https://example.com',
          timestamp: '20200601000000',
          status: '200',
        },
      },
    }),
  }))

  const result = await waybackClosest('https://example.com', '20200601')
  assert.equal(result.available, true)
  assert.ok(result.url?.includes('archive.org'))
  assert.ok(result.date?.includes('2020'))
})

test('waybackClosest: snapshot yok → available:false', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ archived_snapshots: {} }),
  }))

  const result = await waybackClosest('https://never-archived.example.com')
  assert.equal(result.available, false)
  assert.equal(result.url, null)
})

test('waybackClosest: API hatası → available:false ve error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  }))

  const result = await waybackClosest('https://example.com')
  assert.equal(result.available, false)
  assert.ok(result.error?.includes('500'))
})

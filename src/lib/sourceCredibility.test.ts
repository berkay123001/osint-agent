import assert from 'node:assert/strict'
import test from 'node:test'
import { labelSource, formatSourceTag, extractRedditScore, formatSourceBadge } from './sourceCredibility.js'

// ── Resmi / referans kaynakları ─────────────────────────────────────

test('gov.tr domainleri "official-gov" olarak etiketlenir', () => {
  const r = labelSource('https://www.saglik.gov.tr/doktor-kayit')
  assert.equal(r.category, 'official-gov')
})

test('.edu domainleri "official-gov" olarak etiketlenir', () => {
  const r = labelSource('https://mit.edu/research')
  assert.equal(r.category, 'official-gov')
})

test('wikipedia "reference" olarak etiketlenir', () => {
  const r = labelSource('https://en.wikipedia.org/wiki/OSINT')
  assert.equal(r.category, 'reference')
})

test('archive.org "reference" olarak etiketlenir', () => {
  const r = labelSource('https://web.archive.org/web/20240101/example.com')
  assert.equal(r.category, 'reference')
})

// ── Teknoloji basını ─────────────────────────────────────────────────

test('techcrunch "tech-press" olarak etiketlenir', () => {
  const r = labelSource('https://techcrunch.com/2025/01/01/ai-tools/')
  assert.equal(r.category, 'tech-press')
})

// ── Topluluk (Reddit, HN, StackOverflow, ProductHunt) ───────────────

test('reddit.com "community" olarak etiketlenir', () => {
  const r = labelSource('https://www.reddit.com/r/OSINT/comments/abc123/great_tool/')
  assert.equal(r.category, 'community')
  assert.ok(r.label.includes('oy/yorum'))
})

test('old.reddit.com subdomain da "community" olarak etiketlenir', () => {
  const r = labelSource('https://old.reddit.com/r/privacy/')
  assert.equal(r.category, 'community')
})

test('news.ycombinator.com "community" olarak etiketlenir', () => {
  const r = labelSource('https://news.ycombinator.com/item?id=12345')
  assert.equal(r.category, 'community')
})

test('producthunt.com "community" olarak etiketlenir', () => {
  const r = labelSource('https://www.producthunt.com/posts/gamma')
  assert.equal(r.category, 'community')
})

test('stackoverflow.com "community" olarak etiketlenir', () => {
  const r = labelSource('https://stackoverflow.com/questions/12345/scraping-tool')
  assert.equal(r.category, 'community')
})

// ── Blog platformları ────────────────────────────────────────────────

test('medium.com "general-blog" olarak etiketlenir', () => {
  const r = labelSource('https://medium.com/data-science/best-free-tools')
  assert.equal(r.category, 'general-blog')
  assert.ok(r.label.includes('doğrulanmamış'))
})

test('dev.to "general-blog" olarak etiketlenir', () => {
  const r = labelSource('https://dev.to/user/post-title')
  assert.equal(r.category, 'general-blog')
})

// ── Ürün sayfası (çıkar çatışması) ──────────────────────────────────

test('slidespeak.co/blog "product-page" + çıkar çatışması uyarısı', () => {
  const r = labelSource('https://slidespeak.co/blog/top-6-tools')
  assert.equal(r.category, 'product-page')
  assert.equal(r.warning, 'çıkar çatışması')
})

test('gamma.app/pricing "product-page" olarak etiketlenir', () => {
  const r = labelSource('https://gamma.app/pricing')
  assert.equal(r.category, 'product-page')
})

// ── Genel web ────────────────────────────────────────────────────────

test('bilinmeyen domain "other" olarak etiketlenir', () => {
  const r = labelSource('https://random-site.io/page')
  assert.equal(r.category, 'other')
})

// ── formatSourceTag ──────────────────────────────────────────────────

test('formatSourceTag çıkar çatışmasında ⚠️ içerir', () => {
  const tag = formatSourceTag('https://slidespeak.co/blog/comparison')
  assert.ok(tag.includes('⚠️'))
  assert.ok(tag.includes('çıkar çatışması'))
})

test('formatSourceTag reddit için oy/yorum uyarısı içerir', () => {
  const tag = formatSourceTag('https://www.reddit.com/r/tools/comments/xyz/')
  assert.ok(tag.includes('community'))
  assert.ok(tag.includes('oy/yorum'))
})

// ── GitHub ───────────────────────────────────────────────────────────

test('github.com "code-platform" olarak etiketlenir', () => {
  const r = labelSource('https://github.com/berkay123001/osint-agent')
  assert.equal(r.category, 'code-platform')
})

// ── Geçersiz URL ─────────────────────────────────────────────────────

test('geçersiz URL "unknown" döner', () => {
  const r = labelSource('not a url')
  assert.equal(r.category, 'unknown')
})

// ── extractRedditScore ────────────────────────────────────────────────

test('extractRedditScore "842 points" → 842', () => {
  assert.equal(extractRedditScore('842 points in r/tools'), 842)
})

test('extractRedditScore "1.2k points" → 1200', () => {
  assert.equal(extractRedditScore('1.2k points and 300 comments'), 1200)
})

test('extractRedditScore snippet yoksa undefined', () => {
  assert.equal(extractRedditScore('no numbers here'), undefined)
})

// ── formatSourceBadge ─────────────────────────────────────────────────

test('formatSourceBadge: ürün blogu ⚠️ içerir', () => {
  const badge = formatSourceBadge('https://slidespeak.co/blog/top-tools')
  assert.ok(badge.includes('⚠️'))
  assert.ok(badge.includes('slidespeak.co'))
})

test('formatSourceBadge: reddit + snippet → oy sayısı içerir', () => {
  const badge = formatSourceBadge(
    'https://www.reddit.com/r/OSINT/comments/abc/',
    '312 points, 47 comments'
  )
  assert.ok(badge.includes('312'))
  assert.ok(badge.includes('oy'))
})

test('formatSourceBadge: reddit snippet yoksa oy sayısı rozeti olmaz', () => {
  const badge = formatSourceBadge('https://www.reddit.com/r/tools/comments/xyz/')
  // Label "oy/yorum" içerebilir ama "👥 NNN oy" formatında sayısal oy rozeti olmamalı
  assert.ok(!/ \d+ oy/.test(badge))
})

test('labelSource reddit communitySignal platform = Reddit', () => {
  const r = labelSource('https://reddit.com/r/tools/')
  assert.equal(r.communitySignal?.platform, 'Reddit')
})

test('labelSource HN communitySignal platform = Hacker News', () => {
  const r = labelSource('https://news.ycombinator.com/item?id=1')
  assert.equal(r.communitySignal?.platform, 'Hacker News')
})

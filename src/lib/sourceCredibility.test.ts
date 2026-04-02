import assert from 'node:assert/strict'
import test from 'node:test'
import { labelSource, formatSourceTag, extractRedditScore, formatSourceBadge, extractRedditDiscussionFromMarkdown, formatRedditDiscussion } from './sourceCredibility.js'

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

// ── extractRedditDiscussionFromMarkdown ────────────────────────────────

test('extractRedditDiscussionFromMarkdown: post score ve yorum çıkarma', () => {
  const md = [
    'r/LocalLLaMA • Posted by u/testuser • 842 points • 127 comments',
    '',
    'This is the post body about the free tool.',
    '',
    '---',
    '',
    'u/first_user • 156 points • 2 hours ago',
    '',
    'This tool works great, I highly recommend it. The free tier is genuinely free.',
    '',
    'u/second_user • 23 points • 1 hour ago',
    '',
    'Not true, they have hidden fees. I was charged after 7 days.',
    '',
    'u/third_user • 89 points • 45 minutes ago',
    '',
    'Note that the documentation says free for personal use only.',
  ].join('\n')

  const result = extractRedditDiscussionFromMarkdown(md)
  assert.ok(result, 'Sonuç null olmamalı')
  assert.equal(result!.postScore, 842)
  assert.ok(result!.topComments!.length >= 2, 'En az 2 yorum bulunmalı')
})

test('extractRedditDiscussionFromMarkdown: boş markdown null döner', () => {
  const result = extractRedditDiscussionFromMarkdown('')
  assert.equal(result, null)
})

test('extractRedditDiscussionFromMarkdown: kısa markdown null döner', () => {
  const result = extractRedditDiscussionFromMarkdown('short text')
  assert.equal(result, null)
})

test('extractRedditDiscussionFromMarkdown: fikir sınıflandırması çalışır', () => {
  const md = [
    'r/test • Posted by u/op • 100 points • 10 comments',
    '',
    'Post body here.',
    '',
    '---',
    '',
    'u/a • 50 points',
    '',
    'This is amazing, highly recommend it.',
    '',
    'u/b • 30 points',
    '',
    'Terrible experience, avoid this product. Doesn\'t work as advertised.',
    '',
    'u/c • 20 points',
    '',
    'Note that according to documentation, this is for personal use.',
  ].join('\n')

  const result = extractRedditDiscussionFromMarkdown(md)
  assert.ok(result, 'Sonuç null olmamalı')
  const ops = result!.opinionSummary
  assert.ok(ops, 'Fikir özeti olmalı')
  const hasAnyOpinion = ops!.supporting.length > 0 || ops!.opposing.length > 0 || ops!.neutral.length > 0
  assert.ok(hasAnyOpinion, 'En az bir fikir kategorisi dolu olmalı')
})

// ── formatRedditDiscussion ─────────────────────────────────────────────

test('formatRedditDiscussion: skor ve subreddit bilgisi içerir', () => {
  const discussion = {
    postScore: 1234,
    upvoteRatio: 0.92,
    commentCount: 56,
    subreddit: 'tools',
    topComments: [
      { author: 'alice', score: 42, body: 'Works great', controversial: false },
      { author: 'bob', score: -5, body: 'Not worth it', controversial: true },
    ],
    opinionSummary: {
      supporting: ['Works great'],
      opposing: ['Not worth it'],
      neutral: [],
    },
  }

  const formatted = formatRedditDiscussion(discussion)
  assert.ok(formatted.includes('Post skoru'), 'Post skoru etiketi görünmeli')
  assert.ok(/1.?234/.test(formatted), 'Post skoru değeri görünmeli (1,234 veya 1234)')
  assert.ok(formatted.includes('92'), 'Beğeni oranı görünmeli')
  assert.ok(formatted.includes('r/tools'), 'Subreddit görünmeli')
  assert.ok(formatted.includes('alice'), 'Yorumcu adı görünmeli')
})

test('formatRedditDiscussion: partial discussion da formatlanır', () => {
  const partial = {
    postScore: 50,
    topComments: [
      { author: 'user1', score: 10, body: 'Nice', controversial: false },
    ],
    opinionSummary: {
      supporting: [],
      opposing: [],
      neutral: ['Nice'],
    },
  }

  const formatted = formatRedditDiscussion(partial)
  assert.ok(formatted.includes('50'), 'Post skoru görünmeli')
})

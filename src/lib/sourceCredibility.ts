/**
 * Kaynak güvenilirlik etiketleme — saf fonksiyonlar.
 *
 * Sayısal skor yerine metin etiketleri üretir. LLM bu etiketleri
 * okuyarak kaynak güvenilirliğini kendi bağlamında değerlendirir.
 */

export interface SourceLabel {
  category: string
  label: string
  warning?: string
  communitySignal?: {
    platform: string
    score?: number
  }
}

// ── Tanımlanmış domain → kategori eşlemeleri ───────────────────────────

const OFFICIAL_DOMAINS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org',
])

const REFERENCE_DOMAINS = new Set([
  'wikipedia.org', 'en.wikipedia.org', 'tr.wikipedia.org',
  'archive.org', 'web.archive.org',
  'wikidata.org',
])

const TECH_PRESS_DOMAINS = new Set([
  'techcrunch.com', 'wired.com', 'arstechnica.com',
  'theverge.com', 'zdnet.com', 'bleepingcomputer.com',
  'hackernews.com', 'thenextweb.com',
])

const COMMUNITY_DOMAINS = new Set([
  'reddit.com', 'old.reddit.com', 'www.reddit.com',
  'stackexchange.com', 'stackoverflow.com',
  'superuser.com', 'serverfault.com',
  'news.ycombinator.com',
  'producthunt.com', 'www.producthunt.com',
  'alternativeto.com',
])

const BLOG_PLATFORMS = new Set([
  'medium.com', 'substack.com', 'dev.to',
  'hashnode.dev', 'blogger.com', 'wordpress.com',
  'ghost.io',
])

const GOV_EDU_SUFFIXES = ['.gov', '.edu', '.gov.tr', '.edu.tr', '.ac.uk', '.gov.uk']

// ── Ana fonksiyon ──────────────────────────────────────────────────────

export function labelSource(url: string): SourceLabel {
  let hostname: string
  let pathname: string
  try {
    const parsed = new URL(url)
    hostname = parsed.hostname.replace(/^www\./, '')
    pathname = parsed.pathname.toLowerCase()
  } catch {
    return { category: 'unknown', label: 'Bilinmeyen kaynak' }
  }

  // .gov / .edu — resmi kurum
  if (GOV_EDU_SUFFIXES.some(s => hostname.endsWith(s))) {
    return { category: 'official-gov', label: 'Resmi kurum sitesi (.gov/.edu)' }
  }

  // Bilinen referans kaynakları
  if (matchDomain(hostname, REFERENCE_DOMAINS)) {
    return { category: 'reference', label: 'Referans kaynağı (ansiklopedi/arşiv)' }
  }

  // Teknoloji basını
  if (matchDomain(hostname, TECH_PRESS_DOMAINS)) {
    return { category: 'tech-press', label: 'Teknoloji basını' }
  }

  // GitHub/GitLab gibi kod platformları
  if (matchDomain(hostname, OFFICIAL_DOMAINS)) {
    return { category: 'code-platform', label: 'Kod platformu' }
  }

  // Topluluk platformları (Reddit, HN, ProductHunt, StackOverflow)
  if (matchDomain(hostname, COMMUNITY_DOMAINS)) {
    const isReddit = hostname === 'reddit.com' || hostname.endsWith('.reddit.com')
    const platform = isReddit ? 'Reddit' : hostname === 'news.ycombinator.com' ? 'Hacker News' : 'Topluluk'
    return {
      category: 'community',
      label: 'Topluluk tartışması — oy/yorum sayısına dikkat et, yüksek ilgi = güçlü sinyal',
      communitySignal: { platform },
    }
  }

  // Blog platformları (Medium, Substack, dev.to)
  if (matchDomain(hostname, BLOG_PLATFORMS)) {
    return {
      category: 'general-blog',
      label: 'Genel blog platformu — yazar uzmanlığı doğrulanmamış',
    }
  }

  // Ürünün kendi sitesi + /blog veya /pricing sayfası
  if (pathname.includes('/blog') || pathname.includes('/pricing') || pathname.includes('/features')) {
    return {
      category: 'product-page',
      label: 'Ürünün kendi sayfası — vendör iddiası, bağımsız doğrulama gerekir',
      warning: 'çıkar çatışması',
    }
  }

  return { category: 'other', label: 'Genel web kaynağı' }
}

/**
 * Reddit snippet'inden topluluk skoru çıkar.
 * "1.2k points", "842 upvotes" gibi ifadeleri yakalar.
 */
export function extractRedditScore(snippet: string): number | undefined {
  const patterns = [
    /(\d[\d,.]*k?)\s*points?/i,
    /(\d[\d,.]*k?)\s*upvotes?/i,
    /(\d[\d,.]*k?)\s*votes?/i,
  ]
  for (const p of patterns) {
    const m = p.exec(snippet)
    if (m) {
      const raw = m[1].replace(/,/g, '')
      const isK = raw.toLowerCase().endsWith('k')
      const n = parseFloat(isK ? raw.slice(0, -1) : raw)
      if (!isNaN(n)) return isK ? Math.round(n * 1000) : Math.round(n)
    }
  }
  return undefined
}

/**
 * Arama sonucu satırına eklenmek üzere kısa etiket metni döndürür.
 * snippet opsiyonel — reddit topluluk skorunu çıkarmak için kullanılır.
 */
export function formatSourceBadge(url: string, snippet?: string): string {
  const src = labelSource(url)
  let hostname: string
  try { hostname = new URL(url).hostname.replace(/^www\./, '') } catch { hostname = url }

  let badge = `[KAYNAK: ${src.label} | ${hostname}]`
  if (src.warning) badge += ` ⚠️ ${src.warning}`

  if (src.communitySignal) {
    const isReddit = hostname === 'reddit.com' || hostname.endsWith('.reddit.com')
    if (isReddit && snippet) {
      const score = extractRedditScore(snippet)
      if (score !== undefined) badge += ` 👥 ${score.toLocaleString()} oy`
    }
  }

  return badge
}

/** Eski format: [KAYNAK: category] label — geriye dönük uyumluluk */
export function formatSourceTag(url: string): string {
  const { category, label, warning } = labelSource(url)
  const warn = warning ? ` ⚠️ ${warning}` : ''
  return `[KAYNAK: ${category}${warn}] ${label}`
}

/** Alias: classifySource → labelSource */
export const classifySource = labelSource

// ── Reddit Tartışma Analizi ─────────────────────────────────────────────

export interface RedditComment {
  author: string
  score: number
  body: string
  controversial: boolean    // score 0'a yakın veya negatif
  replies?: RedditComment[]
}

export interface RedditDiscussion {
  postScore: number
  upvoteRatio?: number
  commentCount: number
  subreddit: string
  topComments: RedditComment[]
  /** Yorumlardan çıkarılan fikir akımları */
  opinionSummary: {
    supporting: string[]     // iddiayı destekleyen yorum özetleri
    opposing: string[]       // karşı çıkan yorum özetleri
    neutral: string[]        // tarafsız / bilgi veren yorumlar
  }
}

/**
 * Reddit JSON API üzerinden yapılandırılmış tartışma verisi çeker.
 * URL'nin sonuna .json ekleyerek Reddit'in public API'sini kullanır.
 * Auth gerektirmez, sadece User-Agent header yeterli.
 */
export async function fetchRedditDiscussion(url: string): Promise<RedditDiscussion | null> {
  // Normalize URL → .json endpoint
  const jsonUrl = normalizeRedditJsonUrl(url)
  if (!jsonUrl) return null

  try {
    const response = await fetch(jsonUrl, {
      headers: {
        'User-Agent': 'OSINT-Research-Bot/1.0 (analysis tool)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) return null

    const data = await response.json() as any[]
    if (!Array.isArray(data) || data.length < 2) return null

    // data[0] = post listing, data[1] = comments listing
    const postData = data[0]?.data?.children?.[0]?.data
    const commentsData = data[1]?.data?.children ?? []

    if (!postData) return null

    const postScore = postData.score ?? 0
    const upvoteRatio = postData.upvote_ratio
    const commentCount = postData.num_comments ?? 0
    const subreddit = postData.subreddit ?? ''

    // İlk 10 üst düzey yorumu parse et
    const topComments: RedditComment[] = []
    for (const child of commentsData.slice(0, 10)) {
      if (child.kind === 't1' && child.data) {
        const comment = parseRedditComment(child.data, 1)
        if (comment) topComments.push(comment)
      }
    }

    // Fikir akımlarını sınıflandır
    const opinionSummary = classifyOpinions(topComments)

    return {
      postScore,
      upvoteRatio,
      commentCount,
      subreddit,
      topComments,
      opinionSummary,
    }
  } catch {
    return null
  }
}

/**
 * Scrape edilmiş Reddit Markdown'ından tartışma verisi çıkarır.
 * JSON API başarısız olursa fallback olarak kullanılır.
 */
export function extractRedditDiscussionFromMarkdown(markdown: string): Partial<RedditDiscussion> | null {
  if (!markdown || markdown.length < 50) return null

  // Post skoru: "1.2k points", "842 upvotes", "score: 123"
  const postScore = extractRedditScore(markdown) ?? 0

  // Yorum skorlarını çıkar: "score: 42", "[+42]", "42 points"
  const commentScorePattern = /(?:score:\s*|(?<=\]\s))(-?\d[\d,.]*k?)\s*(?:points?|upvotes?)/gi
  const commentScores: number[] = []
  let match: RegExpExecArray | null
  while ((match = commentScorePattern.exec(markdown)) !== null) {
    const raw = match[1].replace(/,/g, '')
    const isK = raw.toLowerCase().endsWith('k')
    const n = parseFloat(isK ? raw.slice(0, -1) : raw)
    if (!isNaN(n)) commentScores.push(isK ? Math.round(n * 1000) : Math.round(n))
  }

  // Yorumları ayır — boş satırlarla ayrılmış bloklar
  const blocks = markdown.split(/\n{2,}/).filter(b => b.trim().length > 20)
  const topComments: RedditComment[] = blocks.slice(0, 10).map((block, i) => ({
    author: extractAuthorFromBlock(block) ?? `user_${i}`,
    score: commentScores[i] ?? 0,
    body: block.slice(0, 500).trim(),
    controversial: commentScores[i] !== undefined && commentScores[i] <= 1,
  }))

  const opinionSummary = classifyOpinions(topComments)

  return {
    postScore,
    commentCount: topComments.length,
    topComments,
    opinionSummary,
  }
}

/**
 * Reddit Discussion verisini LLM'e sunulacak formata çevirir.
 * verifyClaim ve arama sonuçlarında kullanılır.
 */
export function formatRedditDiscussion(discussion: RedditDiscussion | Partial<RedditDiscussion>): string {
  const lines: string[] = []

  if (discussion.postScore !== undefined && discussion.postScore > 0) {
    lines.push(`📊 Post skoru: ${discussion.postScore.toLocaleString()} oy`)
  }
  if (discussion.upvoteRatio !== undefined) {
    const pct = Math.round(discussion.upvoteRatio * 100)
    lines.push(`👍 Beğeni oranı: %${pct}`)
  }
  if (discussion.commentCount) {
    lines.push(`💬 Yorum sayısı: ${discussion.commentCount}`)
  }
  if (discussion.subreddit) {
    lines.push(`📌 Subreddit: r/${discussion.subreddit}`)
  }

  const ops = discussion.opinionSummary
  if (ops) {
    if (ops.supporting.length > 0) {
      lines.push(`\n✅ Destekleyen görüşler (${ops.supporting.length}):`)
      ops.supporting.forEach(s => lines.push(`   • ${s}`))
    }
    if (ops.opposing.length > 0) {
      lines.push(`\n❌ Karşı görüşler (${ops.opposing.length}):`)
      ops.opposing.forEach(s => lines.push(`   • ${s}`))
    }
    if (ops.neutral.length > 0) {
      lines.push(`\nℹ️ Bilgi veren yorumlar (${ops.neutral.length}):`)
      ops.neutral.slice(0, 3).forEach(s => lines.push(`   • ${s}`))
    }
  }

  // En yüksek skorlu yorumlar
  if (discussion.topComments && discussion.topComments.length > 0) {
    const top3 = [...discussion.topComments]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    lines.push(`\n🏆 En yüksek skorlu yorumlar:`)
    for (const c of top3) {
      const preview = c.body.slice(0, 150).replace(/\n/g, ' ')
      lines.push(`   [${c.score} oy] u/${c.author}: "${preview}${c.body.length > 150 ? '...' : ''}"`)
    }
  }

  return lines.join('\n')
}

// ── Yardımcı (private) ───────────────────────────────────────────────

/**
 * URL'yi Reddit JSON API endpoint'ine çevirir.
 * https://reddit.com/r/sub/comments/abc123/title/ → .../title/.json?limit=10
 */
function normalizeRedditJsonUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^www\./, '')

    if (hostname !== 'reddit.com' && hostname !== 'old.reddit.com') return null

    let pathname = parsed.pathname.replace(/\/+$/, '')
    // Zaten .json ise kaldır
    if (pathname.endsWith('.json')) pathname = pathname.slice(0, -5)

    return `https://www.reddit.com${pathname}.json?limit=10&sort=top&threaded=false`
  } catch {
    return null
  }
}

function parseRedditComment(data: any, depth: number): RedditComment | null {
  if (!data || typeof data.body !== 'string') return null

  const comment: RedditComment = {
    author: data.author ?? '[silindi]',
    score: data.score ?? 0,
    body: data.body.slice(0, 500),
    controversial: (data.score ?? 0) <= 1 && data.score !== undefined,
  }

  // İlk 2 derinliğe kadar yanıtları da al
  if (depth < 2 && data.replies?.data?.children) {
    comment.replies = data.replies.data.children
      .filter((c: any) => c.kind === 't1' && c.data)
      .slice(0, 3)
      .map((c: any) => parseRedditComment(c.data, depth + 1))
      .filter(Boolean) as RedditComment[]
  }

  return comment
}

/**
 * Basit kural tabanlı fikir sınıflandırma.
 * LLM zaten yorumları kendi bağlamında değerlendirecek —
 * burada sadece ham gruplama yapıyoruz.
 */
function classifyOpinions(comments: RedditComment[]): RedditDiscussion['opinionSummary'] {
  const supporting: string[] = []
  const opposing: string[] = []
  const neutral: string[] = []

  const POSITIVE_WORDS = [
    'works great', 'highly recommend', 'love it', 'amazing', 'best',
    'fantastic', 'excellent', 'does exactly', 'confirmed', 'yes',
    'agreed', 'this is true', 'can confirm', 'second this',
    'harika', 'mükemmel', 'çok iyi', 'kesinlikle', 'tavsiye',
  ]
  const NEGATIVE_WORDS = [
    'not true', 'wrong', 'misleading', 'scam', 'avoid',
    "doesn't work", 'terrible', 'worst', 'disappointed',
    'overpriced', 'hidden fees', 'bait and switch', 'no it is not',
    'yanlış', 'kötü', 'çalışmıyor', 'dolandırıc', 'kaçının',
  ]
  const INFO_WORDS = [
    'note that', 'fyi', 'according to', 'documentation',
    'you can also', 'alternative', 'instead', 'compare',
    'not necessarily', 'depends on', 'context',
    'alternatif', 'bağlı', 'duruma göre',
  ]

  for (const c of comments) {
    const text = c.body.toLowerCase()
    const summary = summarizeComment(c)

    if (!summary) continue

    const hasPos = POSITIVE_WORDS.some(w => text.includes(w))
    const hasNeg = NEGATIVE_WORDS.some(w => text.includes(w))
    const hasInfo = INFO_WORDS.some(w => text.includes(w))

    if (hasNeg && !hasPos) {
      opposing.push(summary)
    } else if (hasPos && !hasNeg) {
      supporting.push(summary)
    } else if (hasInfo) {
      neutral.push(summary)
    } else if (c.score >= 10) {
      // Yüksek skorlu yorumlar bilgi verme eğilimli
      neutral.push(summary)
    }
  }

  return { supporting, opposing, neutral }
}

/**
 * Tek bir yorumu kısa özet haline getirir.
 */
function summarizeComment(comment: RedditComment): string {
  const body = comment.body.replace(/\n+/g, ' ').trim()
  if (body.length <= 150) return body

  // İlk cümleyi al
  const firstSentence = body.match(/^[^.!?]*[.!?]/)?.[0]
  if (firstSentence && firstSentence.length <= 150) return firstSentence

  return body.slice(0, 147) + '...'
}

/**
 * Markdown bloğundan kullanıcı adı çıkarmaya çalışır.
 */
function extractAuthorFromBlock(block: string): string | null {
  const patterns = [
    /u\/([a-zA-Z0-9_-]{3,20})/,
    /\/user\/([a-zA-Z0-9_-]{3,20})/,
    /by\s+([a-zA-Z0-9_-]{3,20})/,
  ]
  for (const p of patterns) {
    const m = p.exec(block)
    if (m) return m[1]
  }
  return null
}

// ── Yardımcı ───────────────────────────────────────────────────────────

function matchDomain(hostname: string, set: Set<string>): boolean {
  if (set.has(hostname)) return true
  // subdomain: "old.reddit.com" → "reddit.com"
  const parts = hostname.split('.')
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.')
    if (set.has(parent)) return true
  }
  return false
}

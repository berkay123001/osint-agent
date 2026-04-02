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

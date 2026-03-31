export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchToolResponse {
  query: string;
  results: SearchResult[];
  error?: string;
  provider?: string;
}

/**
 * SearXNG (self-hosted metasearch engine) üzerinden web araması yapar.
 * 100+ arama motorunu aggregate eder, API key gerektirmez.
 * Docker ile localhost:8888'de çalışır — çalışmıyorsa sessizce Brave'e düşer.
 */
async function searchSearXNG(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const baseUrl = process.env.SEARXNG_URL || 'http://localhost:8888'
  try {
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=all`
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      return { query, results: [], error: `SearXNG HTTP ${response.status}` }
    }
    const data = await response.json()
    const rawResults: any[] = data?.results ?? []
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      return { query, results: [], error: 'SearXNG sonuç döndürmedi.' }
    }
    const results: SearchResult[] = rawResults.slice(0, limit).map((r: any) => ({
      title: r.title || 'Başlıksız',
      snippet: (r.content || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
      url: r.url || '',
    }))
    return { query, results, provider: 'SearXNG' }
  } catch (error) {
    return { query, results: [], error: `SearXNG erişilemiyor: ${(error as Error).message}` }
  }
}

/**
 * Brave Search saat basında 1 req/sn sınırı var (Free plan).
 * Eş zamanlı çağrılarda 429 almamak için global throttle.
 */
let _lastBraveCallAt = 0
const BRAVE_MIN_INTERVAL_MS = 1100 // 1.1s — free plan: 1 req/sec

async function throttleBrave(): Promise<void> {
  const now = Date.now()
  const wait = BRAVE_MIN_INTERVAL_MS - (now - _lastBraveCallAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _lastBraveCallAt = Date.now()
}

/**
 * Brave Search API üzerinden web araması yapar.
 */
async function searchBrave(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) {
    return { query, results: [], error: 'BRAVE_SEARCH_API_KEY tanımlı değil.' }
  }

  await throttleBrave()

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      }
    })

    if (!response.ok) {
      const errText = await response.text()
      return { query, results: [], error: `Brave API hatası (HTTP ${response.status}): ${errText}` }
    }

    const data = await response.json()
    const webResults = data?.web?.results ?? []

    if (!Array.isArray(webResults) || webResults.length === 0) {
      return { query, results: [], error: 'Brave API sonuç döndürmedi.' }
    }

    const results: SearchResult[] = webResults.map((r: any) => ({
      title: r.title || 'Başlıksız',
      snippet: (r.description || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
      url: r.url || ''
    }))

    return { query, results, provider: 'Brave Search' }
  } catch (error) {
    return { query, results: [], error: `Brave arama hatası: ${(error as Error).message}` }
  }
}

/**
 * Tavily API üzerinden web araması yapar.
 * Yapay zeka ajanları için optimize edilmiş gelişmiş arama sonuçları döndürür.
 */
async function searchTavily(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    return { query, results: [], error: 'TAVILY_API_KEY .env dosyasında tanımlı değil.' }
  }
  
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: 'advanced',
        max_results: limit,
        include_answer: false,
        include_images: false,
        include_raw_content: false
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { query, results: [], error: `Tavily API hatası (HTTP ${response.status}): ${errText}` };
    }

    const data = await response.json();
    
    if (!data.results || !Array.isArray(data.results)) {
      return { query, results: [], error: 'Tavily API beklenmeyen bir format döndürdü.' };
    }

    const results: SearchResult[] = data.results.map((r: any) => ({
      title: r.title || 'Başlıksız',
      snippet: (r.content || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
      url: r.url || ''
    }));

    return { query, results, provider: 'Tavily' };
  } catch (error) {
    return { query, results: [], error: `Tavily arama hatası: ${(error as Error).message}` };
  }
}

/**
 * Google Custom Search API üzerinden web araması yapar.
 * GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX (.env) gereklidir.
 * Ücretsiz limit: 100 sorgu/gün. Ücretli: $5/1000 sorgu.
 */
async function searchGoogle(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY
  const cx = process.env.GOOGLE_SEARCH_CX
  if (!apiKey || !cx) {
    return { query, results: [], error: 'GOOGLE_SEARCH_API_KEY veya GOOGLE_SEARCH_CX tanımlı değil.' }
  }

  try {
    // Google CSE max 10 sonuç döndürür — limit>10 ise iki istek at
    const fetchPage = async (start: number, num: number): Promise<any[]> => {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(num, 10)}&start=${start}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error(`Google CSE HTTP 429: Günlük kota doldu`)
        }
        const err = await res.text()
        // Uzun JSON hata gövdesini kısalt — sadece status kodu yeterli
        throw new Error(`Google CSE HTTP ${res.status}: ${err.slice(0, 120)}`)
      }
      const data = await res.json()
      return data?.items ?? []
    }

    let items: any[] = await fetchPage(1, Math.min(limit, 10))
    if (limit > 10 && items.length === 10) {
      const page2 = await fetchPage(11, limit - 10).catch(() => [])
      items = [...items, ...page2]
    }

    if (items.length === 0) {
      return { query, results: [], error: 'Google CSE sonuç döndürmedi.' }
    }

    const results: SearchResult[] = items.map((r: any) => ({
      title: r.title || 'Başlıksız',
      snippet: (r.snippet || '').replace(/\n+/g, ' ').trim().slice(0, 400),
      url: r.link || '',
    }))

    return { query, results, provider: 'Google Search' }
  } catch (error) {
    return { query, results: [], error: `Google CSE hatası: ${(error as Error).message}` }
  }
}

/**
 * Brave'in zayıf olduğu sorgu tipleri — doğrudan Google/Tavily'ye git.
 * - site:x.com / site:twitter.com — Brave sosyal medyayı indekslemiyor
 * - site:instagram.com, site:linkedin.com — aynı durum
 * - site:reddit.com — kısmi destek
 */
const BRAVE_WEAK_PATTERNS = [
  /\bsite:(x\.com|twitter\.com|instagram\.com|linkedin\.com|reddit\.com|facebook\.com)\b/i,
]

function braveIsWeak(query: string): boolean {
  return BRAVE_WEAK_PATTERNS.some(p => p.test(query))
}

/**
 * Çok katmanlı arama zinciri:
 *   SearXNG (self-hosted) → Brave → Google CSE → Tavily
 *
 * - SearXNG: self-hosted metasearch, 100+ motor, sıfır limit, API key gereksiz
 * - Brave: hız ve genel web için ikincil
 * - Google CSE: büyük index, güvenilir kapsama alanı
 * - Tavily: son çare (kredi koruması)
 */
export async function searchWeb(query: string, limit: number = 10): Promise<SearchToolResponse> {
  // 0) SearXNG (self-hosted, API key gerektirmez) — çalışmıyorsa anında düşer
  {
    const searxngResult = await searchSearXNG(query, limit)
    if (!searxngResult.error && searxngResult.results.length > 0) {
      return searxngResult
    }
    console.warn(`[SearchTool] SearXNG: ${searxngResult.error ?? 'sonuç yok'} — Brave'e geçiliyor...`)
  }

  // 1) Brave Search (secondary) — Brave'in zayıf olduğu sosyal medya sorgularında atla
  if (process.env.BRAVE_SEARCH_API_KEY && !braveIsWeak(query)) {
    const braveResult = await searchBrave(query, limit)
    if (!braveResult.error && braveResult.results.length > 0) {
      return braveResult
    }
    const reason = braveResult.error?.includes('429') ? '429 rate limit' : 'index eksik / sonuç yok'
    console.warn(`[SearchTool] Brave: ${reason} — Google CSE'ye geçiliyor...`)
  }

  // 2) Google Custom Search (tertiary) — büyük index, güvenilir kapsama alanı
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    const googleResult = await searchGoogle(query, limit)
    if (!googleResult.error && googleResult.results.length > 0) {
      return googleResult
    }
    console.warn(`[SearchTool] Google CSE: ${googleResult.error ?? 'sonuç yok'} — Tavily'ye geçiliyor...`)
  }

  // 3) Tavily (son çare — kredi koruması)
  if (process.env.TAVILY_API_KEY) {
    return await searchTavily(query, limit)
  }

  return {
    query,
    results: [],
    error: 'Arama API anahtarı bulunamadı. SEARXNG_URL, BRAVE_SEARCH_API_KEY, GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX veya TAVILY_API_KEY .env\'e ekleyin.',
  }
}

export function formatSearchResult(response: SearchToolResponse): string {
  if (response.error) {
    return `❌ Arama hatası: ${response.error}`;
  }

  if (response.results.length === 0) {
    return `🔍 "${response.query}" için sonuç bulunamadı.`;
  }

  const provider = response.provider ?? 'Web Arama'
  const lines = [
    `🔍 Web Arama Sonuçları (${provider}): "${response.query}"`,
    `Bulunan: ${response.results.length} sonuç.`,
    ``,
    `⚠️ SİSTEM NOTU: Bu sonuçları doğrudan %100 doğru kabul etmeyin. Hedefin bilinen diğer bilgileriyle (email, username vb.) kesişen (cross-validate) sonuçlara odaklanın.`,
    ``
  ];

  response.results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   URL: ${r.url}`);
    lines.push(`   Özet: ${r.snippet}`);
    lines.push('');
  });

  return lines.join('\n');
}

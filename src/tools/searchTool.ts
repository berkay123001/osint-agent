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
 * Brave'in zayıf olduğu sorgu tipleri — doğrudan Tavily'ye git.
 * - site:x.com / site:twitter.com — Brave sosyal medyayı indekslemiyor
 * - site:instagram.com, site:linkedin.com — aynı durum
 * - site:reddit.com — kısmi destek, Tavily daha iyi
 */
const TAVILY_PREFERRED_PATTERNS = [
  /\bsite:(x\.com|twitter\.com|instagram\.com|linkedin\.com|reddit\.com|facebook\.com)\b/i,
]

function preferTavily(query: string): boolean {
  return TAVILY_PREFERRED_PATTERNS.some(p => p.test(query))
}

/**
 * Brave Search öncelikli (Tavily fallback) web araması.
 * Her iki API anahtarı da yoksa hata döndürür.
 */
export async function searchWeb(query: string, limit: number = 10): Promise<SearchToolResponse> {
  // Bazı sorgu tipleri için direkt Tavily (Brave bu alanlarda zayıf)
  if (process.env.TAVILY_API_KEY && preferTavily(query)) {
    return await searchTavily(query, limit)
  }

  // 1) Brave Search (primary)
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const braveResult = await searchBrave(query, limit)
    if (!braveResult.error && braveResult.results.length > 0) {
      return braveResult
    }
    // Brave 0 sonuç veya hata — Tavily'ye geç
    const reason = braveResult.error?.includes('429')
      ? `429 rate limit`
      : `sonuç bulunamadı (Brave index'i küçük)`
    console.warn(`[SearchTool] Brave: ${reason} — Tavily'ye geçiliyor...`)
  }

  // 2) Tavily (fallback)
  if (process.env.TAVILY_API_KEY) {
    return await searchTavily(query, limit)
  }

  return { query, results: [], error: 'Arama API anahtarı bulunamadı. BRAVE_SEARCH_API_KEY veya TAVILY_API_KEY .env\'e ekleyin.' }
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

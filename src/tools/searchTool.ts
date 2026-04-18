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

import { emitProgress } from '../lib/progressEmitter.js'

/**
 * Performs a web search via SearXNG (self-hosted metasearch engine).
 * Aggregates 100+ search engines, no API key required.
 * Runs via Docker at localhost:8888 — silently falls through to Brave if unavailable.
 */
async function searchSearXNG(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const baseUrl = process.env.SEARXNG_URL || 'http://localhost:8888'
  try {
    // explicitly include mojeek and yep: lower bot protection, supports quoted queries
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=all&engines=mojeek,yep,aol,google,bing,brave`
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
      // Quoted queries can return 0 results on some SearXNG engines (e.g. AOL).
      // Retry without quotes.
      const hasQuotes = query.includes('"')
      if (hasQuotes) {
        const unquoted = query.replace(/"/g, '')
        const retryUrl = `${baseUrl}/search?q=${encodeURIComponent(unquoted)}&format=json&categories=general&language=all`
        const retryResp = await fetch(retryUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        })
        if (retryResp.ok) {
          const retryData = await retryResp.json()
          const retryResults: any[] = retryData?.results ?? []
          if (Array.isArray(retryResults) && retryResults.length > 0) {
            const results: SearchResult[] = retryResults.slice(0, limit).map((r: any) => ({
              title: r.title || 'Untitled',
              snippet: (r.content || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
              url: r.url || '',
            }))
            return { query, results, provider: 'SearXNG' }
          }
        }
      }
      return { query, results: [], error: 'SearXNG returned no results.' }
    }
    const results: SearchResult[] = rawResults.slice(0, limit).map((r: any) => ({
      title: r.title || 'Untitled',
      snippet: (r.content || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
      url: r.url || '',
    }))
    return { query, results, provider: 'SearXNG' }
  } catch (error) {
    return { query, results: [], error: `SearXNG unreachable: ${(error as Error).message}` }
  }
}

/**
 * Brave Search has a 1 req/s rate limit (Free plan).
 * Global throttle to avoid 429s on concurrent calls.
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
 * Performs a web search via the Brave Search API.
 */
async function searchBrave(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) {
    return { query, results: [], error: 'BRAVE_SEARCH_API_KEY is not defined.' }
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
      return { query, results: [], error: `Brave API error (HTTP ${response.status}): ${errText}` }
    }

    const data = await response.json()
    const webResults = data?.web?.results ?? []

    if (!Array.isArray(webResults) || webResults.length === 0) {
      return { query, results: [], error: 'Brave API returned no results.' }
    }

    const results: SearchResult[] = webResults.map((r: any) => ({
      title: r.title || 'Untitled',
      snippet: (r.description || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
      url: r.url || ''
    }))

    return { query, results, provider: 'Brave Search' }
  } catch (error) {
    return { query, results: [], error: `Brave search error: ${(error as Error).message}` }
  }
}

/**
 * Performs a web search via the Tavily API.
 * Returns advanced search results optimised for AI agents.
 */
async function searchTavily(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    return { query, results: [], error: 'TAVILY_API_KEY is not defined in .env.' }
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
      return { query, results: [], error: `Tavily API error (HTTP ${response.status}): ${errText}` };
    }

    const data = await response.json();
    
    if (!data.results || !Array.isArray(data.results)) {
      return { query, results: [], error: 'Tavily API returned an unexpected format.' };
    }

    const results: SearchResult[] = data.results.map((r: any) => ({
      title: r.title || 'Untitled',
      snippet: (r.content || '').slice(0, 400).replace(/\n+/g, ' ').trim(),
      url: r.url || ''
    }));

    return { query, results, provider: 'Tavily' };
  } catch (error) {
    return { query, results: [], error: `Tavily search error: ${(error as Error).message}` };
  }
}

/**
 * Performs a web search via the Google Custom Search API.
 * Requires GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX in .env.
 * Free quota: 100 queries/day. Paid: $5/1000 queries.
 */
async function searchGoogle(query: string, limit: number = 10): Promise<SearchToolResponse> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY
  const cx = process.env.GOOGLE_SEARCH_CX
  if (!apiKey || !cx) {
    return { query, results: [], error: 'GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX is not defined.' }
  }

  try {
    // Google CSE returns max 10 results — issue two requests if limit > 10
    const fetchPage = async (start: number, num: number): Promise<any[]> => {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(num, 10)}&start=${start}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error(`Google CSE HTTP 429: Daily quota exceeded`)
        }
        const err = await res.text()
        // Truncate long JSON error body — status code is enough
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
      return { query, results: [], error: 'Google CSE returned no results.' }
    }

    const results: SearchResult[] = items.map((r: any) => ({
      title: r.title || 'Untitled',
      snippet: (r.snippet || '').replace(/\n+/g, ' ').trim().slice(0, 400),
      url: r.link || '',
    }))

    return { query, results, provider: 'Google Search' }
  } catch (error) {
    return { query, results: [], error: `Google CSE error: ${(error as Error).message}` }
  }
}

/**
 * Query types where Brave is weak — go directly to Google/Tavily.
 * - site:x.com / site:twitter.com — Brave does not index social media
 * - site:instagram.com, site:linkedin.com — same situation
 * - site:reddit.com — partial support
 */
const BRAVE_WEAK_PATTERNS = [
  /\bsite:(x\.com|twitter\.com|instagram\.com|linkedin\.com|reddit\.com|facebook\.com)\b/i,
]

function braveIsWeak(query: string): boolean {
  return BRAVE_WEAK_PATTERNS.some(p => p.test(query))
}

/**
 * Multi-tier search chain:
 *   SearXNG (self-hosted) → Brave → Google CSE → Tavily
 *
 * - SearXNG: self-hosted metasearch, 100+ engines, zero quota, no API key
 * - Brave: secondary for speed and general web
 * - Google CSE: large index, reliable coverage
 * - Tavily: last resort (API credit conservation)
 */
export async function searchWeb(query: string, limit: number = 10): Promise<SearchToolResponse> {
  // 0) SearXNG (self-hosted, no API key required) — falls through instantly if unavailable
  {
    const searxngResult = await searchSearXNG(query, limit)
    if (!searxngResult.error && searxngResult.results.length > 0) {
      return searxngResult
    }
    emitProgress(`[SearchTool] SearXNG: ${searxngResult.error ?? 'no results'} → falling back to Brave...`)
  }

  // 1) Brave Search (secondary) — skip for social media queries where Brave is weak
  if (process.env.BRAVE_SEARCH_API_KEY && !braveIsWeak(query)) {
    const braveResult = await searchBrave(query, limit)
    if (!braveResult.error && braveResult.results.length > 0) {
      return braveResult
    }
    const reason = braveResult.error?.includes('429') ? '429 rate limit' : 'no index / no results'
    emitProgress(`[SearchTool] Brave: ${reason} → falling back to Google CSE...`)
  }

  // 2) Google Custom Search (tertiary) — large index, reliable coverage
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    const googleResult = await searchGoogle(query, limit)
    if (!googleResult.error && googleResult.results.length > 0) {
      return googleResult
    }
    emitProgress(`[SearchTool] Google CSE: ${googleResult.error ?? 'no results'} → falling back to Tavily...`)
  }

  // 3) Tavily (last resort — API credit conservation)
  if (process.env.TAVILY_API_KEY) {
    return await searchTavily(query, limit)
  }

  return {
    query,
    results: [],
    error: 'No search API key found. Add SEARXNG_URL, BRAVE_SEARCH_API_KEY, GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX or TAVILY_API_KEY to .env.',
  }
}

export function formatSearchResult(response: SearchToolResponse): string {
  if (response.error) {
    return `❌ Search error: ${response.error}`;
  }

  if (response.results.length === 0) {
    return `🔍 No results found for "${response.query}".`;
  }

  const provider = response.provider ?? 'Web Search'
  const lines = [
    `🔍 Web Search Results (${provider}): "${response.query}"`,
    `Found: ${response.results.length} result(s).`,
    ``,
    `⚠️ SYSTEM NOTE: Do not treat these results as 100% accurate. Focus on results that cross-validate with other known details about the target (email, username, etc.).`,
    ``
  ];

  response.results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   URL: ${r.url}`);
    lines.push(`   Summary: ${r.snippet}`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Runs multiple queries in parallel and deduplicates by URL.
 * Capped at a maximum of 3 queries — protects API budget.
 */
export async function searchWebMulti(
  queries: string[],
  limit: number = 10
): Promise<SearchToolResponse & { totalUnique: number }> {
  // Hard cap: en fazla 3 sorgu
  const capped = queries.slice(0, 3).map(q => q.trim()).filter(Boolean)

  if (capped.length === 0) {
    return { query: '(empty)', results: [], error: 'Query list is empty', totalUnique: 0 }
  }

  // Paralel arama
  const responses = await Promise.all(capped.map(q => searchWeb(q, limit)))

  // Deduplicate by URL — first occurrence wins
  const seen = new Set<string>()
  const unique: SearchResult[] = []

  for (const resp of responses) {
    for (const item of resp.results) {
      if (!seen.has(item.url)) {
        seen.add(item.url)
        unique.push(item)
      }
    }
  }

  // Return at most 30 results
  const final = unique.slice(0, 30)

  // Merge errors
  const errors = responses.filter(r => r.error).map(r => r.error!)
  const combinedQuery = capped.join(' | ')

  return {
    query: combinedQuery,
    results: final,
    provider: responses.find(r => r.provider)?.provider,
    error: errors.length === capped.length ? errors.join('; ') : undefined,
    totalUnique: final.length,
  }
}

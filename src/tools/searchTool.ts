export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchToolResponse {
  query: string;
  results: SearchResult[];
  error?: string;
}

/**
 * Tavily API üzerinden web'de arama yapar.
 * Yapay zeka ajanları için optimize edilmiş gelişmiş arama sonuçları döndürür.
 */
export async function searchWeb(query: string, limit: number = 10): Promise<SearchToolResponse> {
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
        search_depth: 'advanced', // Daha derin ve kaliteli sonuçlar için "advanced"
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

    return { query, results };
  } catch (error) {
    return { query, results: [], error: `Arama hatası: ${(error as Error).message}` };
  }
}

export function formatSearchResult(response: SearchToolResponse): string {
  if (response.error) {
    return `❌ Arama hatası: ${response.error}`;
  }

  if (response.results.length === 0) {
    return `🔍 "${response.query}" için Tavily sonuç bulamadı.`;
  }

  const lines = [
    `🔍 Web Arama Sonuçları (Tavily AI): "${response.query}"`,
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

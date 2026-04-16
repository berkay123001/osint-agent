/**
 * academicSearchTool.ts
 * arXiv API + Semantic Scholar Author API üzerinden akademik araştırma.
 * Sonuçları Neo4j'ye Paper → Author, Paper → Topic olarak kaydeder.
 */

// ─── Semantic Scholar Author API ────────────────────────────────────

export interface AuthorPaper {
  paperId: string
  title: string
  year: number | null
  citationCount: number
  arxivId: string | null
  doi: string | null
}

export interface AuthorProfile {
  authorId: string
  name: string
  affiliations: string[]
  paperCount: number
  hIndex: number
  papers: AuthorPaper[]
}

export async function searchAuthorPapers(
  name: string,
  affiliation?: string,
): Promise<{ author: AuthorProfile | null; allMatches: AuthorProfile[]; error?: string }> {
  const SEMANTIC_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY

  const fetchWithRetry = async (url: string): Promise<Response> => {
    const headers: Record<string, string> = { 'User-Agent': 'osint-agent/1.0 (research tool)' }
    if (SEMANTIC_API_KEY) headers['x-api-key'] = SEMANTIC_API_KEY
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    if (res.status === 429) {
      // Tek retry — 3 saniye bekle
      await new Promise(resolve => setTimeout(resolve, 3000))
      return fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    }
    return res
  }

  try {
    const encoded = encodeURIComponent(name)
    const fields = 'name,affiliations,paperCount,hIndex,papers,papers.paperId,papers.title,papers.year,papers.citationCount,papers.externalIds'
    const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encoded}&fields=${fields}&limit=5`

    const res = await fetchWithRetry(url)

    if (!res.ok) {
      return { author: null, allMatches: [], error: `Semantic Scholar HTTP ${res.status}` }
    }

    const data = await res.json() as { data: any[] }
    const raw = data.data ?? []
    if (raw.length === 0) {
      return { author: null, allMatches: [], error: 'Araştırmacı bulunamadı' }
    }

    // Kurum adıyla en iyi eşleşmeyi seç
    const toProfile = (m: any): AuthorProfile => ({
      authorId: m.authorId ?? '',
      name: m.name ?? '',
      affiliations: (m.affiliations ?? []).map((a: any) => (typeof a === 'string' ? a : a.name ?? '')),
      paperCount: m.paperCount ?? 0,
      hIndex: m.hIndex ?? 0,
      papers: (m.papers ?? [])
        .map((p: any): AuthorPaper => ({
          paperId: p.paperId ?? '',
          title: p.title ?? '',
          year: p.year ?? null,
          citationCount: p.citationCount ?? 0,
          arxivId: p.externalIds?.ArXiv ?? null,
          doi: p.externalIds?.DOI ?? null,
        }))
        .sort((a: AuthorPaper, b: AuthorPaper) => b.citationCount - a.citationCount),
    })

    const profiles = raw.map(toProfile)

    let selected = profiles[0]
    if (affiliation) {
      const affilLower = affiliation.toLowerCase()
      const words = affilLower.split(/\s+/).filter(w => w.length > 3)
      const match = profiles.find(p =>
        p.affiliations.some(a =>
          a.toLowerCase().includes(affilLower) ||
          words.some(w => a.toLowerCase().includes(w)),
        ),
      )
      if (match) selected = match
    }

    return { author: selected, allMatches: profiles }
  } catch (err: any) {
    return { author: null, allMatches: [], error: `bağlantı hatası: ${err.message}` }
  }
}

export function formatAuthorResult(result: {
  author: AuthorProfile | null
  allMatches: AuthorProfile[]
  error?: string
}): string {
  if (result.error || !result.author) {
    return `❌ Araştırmacı arama hatası: ${result.error ?? 'Bulunamadı'}`
  }

  const { author } = result
  const lines: string[] = [
    `👤 Araştırmacı: **${author.name}**`,
    `🏛️  Kurum: ${author.affiliations.join(' | ') || 'Belirtilmemiş'}`,
    `📊 h-index: ${author.hIndex} | Toplam Makale: ${author.paperCount}`,
    `🔗 Semantic Scholar: https://www.semanticscholar.org/author/${author.authorId}`,
    '',
    `📚 Makaleler (atıf sayısına göre en yüksekten):`,
    '',
  ]

  for (const [i, p] of author.papers.entries()) {
    lines.push(`${i + 1}. **${p.title}** (${p.year ?? '?'}) — ${p.citationCount} atıf`)
    if (p.arxivId) {
      lines.push(`   🔗 arXiv: https://arxiv.org/abs/${p.arxivId}`)
      lines.push(`   📄 HTML: https://ar5iv.labs.arxiv.org/html/${p.arxivId}`)
    }
    if (p.doi) {
      lines.push(`   🔗 DOI: https://doi.org/${p.doi}`)
    }
  }

  if (result.allMatches.length > 1) {
    lines.push('')
    lines.push('⚠️ Diğer olası eşleşmeler (kurum kontrolü yap):')
    for (const m of result.allMatches.slice(1)) {
      lines.push(`  - ${m.name} | ${m.affiliations.join(', ') || 'kurum bilinmiyor'} | ${m.paperCount} makale | h-index: ${m.hIndex}`)
    }
  }

  return lines.join('\n')
}

// ─── arXiv API ───────────────────────────────────────────────────────

export interface AcademicPaper {
  arxivId: string
  title: string
  authors: string[]
  abstract: string
  publishedDate: string
  updatedDate: string
  categories: string[]
  pdfUrl: string
  htmlUrl: string
  totalCitations?: number
}

export interface AcademicSearchResult {
  papers: AcademicPaper[]
  query: string
  totalFound: number
  error?: string
}

// arXiv Atom XML'inden entry bloklarını çıkar
function parseArxivXml(xml: string): AcademicPaper[] {
  const entries: AcademicPaper[] = []

  // <entry>...</entry> bloklarını bul
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1]

    const arxivId = (/<id>https?:\/\/arxiv\.org\/abs\/([\w./]+)<\/id>/.exec(entry)?.[1] ?? '').trim()
    const title = (/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const abstract = (/<summary>([\s\S]*?)<\/summary>/.exec(entry)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const published = (/<published>(.*?)<\/published>/.exec(entry)?.[1] ?? '').slice(0, 10)
    const updated = (/<updated>(.*?)<\/updated>/.exec(entry)?.[1] ?? '').slice(0, 10)

    const authors: string[] = []
    const authorRegex = /<author>\s*<name>(.*?)<\/name>/g
    let aMatch: RegExpExecArray | null
    while ((aMatch = authorRegex.exec(entry)) !== null) {
      authors.push(aMatch[1].trim())
    }

    const categories: string[] = []
    const catRegex = /<category[^>]+term="([^"]+)"/g
    let cMatch: RegExpExecArray | null
    while ((cMatch = catRegex.exec(entry)) !== null) {
      categories.push(cMatch[1])
    }

    const pdfUrl = `https://arxiv.org/pdf/${arxivId}`
    const htmlUrl = `https://arxiv.org/abs/${arxivId}`

    if (arxivId) {
      entries.push({ arxivId, title, authors, abstract, publishedDate: published, updatedDate: updated, categories, pdfUrl, htmlUrl })
    }
  }

  return entries
}

export async function searchAcademicPapers(
  query: string,
  maxResults = 10,
  sortBy: 'relevance' | 'submittedDate' | 'lastUpdatedDate' = 'submittedDate',
): Promise<AcademicSearchResult> {
  // arXiv ve Semantic Scholar'u paralel çalıştır
  const [arxivResult, ssResult] = await Promise.allSettled([
    _searchArxiv(query, maxResults, sortBy),
    _searchSemanticScholar(query, Math.min(maxResults, 10)),
  ]);

  const arxivPapers = arxivResult.status === 'fulfilled' ? arxivResult.value.papers : [];
  const arxivTotal = arxivResult.status === 'fulfilled' ? arxivResult.value.totalFound : 0;
  const arxivError = arxivResult.status === 'fulfilled' ? arxivResult.value.error : (arxivResult.reason as Error)?.message;

  const ssPapers = ssResult.status === 'fulfilled' ? ssResult.value : [];

  // SS sonuçlarını AcademicPaper formatına çevir; arXiv'de olmayanları ekle
  const arxivIds = new Set(arxivPapers.map(p => p.arxivId));
  const ssUnique: AcademicPaper[] = ssPapers
    .filter(p => !p.arxivId || !arxivIds.has(p.arxivId))
    .map(p => p as AcademicPaper);

  const combined = [...arxivPapers, ...ssUnique];
  const ssNote = ssPapers.length > 0
    ? `\n📖 Semantic Scholar: ${ssPapers.length} ek sonuç (DOI + venue bilgisi içerir)`
    : '';

  return {
    papers: combined,
    query,
    totalFound: arxivTotal + ssPapers.length,
    error: combined.length === 0 ? (arxivError ?? 'Sonuç bulunamadı') : undefined,
    _ssNote: ssNote,
  } as AcademicSearchResult & { _ssNote?: string };
}

// arXiv rate limiter — çağrılar arası minimum 3 saniye bekle
let lastArxivCall = 0;
const ARXIV_MIN_INTERVAL_MS = 3000;

async function _searchArxiv(
  query: string,
  maxResults: number,
  sortBy: 'relevance' | 'submittedDate' | 'lastUpdatedDate',
): Promise<AcademicSearchResult> {
  try {
    // Rate limit: son çağrıdan bu yana yeterli süre geçmediyse bekle
    const now = Date.now();
    const elapsed = now - lastArxivCall;
    if (elapsed < ARXIV_MIN_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, ARXIV_MIN_INTERVAL_MS - elapsed));
    }
    lastArxivCall = Date.now();

    const encoded = encodeURIComponent(query)
    const url = `https://export.arxiv.org/api/query?search_query=all:${encoded}&sortBy=${sortBy}&sortOrder=descending&max_results=${maxResults}`

    const res = await fetch(url, {
      headers: { 'User-Agent': 'osint-agent/1.0 (research tool)' },
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) {
      return { papers: [], query, totalFound: 0, error: `arXiv API HTTP ${res.status}` }
    }

    const xml = await res.text()
    const totalMatch = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(xml)
    const totalFound = totalMatch ? parseInt(totalMatch[1]) : 0

    const papers = parseArxivXml(xml)
    return { papers, query, totalFound }
  } catch (err: any) {
    return { papers: [], query, totalFound: 0, error: `arXiv bağlantı hatası: ${err.message}` }
  }
}

interface SSPaper extends AcademicPaper {
  doi?: string
  venue?: string
  year?: number
  citationCount?: number
  isOpenAccess?: boolean
}

async function _searchSemanticScholar(query: string, limit: number): Promise<SSPaper[]> {
  try {
    const SEMANTIC_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
    const headers: Record<string, string> = { 'User-Agent': 'osint-agent/1.0 (research tool)' };
    if (SEMANTIC_API_KEY) headers['x-api-key'] = SEMANTIC_API_KEY;

    const fields = 'paperId,title,authors,year,citationCount,externalIds,venue,publicationVenue,isOpenAccess,abstract';
    const encoded = encodeURIComponent(query);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&fields=${fields}&limit=${limit}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];

    const data = await res.json() as { data: any[] };
    const papers: SSPaper[] = (data.data ?? []).map((p: any) => {
      const arxivId: string = p.externalIds?.ArXiv ?? '';
      const doi: string = p.externalIds?.DOI ?? '';
      const year: number = p.year ?? 0;
      const venue: string = p.publicationVenue?.name ?? p.venue ?? '';
      return {
        arxivId,
        doi,
        venue,
        year,
        title: p.title ?? '',
        authors: (p.authors ?? []).map((a: any) => a.name ?? ''),
        abstract: p.abstract ?? '',
        publishedDate: year ? `${year}-01-01` : '',
        updatedDate: '',
        categories: [],
        pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : (doi ? `https://doi.org/${doi}` : ''),
        htmlUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : (doi ? `https://doi.org/${doi}` : ''),
        totalCitations: p.citationCount ?? 0,
        isOpenAccess: p.isOpenAccess ?? false,
      };
    });
    return papers;
  } catch {
    return [];
  }
}

export function formatAcademicResult(result: AcademicSearchResult & { _ssNote?: string }): string {
  if (result.error) return `❌ Akademik arama hatası: ${result.error}`
  if (result.papers.length === 0) return `🔬 "${result.query}" için sonuç bulunamadı.`

  const lines: string[] = [
    `🔬 Akademik Araştırma: "${result.query}"`,
    `📊 Toplam eşleşme: ${result.totalFound} | Gösterilen: ${result.papers.length}${result._ssNote ?? ''}`,
    '',
  ]

  for (const [i, p] of result.papers.entries()) {
    const sp = p as SSPaper;
    lines.push(`### ${i + 1}. ${p.title}`)
    lines.push(`   📅 Yayın: ${p.publishedDate} | 🆔 arXiv: ${p.arxivId || '(arXiv yok)'}`)
    if (sp.doi) lines.push(`   🔑 DOI: https://doi.org/${sp.doi}  ← peer-reviewed`)
    if (sp.venue) lines.push(`   🏛️  Venue: ${sp.venue}`)
    if (sp.citationCount !== undefined && sp.citationCount > 0) lines.push(`   📊 Atıf: ${sp.citationCount}`)
    lines.push(`   👥 Yazarlar: ${p.authors.slice(0, 5).join(', ')}${p.authors.length > 5 ? ` +${p.authors.length - 5}` : ''}`)
    lines.push(`   🏷️  Kategoriler: ${p.categories.slice(0, 3).join(', ') || '—'}`)
    lines.push(`   📝 Özet: ${p.abstract.slice(0, 800)}${p.abstract.length > 800 ? '...' : ''}`)
    if (p.arxivId) {
      lines.push(`   🔗 Abstract: https://arxiv.org/abs/${p.arxivId}`)
      lines.push(`   📄 HTML: https://ar5iv.labs.arxiv.org/html/${p.arxivId}`)
      lines.push(`   📥 PDF: ${p.pdfUrl}`)
    } else if (sp.doi) {
      lines.push(`   🔗 DOI Link: https://doi.org/${sp.doi}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Makale sonuçlarını Neo4j'ye yazar.
 * Paper → AUTHORED_BY → Person
 * Paper → ABOUT → Topic
 */
export async function writeAcademicPapersToGraph(
  papers: AcademicPaper[],
  searchQuery: string,
  neo4jWrite: (query: string, params: Record<string, unknown>) => Promise<void>,
): Promise<{ papersCreated: number; authorsLinked: number }> {
  let papersCreated = 0
  let authorsLinked = 0

  for (const paper of papers) {
    try {
      // Paper node'u oluştur veya güncelle
      await neo4jWrite(
        `MERGE (p:Paper {arxivId: $arxivId})
         SET p.title = $title,
             p.publishedDate = $publishedDate,
             p.pdfUrl = $pdfUrl,
             p.abstract = $abstract,
             p.categories = $categories,
             p.searchQuery = $searchQuery,
             p.updatedAt = datetime()`,
        {
          arxivId: paper.arxivId,
          title: paper.title,
          publishedDate: paper.publishedDate,
          pdfUrl: paper.pdfUrl,
          abstract: paper.abstract.slice(0, 500),
          categories: paper.categories.join(', '),
          searchQuery,
        },
      )
      papersCreated++

      // Her yazar için Person node ve AUTHORED_BY ilişkisi
      for (const author of paper.authors) {
        await neo4jWrite(
          `MERGE (a:Person {name: $name})
           WITH a
           MATCH (p:Paper {arxivId: $arxivId})
           MERGE (p)-[:AUTHORED_BY]->(a)`,
          { name: author, arxivId: paper.arxivId },
        )
        authorsLinked++
      }

      // Konu/kategori olarak Topic node
      for (const cat of paper.categories.slice(0, 2)) {
        await neo4jWrite(
          `MERGE (t:Topic {name: $cat})
           WITH t
           MATCH (p:Paper {arxivId: $arxivId})
           MERGE (p)-[:ABOUT]->(t)`,
          { cat, arxivId: paper.arxivId },
        )
      }
    } catch {
      // Graf bağlantısı yok — sessizce geç
    }
  }

  return { papersCreated, authorsLinked }
}

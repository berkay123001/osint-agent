/**
 * academicSearchTool.ts
 * arXiv API + Semantic Scholar üzerinden akademik makale araştırması.
 * Sonuçları Neo4j'ye Paper → Author, Paper → Topic olarak kaydeder.
 */

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
  try {
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

export function formatAcademicResult(result: AcademicSearchResult): string {
  if (result.error) return `❌ Akademik arama hatası: ${result.error}`
  if (result.papers.length === 0) return `🔬 "${result.query}" için arXiv'de sonuç bulunamadı.`

  const lines: string[] = [
    `🔬 Akademik Araştırma: "${result.query}"`,
    `📊 Toplam eşleşme: ${result.totalFound} | Gösterilen: ${result.papers.length}`,
    '',
  ]

  for (const [i, p] of result.papers.entries()) {
    lines.push(`### ${i + 1}. ${p.title}`)
    lines.push(`   📅 Yayın: ${p.publishedDate} | 🆔 arXiv: ${p.arxivId}`)
    lines.push(`   👥 Yazarlar: ${p.authors.slice(0, 5).join(', ')}${p.authors.length > 5 ? ` +${p.authors.length - 5}` : ''}`)
    lines.push(`   🏷️  Kategoriler: ${p.categories.slice(0, 3).join(', ')}`)
    lines.push(`   📝 Özet: ${p.abstract.slice(0, 300)}...`)
    lines.push(`   🔗 PDF: ${p.pdfUrl}`)
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

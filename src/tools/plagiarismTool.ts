/**
 * Plagiarism Check Tool — Akademik intihal ve şatekarlık tespiti
 *
 * Graf benzerlik doğrulaması:
 *   (:Publication)-[:SIMILAR_TO {score, evidence, detectedAt}]->(:Publication)
 *   (:Publication)-[:AUTHORED_BY]->(:Author)
 *
 * Algoritma:
 *   1. Metnin k-shingle parmak izini çıkarır (Jaccard benzerliği için)
 *   2. CrossRef & Semantic Scholar'dan makale metadata'sını çeker
 *   3. Şüpheli pasajları web'de aratır (exact phrase search)
 *   4. Bulunan kaynaklarla benzerlik skoru hesaplar
 *   5. Neo4j'e Publication düğümleri ve SIMILAR_TO ilişkileri kaydeder
 */

import { getDriver } from '../lib/neo4j.js'
import { searchWeb } from './searchTool.js'

// ─── Tip tanımları ────────────────────────────────────────────────────────────

export interface Publication {
  doi?: string
  title: string
  authors: string[]
  year?: number
  abstract?: string
  journal?: string
  url?: string
}

export interface SimilarityMatch {
  source: Publication
  score: number           // 0–1 arası Jaccard benzerliği
  matchedPassage: string  // eşleşen pasaj
  evidence: string        // kaynak URL veya akademik referans
  type: 'exact' | 'paraphrase' | 'self_plagiarism' | 'citation_manipulation'
}

export interface PlagiarismReport {
  subject: string
  checkedAt: string
  inputPublication?: Publication
  matches: SimilarityMatch[]
  overallRisk: 'clean' | 'low' | 'medium' | 'high' | 'critical'
  neo4jSaved: boolean
  markdown: string
}

// ─── Metin işleme ─────────────────────────────────────────────────────────────

/**
 * Word-level k-shingle üretir.
 * Örn: "the quick brown fox" → k=3: {"the quick brown", "quick brown fox"}
 */
function extractShingles(text: string, k = 5): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-züğışçöa-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const shingles = new Set<string>()
  for (let i = 0; i <= tokens.length - k; i++) {
    shingles.add(tokens.slice(i, i + k).join(' '))
  }
  return shingles
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const intersection = [...a].filter(x => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return intersection / union
}

/**
 * Metni anlamlı cümlelere böler (minimum 8 token).
 */
function splitIntoPassages(text: string, minTokens = 8): string[] {
  return text
    .split(/[.!?]\s+/)
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= minTokens)
}

// ─── API istemcileri ──────────────────────────────────────────────────────────

async function fetchCrossRef(query: string): Promise<Publication[]> {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=5&select=DOI,title,author,published,abstract,container-title`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'OSINT-Academic-Checker/1.0 (mailto:research@check.local)' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const items = data?.message?.items ?? []
    return items.map((item: any): Publication => ({
      doi: item.DOI,
      title: Array.isArray(item.title) ? item.title[0] : (item.title ?? 'Bilinmiyor'),
      authors: (item.author ?? []).map((a: any) => `${a.given ?? ''} ${a.family ?? ''}`.trim()),
      year: item.published?.['date-parts']?.[0]?.[0],
      abstract: item.abstract?.replace(/<[^>]+>/g, '').trim(),
      journal: Array.isArray(item['container-title']) ? item['container-title'][0] : undefined,
      url: item.DOI ? `https://doi.org/${item.DOI}` : undefined,
    }))
  } catch {
    return []
  }
}

async function fetchSemanticScholar(query: string): Promise<Publication[]> {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,authors,year,abstract,externalIds,venue&limit=5`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'OSINT-Academic-Checker/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const papers = data?.data ?? []
    return papers.map((p: any): Publication => ({
      doi: p.externalIds?.DOI,
      title: p.title ?? 'Bilinmiyor',
      authors: (p.authors ?? []).map((a: any) => a.name ?? ''),
      year: p.year,
      abstract: p.abstract,
      journal: p.venue,
      url: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : undefined,
    }))
  } catch {
    return []
  }
}

// ─── Neo4j grafı ──────────────────────────────────────────────────────────────

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_.]/g, '_').slice(0, 200)
}

async function upsertPublicationNode(pub: Publication): Promise<string> {
  const session = getDriver().session()
  const nodeId = pub.doi ? sanitizeId(pub.doi) : sanitizeId(pub.title.slice(0, 80))
  try {
    await session.run(
      `MERGE (p:Publication {nodeId: $nodeId})
       SET p.title = $title,
           p.authors = $authors,
           p.year = $year,
           p.journal = $journal,
           p.doi = $doi,
           p.url = $url,
           p.updatedAt = datetime()`,
      {
        nodeId,
        title: pub.title,
        authors: pub.authors.join(', '),
        year: pub.year?.toString() ?? '',
        journal: pub.journal ?? '',
        doi: pub.doi ?? '',
        url: pub.url ?? '',
      }
    )
    // Yazar ilişkileri
    for (const author of pub.authors) {
      if (!author.trim()) continue
      await session.run(
        `MERGE (a:Author {name: $name})
         MERGE (p:Publication {nodeId: $nodeId})
         MERGE (p)-[:AUTHORED_BY]->(a)`,
        { name: author.trim(), nodeId }
      )
    }
  } finally {
    await session.close()
  }
  return nodeId
}

async function createSimilarityRelation(
  fromNodeId: string,
  toNodeId: string,
  score: number,
  evidence: string,
  matchType: string,
): Promise<void> {
  const session = getDriver().session()
  try {
    await session.run(
      `MERGE (a:Publication {nodeId: $fromId})
       MERGE (b:Publication {nodeId: $toId})
       MERGE (a)-[r:SIMILAR_TO {matchType: $matchType}]->(b)
       SET r.score = $score,
           r.evidence = $evidence,
           r.detectedAt = datetime()`,
      { fromId: fromNodeId, toId: toNodeId, score, evidence, matchType }
    )
  } finally {
    await session.close()
  }
}

async function queryExistingPublications(authorName: string): Promise<Publication[]> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      `MATCH (p:Publication)-[:AUTHORED_BY]->(a:Author)
       WHERE toLower(a.name) CONTAINS toLower($name)
       RETURN p.title AS title, p.authors AS authors, p.doi AS doi, 
              p.year AS year, p.journal AS journal, p.nodeId AS nodeId
       LIMIT 20`,
      { name: authorName }
    )
    return result.records.map(r => ({
      title: r.get('title') ?? '',
      authors: (r.get('authors') ?? '').split(', ').filter(Boolean),
      doi: r.get('doi') || undefined,
      year: r.get('year') ? parseInt(r.get('year')) : undefined,
      journal: r.get('journal') || undefined,
    }))
  } finally {
    await session.close()
  }
}

// ─── Benzerlik Tespiti ────────────────────────────────────────────────────────

async function detectWebMatches(
  passages: string[],
  targetShingles: Set<string>,
): Promise<SimilarityMatch[]> {
  const matches: SimilarityMatch[] = []
  // En uzun 5 pasajı al (daha özgün = daha iyi tespit)
  const topPassages = passages
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)

  for (const passage of topPassages) {
    // Tırnak içinde exact phrase search
    const query = `"${passage.slice(0, 120)}"`
    const searchResult = await searchWeb(query, 5)

    for (const r of searchResult.results) {
      const snippetShingles = extractShingles(r.snippet + ' ' + r.title)
      const score = jaccardSimilarity(targetShingles, snippetShingles)

      if (score > 0.08 || r.snippet.toLowerCase().includes(passage.slice(0, 30).toLowerCase())) {
        matches.push({
          source: {
            title: r.title,
            authors: [],
            url: r.url,
          },
          score: Math.max(score, 0.15), // Web eşleşmesi minimum 0.15 güven
          matchedPassage: passage.slice(0, 200),
          evidence: r.url,
          type: 'exact',
        })
      }
    }
  }

  return matches
}

function comparePaperSets(
  inputPub: Publication,
  candidates: Publication[],
  inputShingles: Set<string>,
): SimilarityMatch[] {
  const matches: SimilarityMatch[] = []

  for (const candidate of candidates) {
    const candidateText = [candidate.title, candidate.abstract ?? ''].join(' ')
    const candidateShingles = extractShingles(candidateText)
    const score = jaccardSimilarity(inputShingles, candidateShingles)

    if (score < 0.05) continue

    const isSameAuthor = candidate.authors.some(ca =>
      inputPub.authors.some(ia =>
        ia.toLowerCase().includes(ca.split(' ').pop()?.toLowerCase() ?? '') ||
        ca.toLowerCase().includes(ia.split(' ').pop()?.toLowerCase() ?? '')
      )
    )

    let type: SimilarityMatch['type'] = 'paraphrase'
    if (score > 0.6) type = 'exact'
    else if (isSameAuthor && score > 0.15) type = 'self_plagiarism'

    matches.push({
      source: candidate,
      score,
      matchedPassage: candidateText.slice(0, 200),
      evidence: candidate.url ?? candidate.doi ?? candidate.title,
      type,
    })
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 10)
}

// ─── Risk hesaplama ───────────────────────────────────────────────────────────

function calcRisk(matches: SimilarityMatch[]): PlagiarismReport['overallRisk'] {
  if (matches.length === 0) return 'clean'
  const maxScore = Math.max(...matches.map(m => m.score))
  if (maxScore >= 0.7) return 'critical'
  if (maxScore >= 0.5 || matches.filter(m => m.type === 'exact').length >= 3) return 'high'
  if (maxScore >= 0.3 || matches.length >= 5) return 'medium'
  if (maxScore >= 0.1) return 'low'
  return 'clean'
}

// ─── Markdown raporu ──────────────────────────────────────────────────────────

const RISK_ICON: Record<PlagiarismReport['overallRisk'], string> = {
  clean: '🟢',
  low: '🔵',
  medium: '🟡',
  high: '🔴',
  critical: '🚨',
}

function buildMarkdown(report: PlagiarismReport): string {
  const lines: string[] = [
    `# 📚 İntihal Analiz Raporu`,
    `**Konu:** ${report.subject}`,
    `**Kontrol zamanı:** ${report.checkedAt}`,
    `**Risk Seviyesi:** ${RISK_ICON[report.overallRisk]} ${report.overallRisk.toUpperCase()}`,
    `**Neo4j'e Kaydedildi:** ${report.neo4jSaved ? '✅ Evet' : '❌ Hayır (bağlantı yok)'}`,
    ``,
  ]

  if (report.inputPublication) {
    const p = report.inputPublication
    lines.push(
      `## 📄 İncelenen Yayın`,
      `- **Başlık:** ${p.title}`,
      `- **Yazarlar:** ${p.authors.join(', ') || 'Bilinmiyor'}`,
      p.year ? `- **Yıl:** ${p.year}` : '',
      p.journal ? `- **Dergi:** ${p.journal}` : '',
      p.doi ? `- **DOI:** ${p.doi}` : '',
      ``,
    )
  }

  if (report.matches.length === 0) {
    lines.push(`## ✅ Sonuç`, `Herhangi bir benzer içerik tespit edilmedi.`)
  } else {
    lines.push(`## 🔍 Benzerlik Matrisi (${report.matches.length} eşleşme)`, '')

    for (const [i, m] of report.matches.entries()) {
      const pct = (m.score * 100).toFixed(1)
      const risk = m.score >= 0.5 ? '🔴' : m.score >= 0.3 ? '🟡' : '🔵'
      lines.push(
        `### ${i + 1}. ${risk} %${pct} — ${m.type.replace('_', ' ').toUpperCase()}`,
        `**Kaynak:** ${m.source.title}`,
        m.source.authors.length > 0 ? `**Yazarlar:** ${m.source.authors.join(', ')}` : '',
        m.source.year?.toString() ? `**Yıl:** ${m.source.year}` : '',
        `**Kanıt URL:** ${m.evidence}`,
        `**Eşleşen Pasaj:** \`${m.matchedPassage.slice(0, 150)}...\``,
        ``,
      )
    }
  }

  if (report.neo4jSaved && report.matches.length > 0) {
    lines.push(
      `## 🕸️ Graf Sorgusu`,
      `\`\`\`cypher`,
      `// Tüm benzerlik ilişkilerini getir`,
      `MATCH (a:Publication)-[r:SIMILAR_TO]->(b:Publication)`,
      `WHERE r.score > 0.1`,
      `RETURN a.title AS kaynak, b.title AS hedef, r.score AS skor, r.matchType AS tur`,
      `ORDER BY r.score DESC`,
      `\`\`\``,
    )
  }

  return lines.filter(l => l !== undefined).join('\n')
}

// ─── Ana export ───────────────────────────────────────────────────────────────

export interface PlagiarismInput {
  /** İncelenecek metin (abstract, makale bölümü, tam metin) */
  text: string
  /** Yazar adı — self-plagiarism tespiti + CrossRef araması için */
  author?: string
  /** Mevcut makale başlığı — metadata çekme için */
  title?: string
  /** İncelenen makale DOI'si */
  doi?: string
  /** Wording araması için ek bağlam */
  context?: string
}

export async function checkPlagiarism(input: PlagiarismInput): Promise<PlagiarismReport> {
  const { text, author, title, doi } = input
  const subject = title ?? doi ?? (author ? `${author} makaleleri` : 'İsimsiz metin')

  // 1. Parmak izi
  const inputShingles = extractShingles(text)
  const passages = splitIntoPassages(text)

  // 2. Giriş yayını meta verisi
  let inputPub: Publication | undefined
  if (title || doi) {
    const query = doi ?? title ?? ''
    const crossRefResults = await fetchCrossRef(query)
    inputPub = crossRefResults[0] ?? {
      title: title ?? 'Bilinmiyor',
      authors: author ? [author] : [],
      doi,
    }
    if (author && inputPub.authors.length === 0) {
      inputPub = { ...inputPub, authors: [author] }
    }
  } else if (author) {
    inputPub = { title: subject, authors: [author] }
  }

  // 3. Karşılaştırma havuzu oluştur
  const comparePool: Publication[] = []

  // 3a. CrossRef'ten benzer makaleler
  const crossRefQuery = [title, author].filter(Boolean).join(' ')
  if (crossRefQuery) {
    const cr = await fetchCrossRef(crossRefQuery)
    comparePool.push(...cr)
  }

  // 3b. Semantic Scholar'dan benzer makaleler
  const s2Query = [title, author, text.slice(0, 200)].filter(Boolean).join(' ')
  const s2results = await fetchSemanticScholar(s2Query.slice(0, 300))
  comparePool.push(...s2results)

  // 3c. Neo4j hafızasındaki mevcut yayınlar (daha önce eklenen)
  if (author) {
    const graphPubs = await queryExistingPublications(author).catch(() => [])
    comparePool.push(...graphPubs)
  }

  // 4. Karşılaştırma yapılandırılmış
  const apiMatches = inputPub
    ? comparePaperSets(inputPub, comparePool, inputShingles)
    : []

  // 5. Web exact-phrase araması (pasaj bazlı)
  const webMatches = passages.length > 0
    ? await detectWebMatches(passages, inputShingles)
    : []

  // 6. Tüm eşleşmeleri birleştir — URL'ye göre deduplicate
  const allMatchesMap = new Map<string, SimilarityMatch>()
  for (const m of [...apiMatches, ...webMatches]) {
    const key = m.evidence
    const existing = allMatchesMap.get(key)
    if (!existing || m.score > existing.score) {
      allMatchesMap.set(key, m)
    }
  }
  const allMatches = [...allMatchesMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)

  // 7. Neo4j'e kaydet
  let neo4jSaved = false
  try {
    const inputNodeId = inputPub
      ? await upsertPublicationNode(inputPub)
      : null

    for (const m of allMatches) {
      const sourceNodeId = await upsertPublicationNode({
        ...m.source,
        authors: m.source.authors.length > 0 ? m.source.authors : ['Bilinmiyor'],
      })
      if (inputNodeId) {
        await createSimilarityRelation(
          inputNodeId,
          sourceNodeId,
          m.score,
          m.evidence.slice(0, 500),
          m.type,
        )
      }
    }
    neo4jSaved = true
  } catch {
    // Neo4j bağlantısı yoksa sessizce devam et
  }

  // 8. Rapor
  const report: PlagiarismReport = {
    subject,
    checkedAt: new Date().toISOString(),
    inputPublication: inputPub,
    matches: allMatches,
    overallRisk: calcRisk(allMatches),
    neo4jSaved,
    markdown: '',
  }
  report.markdown = buildMarkdown(report)

  return report
}

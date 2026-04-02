/**
 * Çok kaynaklı iddia doğrulama (Faz 3).
 *
 * Bir iddianın (claim) birden fazla bağımsız kaynakta desteklenip desteklenmediğini kontrol eder.
 * Önemli prensip: Bir sitede iddianın açıkça yazılmaması, iddianın yanlış olduğu anlamına gelmez
 * — bu yalnızca "kanıtsız" (inconclusive) sonuç üretir.
 */

import { searchWeb } from './searchTool.js'
import { scrapeProfile } from './scrapeTool.js'
import { fetchRedditDiscussion, extractRedditDiscussionFromMarkdown, formatRedditDiscussion, type RedditDiscussion } from '../lib/sourceCredibility.js'

export interface VerifyResult {
  claim: string
  verified: boolean | null     // null = yetersiz kanıt
  confidence: 'high' | 'medium' | 'low' | 'inconclusive'
  evidence: string[]           // iddiayı destekleyen alıntılar
  loginWall: boolean           // birincil kaynakta giriş duvarı var mı
  sourcesChecked: string[]     // kontrol edilen URL'ler
  redditDiscussion?: string    // Reddit tartışma özeti (varsa)
}

/**
 * Metinde anahtar kelime eşleşmesi — büyük/küçük harf bağımsız.
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k.toLowerCase()))
}

/**
 * Bir iddianın geçerliliğini birden fazla kaynaktan doğrular.
 *
 * @param claim        Doğrulanacak iddia (örn. "ücretsiz kullanıma sahip")
 * @param primaryUrl   İddianın ait olduğu ana URL (örn. ürün sitesi)
 * @param keywords     Claim içeriğini yakalamak için anahtar kelimeler
 *                     (örn. ["free", "ücretsiz", "no credit card", "kayıt olmadan"])
 */
export async function verifyClaim(
  claim: string,
  primaryUrl: string,
  keywords: string[]
): Promise<VerifyResult> {
  const sourcesChecked: string[] = []
  const evidence: string[] = []
  let loginWall = false
  let primaryConfirmed = false

  // 1) Birincil kaynağı scrape et
  try {
    const primary = await scrapeProfile(primaryUrl)
    sourcesChecked.push(primaryUrl)
    loginWall = primary.loginWallDetected ?? false

    if (!primary.error && primary.markdown.length > 50) {
      if (containsKeywords(primary.markdown, keywords)) {
        primaryConfirmed = true
        // Eşleşen cümleyi bul
        const sentences = primary.markdown.split(/[.!?\n]/)
        for (const s of sentences) {
          if (containsKeywords(s, keywords)) {
            evidence.push(`[${primaryUrl}] ${s.trim().slice(0, 200)}`)
            break
          }
        }
      }
    }
  } catch {
    // Scrape başarısız olsa da devam et
  }

  // 2) Topluluk araması: Reddit ve genel web
  const domain = (() => {
    try { return new URL(primaryUrl).hostname.replace(/^www\./, '') } catch { return '' }
  })()

  const communityQuery = `${domain} ${keywords[0] ?? claim} reddit`
  const communityResults = await searchWeb(communityQuery, 5)
  const communityUrls = communityResults.results
    .filter(r => r.url.includes('reddit.com') || r.url.includes('news.ycombinator.com'))
    .slice(0, 2)

  let communityConfirmed = 0
  let redditDiscussion: RedditDiscussion | null = null

  for (const r of communityUrls) {
    sourcesChecked.push(r.url)
    // Snippet üzerinden hızlı check — tam scrape gerektirmez
    if (containsKeywords(r.snippet, keywords)) {
      communityConfirmed++
      evidence.push(`[${r.url}] ${r.snippet.slice(0, 200)}`)
    }

    // Reddit URL'leri için JSON API ile derin analiz
    if (r.url.includes('reddit.com') && !redditDiscussion) {
      redditDiscussion = await fetchRedditDiscussion(r.url)
      if (redditDiscussion) {
        // Tartışmadan anahtar kelime eşleşmelerini de kanıt olarak ekle
        for (const comment of redditDiscussion.topComments) {
          if (containsKeywords(comment.body, keywords)) {
            communityConfirmed++
            evidence.push(`[Reddit u/${comment.author} (${comment.score} oy)] ${comment.body.slice(0, 200)}`)
          }
        }
      } else {
        // JSON API başarısız → scrape edilmiş Markdown'dan çıkar
        const scraped = await scrapeProfile(r.url)
        if (!scraped.error && scraped.markdown.length > 100) {
          const mdDiscussion = extractRedditDiscussionFromMarkdown(scraped.markdown)
          if (mdDiscussion) {
            // Markdown'dan çıkarılan tartışmayı kanıt olarak ekle
            for (const comment of mdDiscussion.topComments ?? []) {
              if (containsKeywords(comment.body, keywords)) {
                communityConfirmed++
                evidence.push(`[Reddit u/${comment.author} (${comment.score} oy)] ${comment.body.slice(0, 200)}`)
              }
            }
          }
        }
      }
    }
  }

  // 3) Güven düzeyini hesapla
  const redditSummary = redditDiscussion
    ? formatRedditDiscussion(redditDiscussion)
    : undefined

  if (communityConfirmed >= 2) {
    return { claim, verified: true, confidence: 'high', evidence, loginWall, sourcesChecked, redditDiscussion: redditSummary }
  }

  if (communityConfirmed === 1 && primaryConfirmed) {
    return { claim, verified: true, confidence: 'medium', evidence, loginWall, sourcesChecked, redditDiscussion: redditSummary }
  }

  if (primaryConfirmed && communityConfirmed === 0) {
    return { claim, verified: true, confidence: 'low', evidence, loginWall, sourcesChecked, redditDiscussion: redditSummary }
  }

  // Kanıt yok — ama bu claim'in yanlış olduğu anlamına gelmez
  return {
    claim,
    verified: null,
    confidence: 'inconclusive',
    evidence,
    loginWall,
    sourcesChecked,
    redditDiscussion: redditSummary,
  }
}

export function formatVerifyResult(r: VerifyResult): string {
  const icon = r.verified === true ? '✅' : r.verified === false ? '❌' : '⚠️'
  const conf = { high: 'YÜKSEK', medium: 'ORTA', low: 'DÜŞÜK', inconclusive: 'YETERSİZ KANIT' }[r.confidence]
  const lines = [
    `${icon} İDDİA DOĞRULAMA — Güven: ${conf}`,
    `İddia: "${r.claim}"`,
    r.loginWall ? `⚠️ Birincil kaynak giriş duvarına sahip — içerik eksik olabilir.` : '',
    ``,
    `Kontrol edilen kaynaklar: ${r.sourcesChecked.join(', ')}`,
  ]

  if (r.evidence.length > 0) {
    lines.push(`\nDestekleyen kanıtlar:`)
    r.evidence.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`))
  } else {
    lines.push(`\nKanıt bulunamadı — bu iddianın yanlış olduğu anlamına GELMEZ, yalnızca doğrulanamadı.`)
  }

  if (r.redditDiscussion) {
    lines.push(`\n🟣 Reddit Topluluk Tartışması:`)
    lines.push(r.redditDiscussion)
  }

  return lines.filter(l => l !== '').join('\n')
}

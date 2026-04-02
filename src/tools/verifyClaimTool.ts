/**
 * Çok kaynaklı iddia doğrulama (Faz 3).
 *
 * Bir iddianın (claim) birden fazla bağımsız kaynakta desteklenip desteklenmediğini kontrol eder.
 * Önemli prensip: Bir sitede iddianın açıkça yazılmaması, iddianın yanlış olduğu anlamına gelmez
 * — bu yalnızca "kanıtsız" (inconclusive) sonuç üretir.
 */

import { searchWeb } from './searchTool.js'
import { scrapeProfile } from './scrapeTool.js'

export interface VerifyResult {
  claim: string
  verified: boolean | null     // null = yetersiz kanıt
  confidence: 'high' | 'medium' | 'low' | 'inconclusive'
  evidence: string[]           // iddiayı destekleyen alıntılar
  loginWall: boolean           // birincil kaynakta giriş duvarı var mı
  sourcesChecked: string[]     // kontrol edilen URL'ler
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

  for (const r of communityUrls) {
    sourcesChecked.push(r.url)
    // Snippet üzerinden hızlı check — tam scrape gerektirmez
    if (containsKeywords(r.snippet, keywords)) {
      communityConfirmed++
      evidence.push(`[${r.url}] ${r.snippet.slice(0, 200)}`)
    }
  }

  // 3) Güven düzeyini hesapla
  const totalIndependentConfirmed = communityConfirmed + (primaryConfirmed ? 0 : 0)
  // primaryUrl = taraf kaynak → bağımsız sayılmaz, community = bağımsız

  if (communityConfirmed >= 2) {
    return { claim, verified: true, confidence: 'high', evidence, loginWall, sourcesChecked }
  }

  if (communityConfirmed === 1 && primaryConfirmed) {
    return { claim, verified: true, confidence: 'medium', evidence, loginWall, sourcesChecked }
  }

  if (primaryConfirmed && communityConfirmed === 0) {
    return { claim, verified: true, confidence: 'low', evidence, loginWall, sourcesChecked }
  }

  // Kanıt yok — ama bu claim'in yanlış olduğu anlamına gelmez
  return {
    claim,
    verified: null,
    confidence: 'inconclusive',
    evidence,
    loginWall,
    sourcesChecked,
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

  return lines.filter(l => l !== '').join('\n')
}

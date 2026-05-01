/**
 * Sherlock profil doğrulama modülü.
 * Sherlock'un bulduğu profil URL'lerini scrape ederek,
 * profil sahibinin hedef kişiye ait olup olmadığını çapraz doğrular.
 *
 * Strateji: Bilinen isim, email, bio bilgisi sayfada var mı?
 * Varsa güven "high"a yükselir, yoksa "medium" kalır.
 */

import { scrapeProfile } from './scrapeTool.js'
import { fetchAndHashImage, calculateHammingDistance } from './imageHasher.js'

export interface VerificationResult {
  platform: string
  url: string
  verified: boolean
  confidence: 'high' | 'medium' | 'low'
  matchedIndicators: string[]
  profScore?: number  // S_prof skoru [0, 1]
  scrapedBio?: string
  error?: string
}

export interface KnownIdentifiers {
  username: string
  realName?: string
  emails: string[]
  location?: string
  company?: string
  blog?: string
  avatarUrl?: string
  avatarHash?: string
}

// Doğrulama yapabileceğimiz platformlar (scrape destekli)
const VERIFIABLE_PLATFORMS = new Set([
  'GitHub', 'GitLab', 'TryHackMe', 'HackTheBox', 'Keybase',
  'Dev Community', 'Medium', 'Hashnode', 'SourceForge',
  'Flickr', 'Gravatar', 'About.me', 'Linktree',
])

// Kanıt tipi ağırlıkları — S_prof = Σ w_i · e_i formülü (Formül 1)
export const EVIDENCE_WEIGHTS: Record<string, number> = {
  email:        0.40,  // en güçlü — benzersiz tanımlayıcı
  isim:         0.25,  // ad + soyad birlikte
  website:      0.15,  // URL cross-link
  organizasyon: 0.10,  // şirket/üniversite
  konum:        0.05,  // yardımcı kanıt
  avatar:       0.05,  // pHash mesafesi ≤ 6
  avatar_weak:  0.00,  // kısmi benzerlik — skora katkısı yok
}

// Scrape'e değmeyecek platformlar (giriş gerektirir veya Firecrawl desteklemez)
const SKIP_PLATFORMS = new Set([
  'Twitter', 'X', 'Reddit', 'Facebook', 'Instagram',
  'LinkedIn', 'WhatsApp', 'Telegram',
])

export interface WeightedEvidence {
  indicator: string  // görüntülenecek etiket (örn. "email: foo@bar.com")
  type: string       // ağırlık tablosundaki anahtar (örn. "email")
  weight: number     // w_i
}

/**
 * S_prof = Σ w_i · e_i  (Formül 1)
 * Ağırlıklı eşleşme listesinden sayısal skor üretir.
 */
export function computeProfScore(weightedMatches: WeightedEvidence[]): number {
  return weightedMatches.reduce((sum, m) => sum + m.weight, 0)
}

/**
 * Bilinen tanımlayıcıları sayfa içeriğinde (markdown) ara.
 * Her eşleşme için kanıt tipi ve ağırlığı döndürür.
 */
export function findWeightedMatches(
  content: string,
  known: KnownIdentifiers,
): WeightedEvidence[] {
  const matches: WeightedEvidence[] = []
  const lower = content.toLowerCase()

  // Email eşleşmesi — en güçlü kanıt
  for (const email of known.emails) {
    if (lower.includes(email.toLowerCase())) {
      matches.push({ indicator: `email: ${email}`, type: 'email', weight: EVIDENCE_WEIGHTS.email })
    }
  }

  // Gerçek isim eşleşmesi (en az 2 parça: ad + soyad)
  if (known.realName) {
    const nameParts = known.realName.toLowerCase().split(/\s+/).filter(p => p.length > 2)
    if (nameParts.length >= 2) {
      const allFound = nameParts.every(part => lower.includes(part))
      if (allFound) {
        matches.push({ indicator: `isim: ${known.realName}`, type: 'isim', weight: EVIDENCE_WEIGHTS.isim })
      }
    }
  }

  // Blog/website eşleşmesi
  if (known.blog && known.blog.length > 5) {
    const blogClean = known.blog.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
    if (lower.includes(blogClean)) {
      matches.push({ indicator: `website: ${known.blog}`, type: 'website', weight: EVIDENCE_WEIGHTS.website })
    }
  }

  // Şirket/üniversite eşleşmesi
  if (known.company && known.company.length > 3) {
    if (lower.includes(known.company.toLowerCase())) {
      matches.push({ indicator: `organizasyon: ${known.company}`, type: 'organizasyon', weight: EVIDENCE_WEIGHTS.organizasyon })
    }
  }

  // Konum eşleşmesi (yardımcı kanıt)
  if (known.location && known.location.length > 3) {
    const locParts = known.location.toLowerCase().split(/[,/]/).map(s => s.trim()).filter(s => s.length > 3)
    for (const part of locParts) {
      if (lower.includes(part)) {
        matches.push({ indicator: `konum: ${part}`, type: 'konum', weight: EVIDENCE_WEIGHTS.konum })
        break  // tek konum parçası yeterli
      }
    }
  }

  return matches
}

/**
 * Tek bir profil URL'sini doğrula.
 * Firecrawl ile sayfayı çeker, bilinen tanımlayıcıları arar.
 */
export async function verifyProfile(
  platform: string,
  url: string,
  known: KnownIdentifiers,
): Promise<VerificationResult> {
  // Atlanacak platformlar
  if (SKIP_PLATFORMS.has(platform)) {
    return {
      platform,
      url,
      verified: false,
      confidence: 'medium',
      matchedIndicators: [],
      error: `${platform} doğrulaması desteklenmiyor (giriş/Firecrawl kısıtı)`,
    }
  }

  try {
    const scrapeResult = await scrapeProfile(url)

    if (scrapeResult.error) {
      return {
        platform,
        url,
        verified: false,
        confidence: 'medium',
        matchedIndicators: [],
        error: `Scrape hatası: ${scrapeResult.error}`,
      }
    }

    // İçerik: markdown + description + title
    const fullContent = [
      scrapeResult.markdown,
      scrapeResult.title,
      scrapeResult.description,
    ].join('\n')

    const weightedMatches = findWeightedMatches(fullContent, known)

    // Bio'yu çıkar (ilk 200 karakter)
    const bio = scrapeResult.description || scrapeResult.markdown.slice(0, 200)

    let isAvatarMatch = false;
    if (known.avatarHash && scrapeResult.avatarUrl) {
      // Harf/identicon tabanlı otomatik avatarları atla (false positive üretir)
      const isGeneratedAvatar = /\/identicon\/|ui-avatars\.com|avatars\.githubusercontent\.com.*\.png\?/.test(scrapeResult.avatarUrl);
      if (!isGeneratedAvatar) {
        const scrapedAvatarHash = await fetchAndHashImage(scrapeResult.avatarUrl);
        if (scrapedAvatarHash) {
          const distance = calculateHammingDistance(known.avatarHash, scrapedAvatarHash);
          if (distance <= 6) {
            isAvatarMatch = true;
            weightedMatches.push({ indicator: `avatar: Görsel Eşleşmesi (Mesafe: ${distance}/64)`, type: 'avatar', weight: EVIDENCE_WEIGHTS.avatar });
          } else if (distance <= 10) {
            weightedMatches.push({ indicator: `avatar_weak: Kısmi Benzerlik (Mesafe: ${distance}/64, harf avatarı olabilir)`, type: 'avatar_weak', weight: EVIDENCE_WEIGHTS.avatar_weak });
          }
        }
      }
    } else if (known.avatarUrl && scrapeResult.avatarUrl && known.avatarUrl === scrapeResult.avatarUrl) {
      isAvatarMatch = true;
      weightedMatches.push({ indicator: 'avatar: URL Eşleşmesi', type: 'avatar', weight: EVIDENCE_WEIGHTS.avatar });
    }

    const matches = weightedMatches.map(m => m.indicator)
    const S_prof = computeProfScore(weightedMatches)

    if (matches.length > 0 || isAvatarMatch) {
      const hasNonAvatarEvidence = weightedMatches.some(m => m.type !== 'avatar' && m.type !== 'avatar_weak')
      // V(p) karar fonksiyonu (Formül 2) — S_prof eşikleriyle birleştirilmiş
      const confidence: 'high' | 'medium' | 'low' =
        hasNonAvatarEvidence && matches.length > 1 && S_prof >= 0.50 ? 'high'
        : hasNonAvatarEvidence && S_prof >= 0.15 ? 'medium'
        : 'low'
      return {
        platform,
        url,
        verified: hasNonAvatarEvidence && S_prof >= 0.25,
        confidence,
        matchedIndicators: matches,
        profScore: Math.round(S_prof * 1000) / 1000,
        scrapedBio: bio,
      }
    }

    return {
      platform,
      url,
      verified: false,
      confidence: 'medium',
      matchedIndicators: [],
      scrapedBio: bio,
    }
  } catch (e) {
    return {
      platform,
      url,
      verified: false,
      confidence: 'medium',
      matchedIndicators: [],
      error: (e as Error).message,
    }
  }
}

/**
 * Birden fazla Sherlock profilini toplu doğrula.
 * Firecrawl kotasını korumak için yalnızca VERIFIABLE_PLATFORMS'a bakılır.
 * maxVerify ile kontrol edilecek profil sayısı sınırlanır.
 */
export async function verifySherlockProfiles(
  profiles: Array<{ platform: string; url: string }>,
  known: KnownIdentifiers,
  maxVerify: number = 5,
): Promise<{
  results: VerificationResult[]
  verified: number
  unverified: number
  skipped: number
}> {
  const results: VerificationResult[] = []
  let verifyCount = 0

  for (const p of profiles) {
    if (SKIP_PLATFORMS.has(p.platform)) {
      results.push({
        platform: p.platform,
        url: p.url,
        verified: false,
        confidence: 'medium',
        matchedIndicators: [],
        error: 'Platform doğrulamaya uygun değil',
      })
      continue
    }

    // Kota sınırı
    if (verifyCount >= maxVerify) {
      results.push({
        platform: p.platform,
        url: p.url,
        verified: false,
        confidence: 'medium',
        matchedIndicators: [],
        error: 'Doğrulama limiti aşıldı',
      })
      continue
    }

    // Öncelikli platformlar ilk sırada
    const isPriority = VERIFIABLE_PLATFORMS.has(p.platform)
    if (!isPriority && verifyCount >= Math.ceil(maxVerify / 2)) {
      results.push({
        platform: p.platform,
        url: p.url,
        verified: false,
        confidence: 'medium',
        matchedIndicators: [],
        error: 'Öncelik sınırına takıldı (Atlandı)'
      })
      continue
    }

    const result = await verifyProfile(p.platform, p.url, known)
    results.push(result)
    verifyCount++
  }

  return {
    results,
    verified: results.filter(r => r.verified).length,
    unverified: results.filter(r => !r.verified && !r.error).length,
    skipped: results.filter(r => r.error !== undefined).length,
  }
}

/**
 * Doğrulama sonuçlarını formatla — chat'e dönecek özet
 */
export function formatVerificationResults(
  results: VerificationResult[],
): string {
  const verified = results.filter(r => r.verified)
  const unverified = results.filter(r => !r.verified && !r.error)
  const skipped = results.filter(r => r.error !== undefined)

  const lines: string[] = [
    `🔍 Profil Doğrulama Raporu`,
    `Sonuç: ${verified.length} doğrulandı, ${unverified.length} doğrulanmadı, ${skipped.length} atlandı`,
    '',
  ]

  if (verified.length > 0) {
    lines.push('✅ DOĞRULANAN PROFİLLER:')
    for (const r of verified) {
      const scoreLabel = r.profScore !== undefined
        ? ` (S_prof: ${r.profScore.toFixed(2)} → ${r.confidence})`
        : ''
      lines.push(`  • ${r.platform}${scoreLabel} → ${r.url}`)
      lines.push(`    Eşleşen: ${r.matchedIndicators.join(', ')}`)
      if (r.scrapedBio) lines.push(`    Bio: ${r.scrapedBio.slice(0, 100)}`)
    }
    lines.push('')
  }

  if (unverified.length > 0) {
    lines.push('⚠️ DOĞRULANMAYAN PROFİLLER (URL var, kimlik eşleşmedi):')
    for (const r of unverified) {
      lines.push(`  • ${r.platform} → ${r.url}`)
      if (r.scrapedBio) lines.push(`    Bio: ${r.scrapedBio.slice(0, 100)}`)
    }
    lines.push('')
  }

  if (skipped.length > 0) {
    lines.push('⏭️ ATLANDILAR:')
    for (const r of skipped) {
      lines.push(`  • ${r.platform}: ${r.error}`)
    }
  }

  return lines.join('\n')
}

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

// Scrape'e değmeyecek platformlar (giriş gerektirir veya Firecrawl desteklemez)
const SKIP_PLATFORMS = new Set([
  'Twitter', 'X', 'Reddit', 'Facebook', 'Instagram',
  'LinkedIn', 'WhatsApp', 'Telegram',
])

/**
 * Bilinen tanımlayıcıları sayfa içeriğinde (markdown) ara.
 * Herhangi biri eşleşirse profil doğrulanır.
 */
function findMatchesInContent(
  content: string,
  known: KnownIdentifiers,
): string[] {
  const matches: string[] = []
  const lower = content.toLowerCase()

  // Email eşleşmesi — en güçlü kanıt
  for (const email of known.emails) {
    if (lower.includes(email.toLowerCase())) {
      matches.push(`email: ${email}`)
    }
  }

  // Gerçek isim eşleşmesi (en az 2 parça: ad + soyad)
  if (known.realName) {
    const nameParts = known.realName.toLowerCase().split(/\s+/).filter(p => p.length > 2)
    if (nameParts.length >= 2) {
      const allFound = nameParts.every(part => lower.includes(part))
      if (allFound) {
        matches.push(`isim: ${known.realName}`)
      }
    }
  }

  // Konum eşleşmesi (yardımcı kanıt)
  if (known.location && known.location.length > 3) {
    const locParts = known.location.toLowerCase().split(/[,/]/).map(s => s.trim()).filter(s => s.length > 3)
    for (const part of locParts) {
      if (lower.includes(part)) {
        matches.push(`konum: ${part}`)
      }
    }
  }

  // Blog/website eşleşmesi
  if (known.blog && known.blog.length > 5) {
    const blogClean = known.blog.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
    if (lower.includes(blogClean)) {
      matches.push(`website: ${known.blog}`)
    }
  }

  // Şirket/üniversite eşleşmesi
  if (known.company && known.company.length > 3) {
    if (lower.includes(known.company.toLowerCase())) {
      matches.push(`organizasyon: ${known.company}`)
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

    const matches = findMatchesInContent(fullContent, known)

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
          // ≤6: güçlü eşleşme (aynı fotoğrafın farklı boyutu), 7-10: belirsiz (harf avatarı çakışabilir)
          if (distance <= 6) {
            isAvatarMatch = true;
            matches.push(`avatar: Görsel Eşleşmesi (Mesafe: ${distance}/64)`);
          } else if (distance <= 10) {
            matches.push(`avatar_weak: Kısmi Benzerlik (Mesafe: ${distance}/64, harf avatarı olabilir)`);
          }
        }
      }
    } else if (known.avatarUrl && scrapeResult.avatarUrl && known.avatarUrl === scrapeResult.avatarUrl) {
      isAvatarMatch = true;
      matches.push(`avatar: URL Eşleşmesi`);
    }

    if (matches.length > 0 || isAvatarMatch) {
      // Avatar eşleşmesi tek başına HIGH vermez — başka somut kanıt da gerekir
      const hasNonAvatarEvidence = matches.some(m => !m.startsWith('avatar'));
      const confidence: 'high' | 'medium' | 'low' = hasNonAvatarEvidence && matches.length > 1
        ? 'high'
        : hasNonAvatarEvidence
          ? 'medium'
          : 'low';
      return {
        platform,
        url,
        verified: hasNonAvatarEvidence,  // avatar tek başına doğrulama sayılmaz
        confidence,
        matchedIndicators: matches,
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
      lines.push(`  • ${r.platform} → ${r.url}`)
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

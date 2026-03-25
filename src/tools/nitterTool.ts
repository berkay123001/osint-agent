/**
 * Nitter entegrasyonu — Twitter/X profillerini proxy üzerinden oku.
 * Doğrudan Twitter API veya scraping yerine, açık Nitter instance'ları kullanarak
 * profil bilgisi çeker. Ücretsiz, API key gerektirmez.
 *
 * Nitter instance'ları değişken olabilir — birden fazla denenir.
 */

export interface NitterProfile {
  username: string
  displayName: string
  bio: string
  location: string
  website: string
  joinDate: string
  tweets: number
  followers: number
  following: number
  verified: boolean
  recentTweets: string[]
  avatarUrl: string
  error?: string
  instanceUsed?: string
}

// Aktif Nitter instance'ları — en stabilleri ilk sırada
// Not: Instance'lar sık değişir; çalışmayan olursa listeden kaldırılabilir.
const NITTER_INSTANCES = [
  'https://nitter.poast.org',
  'https://nitter.privacydna.ru',
  'https://nitter.tiekoetter.com',
  'https://nitter.it',
  'https://nitter.cz',
  'https://nitter.unixfox.eu',
  'https://xcancel.com',
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
]

const REQUEST_TIMEOUT = 6000 // 6s — hızlı fail, sonraki instance'a geç

async function fetchWithTimeout(url: string, timeout = REQUEST_TIMEOUT): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Nitter HTML'inden profil bilgisi çıkar (regex ile lightweight parse).
 * DOM parser gerektirmez.
 */
function parseNitterHtml(html: string, username: string): Partial<NitterProfile> {
  const result: Partial<NitterProfile> = { username }

  // Display name — <a class="profile-card-fullname" ...>İsim</a>
  const nameMatch = html.match(/class="profile-card-fullname"[^>]*>([^<]+)</)
  if (nameMatch) result.displayName = nameMatch[1].trim()

  // Bio — <p class="profile-bio">...</p>
  const bioMatch = html.match(/class="profile-bio"[^>]*>([\s\S]*?)<\/p>/)
  if (bioMatch) {
    result.bio = bioMatch[1]
      .replace(/<[^>]+>/g, '') // HTML tag'leri temizle
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Location — <span class="profile-location">...</span>
  const locMatch = html.match(/class="profile-location"[^>]*>([^<]+)</)
  if (locMatch) result.location = locMatch[1].trim()

  // Website — <a class="profile-website"... href="...">
  const webMatch = html.match(/class="profile-website"[^>]*>[^<]*<a[^>]*href="([^"]+)"/)
  if (webMatch) result.website = webMatch[1]

  // Join date — <span class="profile-joindate">...<span ...>Joined MONTH YEAR</span></span>
  const joinMatch = html.match(/Joined\s+([^<]+)</)
  if (joinMatch) result.joinDate = joinMatch[1].trim()

  // Stats — tweets, following, followers
  const statMatches = [...html.matchAll(/class="profile-stat-num"[^>]*>([^<]+)</g)]
  if (statMatches.length >= 3) {
    result.tweets = parseStatNumber(statMatches[0][1])
    result.following = parseStatNumber(statMatches[1][1])
    result.followers = parseStatNumber(statMatches[2][1])
  }

  // Verified badge
  result.verified = html.includes('class="icon-ok verified-icon"')

  // Son tweetler — <div class="tweet-content ...">...</div>
  const tweetMatches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
  result.recentTweets = tweetMatches.slice(0, 5).map(m =>
    m[1]
      .replace(/<[^>]+>/g, '') // HTML tag'leri temizle
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280)
  ).filter(t => t.length > 0)

  return result
}

function parseStatNumber(text: string): number {
  const clean = text.trim().replace(/,/g, '')
  if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1000)
  if (clean.endsWith('M')) return Math.round(parseFloat(clean) * 1000000)
  return parseInt(clean, 10) || 0
}

/**
 * Twitter/X profilini Nitter üzerinden çek.
 * Birden fazla instance denenir — ilk çalışan sonuç döner.
 */
export async function fetchNitterProfile(username: string): Promise<NitterProfile> {
  const cleanUsername = username.replace(/^@/, '').trim()
  const errors: string[] = []

  for (const instance of NITTER_INSTANCES) {
    const url = `${instance}/${encodeURIComponent(cleanUsername)}`
    try {
      const res = await fetchWithTimeout(url)

      if (res.status === 404) {
        return {
          username: cleanUsername,
          displayName: '',
          bio: '',
          location: '',
          website: '',
          joinDate: '',
          tweets: 0,
          followers: 0,
          following: 0,
          verified: false,
          recentTweets: [],
          avatarUrl: '',
          error: `Twitter/X kullanıcısı "@${cleanUsername}" bulunamadı.`,
        }
      }

      if (!res.ok) {
        errors.push(`${instance}: HTTP ${res.status}`)
        continue
      }

      const html = await res.text()

      // Nitter bazen rate limit sayfası döner
      if (html.includes('rate limited') || html.includes('Instance has been rate limited')) {
        errors.push(`${instance}: Rate limited`)
        continue
      }

      // JavaScript-based bot protection (Verifying your browser)
      if (html.includes('Verifying your browser') || html.includes('window.onload=function(){')) {
        errors.push(`${instance}: Bot koruması aktif (JS challenge)`)
        continue
      }

      const parsed = parseNitterHtml(html, cleanUsername)

      // Profil bilgisi yoksa geçersiz yanıt
      if (!parsed.displayName && !parsed.bio) {
        errors.push(`${instance}: Profil bilgisi çıkarılamadı`)
        continue
      }

      return {
        username: cleanUsername,
        displayName: parsed.displayName || '',
        bio: parsed.bio || '',
        location: parsed.location || '',
        website: parsed.website || '',
        joinDate: parsed.joinDate || '',
        tweets: parsed.tweets || 0,
        followers: parsed.followers || 0,
        following: parsed.following || 0,
        verified: parsed.verified || false,
        recentTweets: parsed.recentTweets || [],
        avatarUrl: parsed.avatarUrl || '',
        instanceUsed: instance,
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('abort')) {
        errors.push(`${instance}: Timeout`)
      } else {
        errors.push(`${instance}: ${msg}`)
      }
    }
  }

  return {
    username: cleanUsername,
    displayName: '',
    bio: '',
    location: '',
    website: '',
    joinDate: '',
    tweets: 0,
    followers: 0,
    following: 0,
    verified: false,
    recentTweets: [],
    avatarUrl: '',
    error: `Tüm Nitter instance'ları başarısız (çoğu bot koruması kullanıyor):\n${errors.join('\n')}\n\n💡 Alternatif: web_fetch ile https://twitter.com/${cleanUsername} dene veya scrape_profile kullan.`,
  }
}

/**
 * Nitter profil sonuçlarını formatla
 */
export function formatNitterResult(profile: NitterProfile): string {
  if (profile.error) {
    return `❌ Nitter hatası (@${profile.username}): ${profile.error}`
  }

  const lines: string[] = [
    `🐦 Twitter/X Profili: @${profile.username}`,
    `(Kaynak: Nitter — ${profile.instanceUsed || 'unknown'})`,
    '',
    `İsim: ${profile.displayName || 'N/A'}`,
    `Bio: ${profile.bio || 'N/A'}`,
    `Konum: ${profile.location || 'N/A'}`,
    `Website: ${profile.website || 'N/A'}`,
    `Katılım: ${profile.joinDate || 'N/A'}`,
    `Tweet: ${profile.tweets} | Takipçi: ${profile.followers} | Takip: ${profile.following}`,
    profile.verified ? '✅ Doğrulanmış hesap' : '',
  ].filter(Boolean)

  if (profile.recentTweets.length > 0) {
    lines.push('')
    lines.push(`Son ${profile.recentTweets.length} tweet:`)
    for (const tweet of profile.recentTweets) {
      lines.push(`  • ${tweet}`)
    }
  }

  return lines.join('\n')
}

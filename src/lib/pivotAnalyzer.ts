/**
 * Pivot Analyzer — graf üzerinden henüz araştırılmamış fırsatları bulur.
 * Agent'ın "bir sonraki en verimli adım ne?" sorusunu cevaplamasına yardımcı olur.
 *
 * Analiz edilen pivot türleri:
 * 1. Email bulundu ama check_email_registrations yapılmadı
 * 2. Email bulundu ama check_breaches yapılmadı
 * 3. Website/blog var ama scrape edilmedi
 * 4. Twitter kullanıcısı var ama profil çekilmedi (nitter_profile/scrape_profile)
 * 5. Doğrulanmamış Sherlock profilleri — verify_profiles yapılmadı
 */

import { getConnections, findLinkedIdentifiers } from './neo4j.js'

export interface PivotSuggestion {
  type: 'email_registration' | 'email_breach' | 'scrape_website' | 'twitter_profile' | 'verify_profiles' | 'deep_github'
  target: string
  tool: string
  priority: 'high' | 'medium' | 'low'
  reason: string
}

export interface PivotAnalysis {
  username: string
  suggestions: PivotSuggestion[]
  stats: {
    totalNodes: number
    emails: number
    websites: number
    profiles: number
  }
}

/**
 * Bir email'in belirli bir pivot türünde zaten araştırılıp araştırılmadığını kontrol et.
 * REGISTERED_ON, LEAKED_IN gibi ilişkilerin varlığına bakar.
 */
async function hasBeenPivoted(value: string, relationType: string): Promise<boolean> {
  try {
    const connections = await getConnections(value)
    return connections.some(c => c.relation === relationType)
  } catch {
    return false
  }
}

/**
 * Bir username'in profil doğrulamasının yapılıp yapılmadığını kontrol et.
 */
async function hasVerifiedProfiles(username: string): Promise<boolean> {
  try {
    const connections = await getConnections(username)
    return connections.some(c =>
      c.relation === 'HAS_PROFILE' && c.source === 'profile_verification'
    )
  } catch {
    return false
  }
}

export async function findUnexploredPivots(username: string): Promise<PivotAnalysis> {
  const suggestions: PivotSuggestion[] = []

  // Bilinen tanımlayıcıları çek
  const known = await findLinkedIdentifiers(username)
  const connections = await getConnections(username)

  // İstatistik
  const stats = {
    totalNodes: connections.length,
    emails: known.emails.length,
    websites: known.websites.length,
    profiles: connections.filter(c => c.relation === 'HAS_PROFILE').length,
  }

  // 1. Email pivot — REGISTERED_ON kontrolü
  for (const email of known.emails) {
    const hasRegistration = await hasBeenPivoted(email, 'REGISTERED_ON')
    if (!hasRegistration) {
      suggestions.push({
        type: 'email_registration',
        target: email,
        tool: 'check_email_registrations',
        priority: 'high',
        reason: `"${email}" bulundu ama platform kayıtları (Holehe) kontrol edilmedi`,
      })
    }
  }

  // 2. Email pivot — LEAKED_IN kontrolü
  for (const email of known.emails) {
    const hasBreach = await hasBeenPivoted(email, 'LEAKED_IN')
    // NOT_LEAKED da kabul edilebilir (önceden kontrol edilmiş)
    const hasNotLeaked = await hasBeenPivoted(email, 'NOT_LEAKED')
    if (!hasBreach && !hasNotLeaked) {
      suggestions.push({
        type: 'email_breach',
        target: email,
        tool: 'check_breaches',
        priority: 'high',
        reason: `"${email}" veri sızıntılarında kontrol edilmedi`,
      })
    }
  }

  // 3. Website scrape kontrolü
  for (const website of known.websites) {
    const hasScraped = await hasBeenPivoted(website, 'SCRAPE_FOUND')
    if (!hasScraped && !website.includes('github.com')) {
      suggestions.push({
        type: 'scrape_website',
        target: website,
        tool: 'scrape_profile',
        priority: 'medium',
        reason: `"${website}" henüz scrape edilmedi — email, kripto cüzdan veya başka linkler olabilir`,
      })
    }
  }

  // 4. Twitter handle kontrolü
  const twitterHandles = connections
    .filter(c => c.relation === 'TWITTER_ACCOUNT')
    .map(c => c.to)

  for (const handle of twitterHandles) {
    // Twitter profili çekilmiş mi? (scrapling stealth)
    const handleConnections = await getConnections(handle)
    const hasTwitterData = handleConnections.some(c =>
      c.source === 'nitter' || c.source === 'scrapling-stealth' || c.source === 'scrapling-dynamic'
    )
    if (!hasTwitterData) {
      suggestions.push({
        type: 'twitter_profile',
        target: handle,
        tool: 'nitter_profile',
        priority: 'medium',
        reason: `Twitter handle "@${handle}" bulundu ama profil bilgisi çekilmedi`,
      })
    }
  }

  // 5. Sherlock profillerinin doğrulaması
  const profileCount = stats.profiles
  if (profileCount > 0) {
    const alreadyVerified = await hasVerifiedProfiles(username)
    if (!alreadyVerified) {
      suggestions.push({
        type: 'verify_profiles',
        target: username,
        tool: 'verify_profiles',
        priority: 'medium',
        reason: `${profileCount} Sherlock profili var ama hiçbiri çapraz doğrulanmadı`,
      })
    }
  }

  // 6. GitHub deep mod
  const hasFollows = connections.some(c => c.relation === 'FOLLOWS')
  const hasGithub = connections.some(c =>
    c.relation === 'HAS_PROFILE' && c.to.includes('github.com')
  )
  if (hasGithub && !hasFollows) {
    suggestions.push({
      type: 'deep_github',
      target: username,
      tool: 'run_github_osint (deep=true)',
      priority: 'low',
      reason: `GitHub profili var ama following analizi yapılmadı — sosyal çevre haritası çıkar`,
    })
  }

  // Öncelik sırası: high > medium > low
  const priorityOrder = { high: 0, medium: 1, low: 2 }
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

  return { username, suggestions, stats }
}

export function formatUnexploredPivots(analysis: PivotAnalysis): string {
  const { username, suggestions, stats } = analysis

  if (suggestions.length === 0) {
    return `✅ "${username}" için tüm bilinen pivot noktaları araştırılmış. Yeni bilgi lazım — yeni bir username veya email ile genişletebilirsin.`
  }

  const lines: string[] = [
    `🧭 KEŞFEDİLMEMİŞ PİVOT ANALİZİ: @${username}`,
    `Grafta: ${stats.emails} email, ${stats.websites} website, ${stats.profiles} profil`,
    '',
    `📋 ${suggestions.length} Araştırılmamış Fırsat:`,
    '',
  ]

  const icons: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  }

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i]
    lines.push(`${i + 1}. ${icons[s.priority]} [${s.priority.toUpperCase()}] ${s.reason}`)
    lines.push(`   → Araç: ${s.tool} | Hedef: ${s.target}`)
    lines.push('')
  }

  lines.push(`💡 En verimli sonraki adım: "${suggestions[0].tool}" ile "${suggestions[0].target}" araştır.`)

  return lines.join('\n')
}

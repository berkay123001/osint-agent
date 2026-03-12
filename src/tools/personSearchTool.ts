/**
 * İsim→Kişi Pivotu — gerçek isimden araştırma başlatma aracı.
 * Grafta ters arama yapar, web'de isim araması önerir,
 * olası username'ler türetir.
 *
 * ÖNEMLİ: Yaygın isimler (Mehmet Yılmaz, Ali Demir) ile arama
 * yanlış pozitif riski yüksektir. Bu nedenle:
 * - Mümkünse ek bağlam (şehir, kurum, meslek) kullan
 * - Grafta zaten varsa, mevcut tanımlayıcılarla pivot yap
 * - Web araması sonuçları "low" güven seviyesidir
 */

import { findPersonByName } from '../lib/neo4j.js'
import { searchWeb } from './searchTool.js'

export interface PersonSearchResult {
  name: string
  graphMatches: Array<{
    personName: string
    linkedUsernames: string[]
    linkedEmails: string[]
    linkedLocations: string[]
    linkedOrganizations: string[]
  }>
  suggestedUsernames: string[]
  webResults: Array<{
    title: string
    snippet: string
    url: string
  }>
  error?: string
}

/**
 * İsimden olası username'ler türet.
 * Örn: "Berkay Hasırcı" → ["berkayhasirci", "bhasirci", "berkay-hasirci", "hasirciberkay"]
 */
function generateUsernameVariants(fullName: string): string[] {
  const parts = fullName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // aksan kaldır
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length < 2) return parts

  const first = parts[0]
  const last = parts[parts.length - 1]

  return [
    `${first}${last}`,           // berkayhasirci
    `${first}.${last}`,          // berkay.hasirci
    `${first}-${last}`,          // berkay-hasirci
    `${first}_${last}`,          // berkay_hasirci
    `${first[0]}${last}`,        // bhasirci
    `${last}${first}`,           // hasirciberkay
    `${last}${first[0]}`,        // hasircib
    `${first}${last[0]}`,        // berkayh
  ]
}

/**
 * Gerçek isimle OSINT araştırması başlat.
 * 1. Grafta ters arama (Person node → Username/Email)
 * 2. Olası username türetme
 * 3. Opsiyonel: web araması (context ile birlikte)
 */
export async function searchPerson(
  name: string,
  context?: string
): Promise<PersonSearchResult> {
  const result: PersonSearchResult = {
    name,
    graphMatches: [],
    suggestedUsernames: [],
    webResults: [],
  }

  // 1. Grafta ters arama
  try {
    result.graphMatches = await findPersonByName(name)
  } catch {
    // Neo4j bağlantısı yoksa devam et
  }

  // 2. Username türetme
  result.suggestedUsernames = generateUsernameVariants(name)

  // 3. Web araması (isim + opsiyonel bağlam)
  const query = context
    ? `"${name}" ${context}`
    : `"${name}" site:github.com OR site:linkedin.com OR site:twitter.com`

  try {
    const webResult = await searchWeb(query, 5)
    if (!webResult.error) {
      result.webResults = webResult.results
    } else {
      result.error = webResult.error
    }
  } catch (e) {
    result.error = `Web arama hatası: ${(e as Error).message}`
  }

  return result
}

export function formatPersonSearchResult(result: PersonSearchResult): string {
  const lines: string[] = [
    `👤 İsim Araştırması: "${result.name}"`,
    '',
  ]

  // Graf sonuçları
  if (result.graphMatches.length > 0) {
    lines.push('📊 **Grafta Bulunan Eşleşmeler:**')
    for (const match of result.graphMatches) {
      lines.push(`  → ${match.personName}`)
      if (match.linkedUsernames.length > 0) lines.push(`    Kullanıcılar: ${match.linkedUsernames.join(', ')}`)
      if (match.linkedEmails.length > 0) lines.push(`    Email'ler: ${match.linkedEmails.join(', ')}`)
      if (match.linkedLocations.length > 0) lines.push(`    Konum: ${match.linkedLocations.join(', ')}`)
      if (match.linkedOrganizations.length > 0) lines.push(`    Kurum: ${match.linkedOrganizations.join(', ')}`)
    }
    lines.push('')
    lines.push('💡 Grafta eşleşme var — mevcut username/email ile devam edebilirsin.')
  } else {
    lines.push('📊 Grafta bu isimle eşleşen Person node bulunamadı.')
  }

  lines.push('')

  // Türetilmiş username'ler
  if (result.suggestedUsernames.length > 0) {
    lines.push('🔤 **Olası Username Tahminleri:**')
    lines.push(`  ${result.suggestedUsernames.join(', ')}`)
    lines.push('  ⚠️ Bunlar TAHMİNDİR (low confidence). Sherlock ile doğrula.')
  }

  lines.push('')

  // Web sonuçları
  if (result.webResults.length > 0) {
    lines.push('🔍 **Web Arama Sonuçları:**')
    for (const r of result.webResults) {
      lines.push(`  → ${r.title}`)
      lines.push(`    ${r.url}`)
      lines.push(`    ${r.snippet.slice(0, 200)}`)
      lines.push('')
    }
    lines.push('⚠️ Web sonuçları "low" güven seviyesidir — çapraz doğrulama gerekli.')
  }

  if (result.error) {
    lines.push(`❌ ${result.error}`)
  }

  return lines.join('\n')
}

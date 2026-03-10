import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const USER_AGENT = 'OSINT-Agent/1.0 (Node.js)'

export interface BreachRecord {
  name: string
  domain: string
  breachDate: string
  dataClasses: string[]
  description?: string
}

export interface BreachCheckResult {
  email: string
  breaches: BreachRecord[]
  source: 'hibp' | 'local' | 'none'
  error?: string
}

/**
 * Email adresinin veri sızıntılarında olup olmadığını kontrol eder.
 * Öncelik sırası:
 * 1. HIBP API (Have I Been Pwned) — HIBP_API_KEY .env'de varsa
 * 2. Lokal test sızıntı veritabanı — her zaman fallback olarak kullanılabilir
 */
export async function checkBreaches(email: string): Promise<BreachCheckResult> {
  const hibpKey = process.env.HIBP_API_KEY

  // HIBP API varsa önce onu dene
  if (hibpKey) {
    try {
      return await checkHibp(email, hibpKey)
    } catch (e) {
      // HIBP başarısızsa lokal'e düş
    }
  }

  // Lokal test veritabanı
  return checkLocalBreaches(email)
}

/** Have I Been Pwned API v3 sorgusu */
async function checkHibp(email: string, apiKey: string): Promise<BreachCheckResult> {
  const encodedEmail = encodeURIComponent(email)
  const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodedEmail}?truncateResponse=false`

  try {
    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-H', `hibp-api-key: ${apiKey}`,
      '-H', `user-agent: ${USER_AGENT}`,
      '-w', '\n%{http_code}',
      url,
    ], { timeout: 15_000 })

    const lines = stdout.trim().split('\n')
    const httpCode = lines[lines.length - 1]
    const body = lines.slice(0, -1).join('\n')

    if (httpCode === '404') {
      return { email, breaches: [], source: 'hibp' }
    }

    if (httpCode === '401') {
      return { email, breaches: [], source: 'none', error: 'HIBP API key geçersiz' }
    }

    if (httpCode === '429') {
      return { email, breaches: [], source: 'none', error: 'HIBP rate limit — biraz bekleyip tekrar deneyin' }
    }

    if (httpCode !== '200') {
      return { email, breaches: [], source: 'none', error: `HIBP HTTP ${httpCode}` }
    }

    const data = JSON.parse(body) as Array<{
      Name: string
      Domain: string
      BreachDate: string
      DataClasses: string[]
      Description: string
    }>

    const breaches: BreachRecord[] = data.map((b) => ({
      name: b.Name,
      domain: b.Domain,
      breachDate: b.BreachDate,
      dataClasses: b.DataClasses,
      description: b.Description,
    }))

    return { email, breaches, source: 'hibp' }
  } catch (e) {
    return { email, breaches: [], source: 'none', error: `HIBP hatası: ${(e as Error).message}` }
  }
}

/** Lokal test sızıntı veritabanı — demo ve test senaryoları için */
async function checkLocalBreaches(email: string): Promise<BreachCheckResult> {
  const dbPath = path.resolve(__dirname, 'breachData', 'testBreaches.json')

  try {
    const raw = await fs.readFile(dbPath, 'utf-8')
    const db = JSON.parse(raw) as Record<string, BreachRecord[]>
    const normalizedEmail = email.toLowerCase().trim()

    const found = db[normalizedEmail]
    if (found && found.length > 0) {
      return { email, breaches: found, source: 'local' }
    }

    return { email, breaches: [], source: 'local' }
  } catch {
    return {
      email,
      breaches: [],
      source: 'none',
      error: 'HIBP_API_KEY tanımlı değil ve lokal sızıntı veritabanı bulunamadı. .env dosyasına HIBP_API_KEY ekleyin veya src/tools/breachData/testBreaches.json oluşturun.',
    }
  }
}

/** Breach sonuçlarını okunabilir formata dönüştür */
export function formatBreachResult(result: BreachCheckResult): string {
  if (result.error) {
    return `Sızıntı kontrolü hatası: ${result.error}`
  }

  const lines = [
    `🔓 Veri Sızıntısı Kontrolü: ${result.email}`,
    `Kaynak: ${result.source === 'hibp' ? 'Have I Been Pwned (HIBP)' : result.source === 'local' ? 'Lokal test veritabanı' : 'Kontrol yapılamadı'}`,
    '',
  ]

  if (result.breaches.length === 0) {
    lines.push('✅ Bu email bilinen hiçbir veri sızıntısında bulunamadı.')
    return lines.join('\n')
  }

  lines.push(`⚠️ ${result.breaches.length} veri sızıntısında bulundu:`)
  lines.push('')

  for (const b of result.breaches) {
    lines.push(`🔴 ${b.name} (${b.domain})`)
    lines.push(`   Tarih: ${b.breachDate}`)
    lines.push(`   Sızan veriler: ${b.dataClasses.join(', ')}`)
    if (b.description) {
      // HTML tag'lerini temizle
      const cleanDesc = b.description.replace(/<[^>]+>/g, '').slice(0, 200)
      lines.push(`   Açıklama: ${cleanDesc}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

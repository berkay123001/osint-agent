import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'
const RUNNER_SCRIPT = path.resolve(__dirname, 'holehe_runner.py')

export interface HoleheService {
  name: string
  exists: boolean
  emailrecovery: string | null
  phoneNumber: string | null
  others: string | null
}

export interface HoleheResult {
  email: string
  services: HoleheService[]
  totalChecked: number
  rateLimitedCount?: number
  rateLimitedPlatforms?: string[]
  error?: string
}

/**
 * Email adresinin hangi platformlarda kayıtlı olduğunu kontrol eder (Holehe).
 * Pivot noktası olarak kullanılır: Email → Platform bağlantısı kurar.
 */
export async function checkEmailRegistrations(email: string): Promise<HoleheResult> {
  // Güvenlik: geçersiz email subprocess'e geçmesin
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { email, services: [], totalChecked: 0, error: `Geçersiz e-posta formatı: ${email}` }
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON,
      [RUNNER_SCRIPT, email],
      { timeout: 120_000 }
    )

    if (!stdout.trim()) {
      return { email, services: [], totalChecked: 0, error: stderr?.trim() || 'Holehe boş çıktı döndürdü' }
    }

    const parsed = JSON.parse(stdout.trim()) as HoleheResult
    return parsed
  } catch (e) {
    const msg = (e as Error).message
    return { email, services: [], totalChecked: 0, error: `Holehe hatası: ${msg}` }
  }
}

/** Holehe sonuçlarını okunabilir formatta döndür */
export function formatHoleheResult(result: HoleheResult): string {
  if (result.error) {
    return `Email kayıt kontrolü hatası: ${result.error}`
  }

  const rlInfo = result.rateLimitedCount
    ? ` | Rate limit: ${result.rateLimitedCount} (atlandı)`
    : ''

  const lines = [
    `📧 Email Kayıt Kontrolü: ${result.email}`,
    `Taranan platform: ${result.totalChecked} | Kayıtlı bulunan: ${result.services.length}${rlInfo}`,
    '',
  ]

  if (result.services.length === 0) {
    lines.push('Bu email herhangi bir platformda kayıtlı bulunamadı.')
    return lines.join('\n')
  }

  for (const s of result.services) {
    let detail = `[+] ${s.name}`
    if (s.emailrecovery) detail += ` (recovery: ${s.emailrecovery})`
    if (s.phoneNumber) detail += ` (tel: ${s.phoneNumber})`
    if (s.others) {
      const othersStr = typeof s.others === 'object' ? JSON.stringify(s.others) : String(s.others)
      detail += ` (${othersStr})`
    }
    lines.push(detail)
  }

  return lines.join('\n')
}

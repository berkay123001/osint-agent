import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'
const RUNNER_SCRIPT = path.resolve(__dirname, 'maigret_runner.py')

export interface MaigretSite {
  site: string
  url: string
  ids: Record<string, string>
}

export interface MaigretResult {
  username: string
  found: MaigretSite[]
  foundCount: number
  checkedCount: number
  error?: string
}

/**
 * Username için Maigret ile 3000+ platformda hesap araması yapar.
 * Sherlock'un tamamlayıcısı — farklı kontrol metodları kullanır,
 * Pinterest/Discord/Facebook/Instagram gibi platformları kapsar.
 *
 * @param username  Aranacak kullanıcı adı
 * @param topSites  Kaç siteyi tara (varsayılan: 500, max: ~3000)
 * @param timeout   Her istek için timeout (saniye, varsayılan: 20)
 */
export async function runMaigret(
  username: string,
  topSites = 500,
  timeout = 20,
): Promise<MaigretResult> {
  // Güvenlik: username formatı doğrulama
  if (!/^[A-Za-z0-9_.\-]{1,50}$/.test(username)) {
    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Geçersiz username formatı: ${username}` }
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON,
      [RUNNER_SCRIPT, username, String(topSites), String(timeout)],
      { timeout: 300_000 }, // 5 dakika max (500 site × 20s / 10 concurrent)
    )

    if (!stdout.trim()) {
      return { username, found: [], foundCount: 0, checkedCount: 0, error: stderr?.trim() || 'Maigret boş çıktı döndürdü' }
    }

    return JSON.parse(stdout.trim()) as MaigretResult
  } catch (e) {
    const msg = (e as Error).message
    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Maigret hatası: ${msg}` }
  }
}

/** Maigret sonuçlarını okunabilir formatta döndür */
export function formatMaigretResult(result: MaigretResult): string {
  if (result.error) {
    return `Maigret hatası: ${result.error}`
  }

  const lines = [
    `🔍 Maigret — Username: ${result.username}`,
    `Taranan: ${result.checkedCount} platform | Bulunan: ${result.foundCount}`,
    '',
  ]

  if (result.foundCount === 0) {
    lines.push('Bu username hiçbir platformda bulunamadı.')
    return lines.join('\n')
  }

  for (const s of result.found) {
    let line = `[+] ${s.site}: ${s.url}`
    const extras = Object.entries(s.ids)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')
    if (extras) line += ` (${extras})`
    lines.push(line)
  }

  return lines.join('\n')
}

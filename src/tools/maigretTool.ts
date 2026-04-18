import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || 'python3'
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
 * Searches 3000+ platforms for an account with the given username using Maigret.
 * Complements Sherlock — uses different check methods,
 * covering platforms like Pinterest, Discord, Facebook, and Instagram.
 *
 * @param username  Username to search for
 * @param topSites  How many sites to scan (default: 500, max: ~3000)
 * @param timeout   Timeout per request in seconds (default: 20)
 */
export async function runMaigret(
  username: string,
  topSites = 500,
  timeout = 20,
): Promise<MaigretResult> {
  // Security: validate username format
  if (!/^[A-Za-z0-9_.\-]{1,50}$/.test(username)) {
    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Invalid username format: ${username}` }
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON,
      [RUNNER_SCRIPT, username, String(topSites), String(timeout)],
      { timeout: 300_000 }, // 5 dakika max (500 site × 20s / 10 concurrent)
    )

    if (!stdout.trim()) {
      return { username, found: [], foundCount: 0, checkedCount: 0, error: stderr?.trim() || 'Maigret returned empty output' }
    }

    return JSON.parse(stdout.trim()) as MaigretResult
  } catch (e) {
    const msg = (e as Error).message
    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Maigret error: ${msg}` }
  }
}

/** Return Maigret results in a human-readable format */
export function formatMaigretResult(result: MaigretResult): string {
  if (result.error) {
    return `Maigret error: ${result.error}`
  }

  const lines = [
    `🔍 Maigret — Username: ${result.username}`,
    `Taranan: ${result.checkedCount} platform | Bulunan: ${result.foundCount}`,
    '',
  ]

  if (result.foundCount === 0) {
    lines.push('This username was not found on any platform.')
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

import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || 'python3'
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
 * Checks which platforms an email address is registered on (Holehe).
 * Used as a pivot point: Email → Platform connection.
 */
export async function checkEmailRegistrations(email: string): Promise<HoleheResult> {
  // Security: prevent invalid email from reaching the subprocess
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { email, services: [], totalChecked: 0, error: `Invalid email format: ${email}` }
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON,
      [RUNNER_SCRIPT, email],
      { timeout: 180_000 }
    )

    if (!stdout.trim()) {
      return { email, services: [], totalChecked: 0, error: stderr?.trim() || 'Holehe returned empty output' }
    }

    const parsed = JSON.parse(stdout.trim()) as HoleheResult
    return parsed
  } catch (e) {
    const msg = (e as Error).message
    return { email, services: [], totalChecked: 0, error: `Holehe error: ${msg}` }
  }
}

/** Return Holehe results in a human-readable format */
export function formatHoleheResult(result: HoleheResult): string {
  if (result.error) {
    return `Email registration check error: ${result.error}`
  }

  const rlInfo = result.rateLimitedCount
    ? ` | Rate limit: ${result.rateLimitedCount} (skipped)`
    : ''

  const lines = [
    `📧 Email Registration Check: ${result.email}`,
    `Platforms scanned: ${result.totalChecked} | Registered on: ${result.services.length}${rlInfo}`,
    '',
  ]

  if (result.services.length === 0) {
    lines.push('This email was not found registered on any platform.')
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

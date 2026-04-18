import { z } from 'zod'
import { spawn, SpawnOptions, execSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ai } from '../lib/ai.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || 'python3'

/** Resolve sherlock binary path — check explicit env, anaconda, then system PATH */
function resolveSherlockBin(): string {
  if (process.env.SHERLOCK_BIN && process.env.SHERLOCK_BIN !== 'sherlock') {
    return process.env.SHERLOCK_BIN
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = [
    path.join(homeDir, 'anaconda3', 'bin', 'sherlock'),
    path.join(homeDir, 'miniconda3', 'bin', 'sherlock'),
    path.join(homeDir, '.local', 'bin', 'sherlock'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Last resort: try which/where command
  try {
    const which = execSync('which sherlock 2>/dev/null || where sherlock 2>/dev/null', { encoding: 'utf-8' }).trim()
    if (which) return which
  } catch { /* not found */ }
  return 'sherlock' // fallback to system PATH
}

const SHERLOCK_BIN = resolveSherlockBin()

export const sherlockTool = ai.defineTool(
  {
    name: 'runSherlock',
    description: 'Searches a username across 400+ social platforms and returns found profile URLs',
    inputSchema: z.object({
      username: z.string().describe('The username/nickname to search for'),
    }),
    outputSchema: z.object({
      username: z.string(),
      foundPlatforms: z.array(
        z.object({
          platform: z.string(),
          url: z.string(),
        })
      ),
    }),
  },
  async (input) => {
    const results = await runSherlockCLI(input.username)
    return {
      username: input.username,
      foundPlatforms: results,
    }
  }
)

// Spawn function type — mockable for tests
type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ReturnType<typeof spawn>

export function runSherlockCLI(
  username: string,
  spawnFn: SpawnFunction = spawn
): Promise<Array<{ platform: string; url: string }>> {
  return new Promise((resolve, reject) => {
    // Prefer resolved binary path, fallback to python -m
    const useDirectBin = process.env.SHERLOCK_BIN !== '0'
    const command = useDirectBin ? SHERLOCK_BIN : PYTHON
    const args = useDirectBin
      ? [username, '--print-found', '--json', '-']
      : ['-m', 'sherlock_project', username, '--print-found', '--json', '-']
    const proc = spawnFn(command, args, { timeout: 120000 })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('Sherlock stderr:', stderr.slice(0, 500))
      }
      try {
        const json = JSON.parse(stdout)
        const platforms = Object.entries(json)
          .map(([platform, data]) => ({
            platform,
            url: (data as Record<string, string>)?.url_user || '',
          }))
          .filter((p) => p.url)
        resolve(platforms)
      } catch {
        const urlRegex = /https?:\/\/[^\s]+/g
        const urls = stdout.match(urlRegex) || []
        resolve(urls.map((url) => ({ platform: 'unknown', url })))
      }
    })

    proc.on('error', (err) => reject(err))
  })
}

import { z } from 'zod'
import { spawn, SpawnOptions } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { ai } from '../lib/ai.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'
const SHERLOCK_DIR = path.resolve(__dirname, '../../../osint_collection/sherlock')

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

// Spawn fonksiyon tipi - test için mock'lanabilir
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
    const args = ['-m', 'sherlock_project', username, '--print-found', '--json', '-']
    const proc = spawnFn(PYTHON, args, { cwd: SHERLOCK_DIR, timeout: 120000 })

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

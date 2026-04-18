/**
 * Obsidian Vault Tools
 *
 * Enables the agent to actively use its own Obsidian workspace:
 * - obsidian_write  : Write / update any note in the Vault
 * - obsidian_append : Append content to an existing note
 * - obsidian_read   : Read a note from the Vault
 * - obsidian_daily  : Add an entry to the daily log (auto-dated)
 * - obsidian_list   : List directories/files inside the Vault
 */

import { mkdir, writeFile, readFile, appendFile, readdir, stat } from 'fs/promises'
import path from 'path'
import os from 'os'

// ─── Constants ──────────────────────────────────────────────────────────────
export const VAULT_ROOT = process.env.OBSIDIAN_VAULT ||
  path.resolve(process.env.HOME ?? os.homedir(), 'Agent_Knowladges/OSINT/OSINT-Agent')

const DAILY_DIR = path.join(VAULT_ROOT, '06 - Daily')
const NOTES_DIR = path.join(VAULT_ROOT, '07 - Notlar')      // agent's free note area
const PROFILES_DIR = path.join(VAULT_ROOT, '08 - Profiller') // investigated person profiles

/** Prevent escaping outside the Vault (path traversal security) */
function safePath(relativePath: string): string {
  const resolved = path.resolve(VAULT_ROOT, relativePath)
  if (!resolved.startsWith(VAULT_ROOT)) {
    throw new Error(`Access outside Vault is forbidden: ${relativePath}`)
  }
  return resolved
}

/** Returns today's date in YYYY-MM-DD format */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ─── Tool functions ──────────────────────────────────────────────────────────

/**
 * Create or fully update a note in the Vault.
 * @param notePath  Relative path from Vault root, e.g. "07 - Notlar/user-preferences.md"
 * @param content   Note content (Markdown)
 * @param overwrite true → overwrite, false → only create if it doesn't exist (default: true)
 */
export async function obsidianWrite(
  notePath: string,
  content: string,
  overwrite = true,
): Promise<string> {
  const full = safePath(notePath)
  await mkdir(path.dirname(full), { recursive: true })

  if (!overwrite) {
    try {
      await stat(full)
      return `⏩ Already exists, not overwritten: ${notePath}`
    } catch {
      // File does not exist → create
    }
  }

  await writeFile(full, content, 'utf8')
  return `✅ Written: ${notePath}`
}

/**
 * Append content to the end of an existing note. Creates the file if it doesn't exist.
 */
export async function obsidianAppend(notePath: string, content: string): Promise<string> {
  const full = safePath(notePath)
  await mkdir(path.dirname(full), { recursive: true })
  await appendFile(full, '\n' + content, 'utf8')
  return `✅ Appended: ${notePath}`
}

/**
 * Read a note from the Vault.
 */
export async function obsidianRead(notePath: string): Promise<string> {
  const full = safePath(notePath)
  try {
    const content = await readFile(full, 'utf8')
    return content
  } catch {
    return `❌ File not found: ${notePath}`
  }
}

/**
 * Adds an entry to today's daily log note.
 * Creates a new titled daily page if the file does not exist.
 * @param entry  Text to record (single sentence or Markdown block)
 * @param tag    Optional tag: "research" | "user-pref" | "observation" | "reminder"
 */
export async function obsidianDailyLog(entry: string, tag?: string): Promise<string> {
  const date = today()
  const fileName = `${date}.md`
  const full = path.join(DAILY_DIR, fileName)
  const relPath = path.join('06 - Daily', fileName)

  await mkdir(DAILY_DIR, { recursive: true })

  // Create header if file doesn't exist
  let exists = false
  try {
    await stat(full)
    exists = true
  } catch {
    const header = `# ${date} — Daily Log\n\n`
    await writeFile(full, header, 'utf8')
  }

  const timestamp = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  const tagStr = tag ? ` #${tag}` : ''
  const line = `\n## ${timestamp}${tagStr}\n${entry}\n`

  await appendFile(full, line, 'utf8')
  return `✅ Saved to daily log: ${relPath} (${exists ? 'appended to existing file' : 'new daily log created'})`
}

/**
 * List a directory inside the Vault (non-recursive).
 * @param dir Relative path, or leave empty to list the vault root
 */
export async function obsidianList(dir = ''): Promise<string> {
  const full = dir ? safePath(dir) : VAULT_ROOT
  try {
    const entries = await readdir(full, { withFileTypes: true })
    const lines = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
    return lines.length > 0 ? lines.join('\n') : '(empty directory)'
  } catch {
    return `❌ Directory not found: ${dir || '(vault root)'}`
  }
}

/**
 * Recursively walks all .md files inside the Vault.
 * Skips hidden files/directories (.).
 */
async function walkMdFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await walkMdFiles(full)
      results.push(...sub)
    } else if (entry.name.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

/**
 * Search for a keyword inside the Vault.
 * Scans all .md files and returns matching files with context lines.
 * @param query  Text to search for (case-insensitive)
 * @param limit  Maximum number of results (default: 10)
 */
export async function obsidianSearch(query: string, limit = 10): Promise<string> {
  const q = query.toLowerCase()
  const allFiles = await walkMdFiles(VAULT_ROOT)
  const matches: Array<{ relPath: string; contextLines: string[] }> = []

  for (const filePath of allFiles) {
    if (matches.length >= limit) break
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    const contextLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        const start = Math.max(0, i - 1)
        const end = Math.min(lines.length - 1, i + 1)
        for (let j = start; j <= end; j++) {
          contextLines.push(`  L${j + 1}: ${lines[j]}`)
        }
        contextLines.push('  ---')
      }
    }

    if (contextLines.length > 0) {
      const relPath = path.relative(VAULT_ROOT, filePath)
      matches.push({ relPath, contextLines })
    }
  }

  if (matches.length === 0) {
    return `🔍 No results found for "${query}".`
  }

  const output = matches.map(m =>
    `📄 **${m.relPath}**\n${m.contextLines.join('\n')}`
  ).join('\n\n')

  return `🔍 "${query}" — found in ${matches.length} file(s):\n\n${output}`
}

/**
 * Create or update a profile page for the investigated person.
 * Structured metadata via frontmatter + Markdown summary.
 * @param username  Profile owner (used as the filename)
 * @param content   Profile content (Markdown)
 * @param metadata  Optional frontmatter fields
 */
export interface ProfileMetadata {
  realName?: string
  emails?: string[]
  platforms?: string[]
  breachCount?: number
  confidence?: 'verified' | 'high' | 'medium' | 'low'
  investigatedAt?: string
}

export async function obsidianWriteProfile(
  username: string,
  content: string,
  metadata?: ProfileMetadata,
): Promise<string> {
  const safeName = username
    .replace(/[Ğğ]/g, 'G').replace(/[Üü]/g, 'U').replace(/[Şş]/g, 'S')
    .replace(/[İı]/g, 'I').replace(/[Öö]/g, 'O').replace(/[Çç]/g, 'C')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
  const fileName = `${safeName}.md`
  const full = path.join(PROFILES_DIR, fileName)
  await mkdir(PROFILES_DIR, { recursive: true })

  const now = new Date().toISOString()
  const frontmatter: string[] = ['---']
  frontmatter.push(`username: "${username}"`)
  frontmatter.push(`created: "${now}"`)
  if (metadata?.realName) frontmatter.push(`realName: "${metadata.realName}"`)
  if (metadata?.emails?.length) frontmatter.push(`emails: [${metadata.emails.map(e => `"${e}"`).join(', ')}]`)
  if (metadata?.platforms?.length) frontmatter.push(`platforms: [${metadata.platforms.map(p => `"${p}"`).join(', ')}]`)
  if (metadata?.breachCount !== undefined) frontmatter.push(`breachCount: ${metadata.breachCount}`)
  if (metadata?.confidence) frontmatter.push(`confidence: ${metadata.confidence}`)
  frontmatter.push('---')

  const body = `${frontmatter.join('\n')}\n\n${content}\n`
  await writeFile(full, body, 'utf8')

  const relPath = path.join('08 - Profiller', fileName)
  return `✅ Profile saved: ${relPath}`
}

// ─── Ensure required directories exist ─────────────────────────────────────
export async function ensureVaultDirs(): Promise<void> {
  await Promise.all([
    mkdir(NOTES_DIR, { recursive: true }),
    mkdir(PROFILES_DIR, { recursive: true }),
    mkdir(DAILY_DIR, { recursive: true }),
  ])
}

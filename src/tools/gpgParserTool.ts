/**
 * GPG Key Parser Tool — extracts email, name, and metadata from a GPG public key.
 * GitHub'daki .gpg endpoint'inden key indirir ve gpg --list-packets ile parse eder.
 * Used in OSINT to find the real email of users with hidden commit emails.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { webFetch } from './webFetchTool.js'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { hasUsableGithubGpgKey, isGithubNoGpgPlaceholder } from './githubGpgUtils.js'

const execFileAsync = promisify(execFile)

export interface GpgKeyInfo {
  source: string
  emails: string[]
  names: string[]
  keyId: string | null
  created: string | null
  algorithm: string | null
  rawOutput: string
  error?: string
}

/**
 * Extracts email and name from a GPG key file.
 */
export async function parseGpgKeyFile(filePath: string): Promise<GpgKeyInfo> {
  const result: GpgKeyInfo = {
    source: filePath,
    emails: [],
    names: [],
    keyId: null,
    created: null,
    algorithm: null,
    rawOutput: '',
  }

  try {
    // Method 1: gpg --list-packets (most detailed)
    const { stdout: packetsOutput } = await execFileAsync('gpg', [
      '--list-packets',
      '--no-default-keyring',
      filePath,
    ], { timeout: 10000 })

    result.rawOutput = packetsOutput

    // Extract email from User ID lines
    const uidRegex = /user ID(?: packet:)?[ \t]+"([^"]+)"/g
    let match
    while ((match = uidRegex.exec(packetsOutput)) !== null) {
      const uid = match[1]
      // Extract email (inside angle brackets or directly)
      const emailMatch = uid.match(/<([^>]+@[^>]+)>/) || uid.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
      if (emailMatch) {
        const email = emailMatch[1]
        if (!result.emails.includes(email)) result.emails.push(email)
      }
      // Extract name (portion before the email)
      const nameMatch = uid.match(/^([^<]+?)[\s]*</)
      if (nameMatch) {
        const name = nameMatch[1].trim()
        if (name && !result.names.includes(name)) result.names.push(name)
      }
      // Sadece isim varsa (email yoksa)
      if (!uid.includes('<') && !uid.includes('@')) {
        if (!result.names.includes(uid.trim())) result.names.push(uid.trim())
      }
    }

    // Extract Key ID
    const keyIdMatch = packetsOutput.match(/keyid\s+([A-F0-9]+)/i)
    if (keyIdMatch) result.keyId = keyIdMatch[1]

    // Algorithm
    const algoMatch = packetsOutput.match(/pkey\[0\]:\s*\[(\d+)\s+bits?\]/i)
    if (algoMatch) result.algorithm = `${algoMatch[1]} bit`

    // Method 2: gpg --import --dry-run (fallback, user-friendly output)
    if (result.emails.length === 0) {
      try {
        // Use temporary keyring
        const tmpDir = path.join(os.tmpdir(), `gpg-parse-${Date.now()}`)
        await fs.mkdir(tmpDir, { recursive: true })

        const { stderr: importOutput } = await execFileAsync('gpg', [
          '--homedir', tmpDir,
          '--import',
          '--batch',
          '--yes',
          filePath,
        ], { timeout: 10000 })

        const importEmailRegex = /<([^>]+@[^>]+)>/g
        let em
        while ((em = importEmailRegex.exec(importOutput)) !== null) {
          if (!result.emails.includes(em[1])) result.emails.push(em[1])
        }
        const importNameRegex = /uid.*?"([^"<]+?)[\s]*</g
        let nm
        while ((nm = importNameRegex.exec(importOutput)) !== null) {
          const name = nm[1].trim()
          if (name && !result.names.includes(name)) result.names.push(name)
        }

        // Cleanup
        await fs.rm(tmpDir, { recursive: true, force: true })
      } catch {
        // Fallback failed, that's ok
      }
    }
  } catch (e) {
    const fileContent = await fs.readFile(filePath, 'utf-8').catch(() => '')
    if (isGithubNoGpgPlaceholder(fileContent)) {
      result.error = 'No GPG key found for this GitHub user'
      return result
    }
    result.error = `GPG parse error: ${(e as Error).message}`
  }

  return result
}

/**
 * GitHub username'den GPG key indirip parse eder.
 * Uses the https://github.com/{username}.gpg endpoint.
 */
export async function parseGithubGpgKey(username: string): Promise<GpgKeyInfo> {
  const url = `https://github.com/${encodeURIComponent(username)}.gpg`
  const fetchResult = await webFetch(url, `${username}.gpg`)

  if (fetchResult.error || !fetchResult.savedTo) {
    return {
      source: url,
      emails: [],
      names: [],
      keyId: null,
      created: null,
      algorithm: null,
      rawOutput: '',
      error: fetchResult.error || 'GPG key indirilemedi',
    }
  }

  // Verify that the GPG key file is non-empty
  const content = await fs.readFile(fetchResult.savedTo, 'utf-8')
  if (isGithubNoGpgPlaceholder(content) || !hasUsableGithubGpgKey(content)) {
    return {
      source: url,
      emails: [],
      names: [],
      keyId: null,
      created: null,
      algorithm: null,
      rawOutput: content.slice(0, 200),
      error: `No GPG key found for ${username}`,
    }
  }

  const result = await parseGpgKeyFile(fetchResult.savedTo)
  return { ...result, source: url }
}

/**
 * Converts a GPG parse result to a human-readable text format.
 */
export function formatGpgResult(result: GpgKeyInfo): string {
  if (result.error) return `GPG Hata: ${result.error}`

  const lines: string[] = [`=== GPG Key Analizi: ${result.source} ===`]

  if (result.emails.length > 0) {
    lines.push(`\n📧 Bulunan email adresleri:`)
    for (const email of result.emails) {
      lines.push(`  - ${email}`)
    }
  }

  if (result.names.length > 0) {
    lines.push(`\n👤 Bulunan isimler:`)
    for (const name of result.names) {
      lines.push(`  - ${name}`)
    }
  }

  if (result.keyId) lines.push(`\n🔑 Key ID: ${result.keyId}`)
  if (result.algorithm) lines.push(`📏 Algorithm: ${result.algorithm}`)

  if (result.emails.length === 0 && result.names.length === 0) {
    lines.push('\n⚠️  No email or name found in the GPG key.')
  }

  return lines.join('\n')
}

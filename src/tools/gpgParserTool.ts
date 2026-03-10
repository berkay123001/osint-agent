/**
 * GPG Key Parser Tool — GPG public key'den email, isim ve metadata çıkarır.
 * GitHub'daki .gpg endpoint'inden key indirir ve gpg --list-packets ile parse eder.
 * OSINT'te commit email gizlenmiş kullanıcıların gerçek email'ini bulmak için kullanılır.
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
 * GPG key dosyasından email ve isim çıkarır.
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
    // Method 1: gpg --list-packets (en detaylı)
    const { stdout: packetsOutput } = await execFileAsync('gpg', [
      '--list-packets',
      '--no-default-keyring',
      filePath,
    ], { timeout: 10000 })

    result.rawOutput = packetsOutput

    // User ID satırlarından email çıkar
    const uidRegex = /user ID(?: packet:)?[ \t]+"([^"]+)"/g
    let match
    while ((match = uidRegex.exec(packetsOutput)) !== null) {
      const uid = match[1]
      // Email çıkar (köşeli parantez içinde veya doğrudan)
      const emailMatch = uid.match(/<([^>]+@[^>]+)>/) || uid.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
      if (emailMatch) {
        const email = emailMatch[1]
        if (!result.emails.includes(email)) result.emails.push(email)
      }
      // İsim çıkar (email'den önceki kısım)
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

    // Key ID çıkar
    const keyIdMatch = packetsOutput.match(/keyid\s+([A-F0-9]+)/i)
    if (keyIdMatch) result.keyId = keyIdMatch[1]

    // Algorithm
    const algoMatch = packetsOutput.match(/pkey\[0\]:\s*\[(\d+)\s+bits?\]/i)
    if (algoMatch) result.algorithm = `${algoMatch[1]} bit`

    // Method 2: gpg --import --dry-run (fallback, user-friendly output)
    if (result.emails.length === 0) {
      try {
        // Geçici keyring kullan
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
      result.error = 'GitHub kullanıcısı için GPG key bulunamadı'
      return result
    }
    result.error = `GPG parse hatası: ${(e as Error).message}`
  }

  return result
}

/**
 * GitHub username'den GPG key indirip parse eder.
 * https://github.com/{username}.gpg endpoint'ini kullanır.
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

  // GPG key dosyasının boş olmadığını kontrol et
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
      error: `${username} için GPG key bulunamadı`,
    }
  }

  const result = await parseGpgKeyFile(fetchResult.savedTo)
  return { ...result, source: url }
}

/**
 * GPG parse sonucunu okunabilir metin formatına çevirir.
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
    lines.push('\n⚠️  GPG key\'de email veya isim bulunamadı.')
  }

  return lines.join('\n')
}

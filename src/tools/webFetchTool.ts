/**
 * Web Fetch Tool — URL'den dosya indirir veya sayfa içeriğini çeker.
 * curl kullanır, metadata koruyarak indirir.
 * OSINT'te dosya analizi, GPG key indirme, sayfa içeriği çekme için kullanılır.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'

const execFileAsync = promisify(execFile)
const TIMEOUT = 20000

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export interface FetchResult {
  url: string
  contentType: string
  savedTo: string | null
  textContent: string | null
  statusCode: number
  error?: string
}

/**
 * URL'den dosya indirir ve /tmp/osint-downloads/ altına kaydeder.
 * Eğer metin içerik ise textContent olarak da döner.
 */
export async function webFetch(url: string, saveAs?: string): Promise<FetchResult> {
  const result: FetchResult = {
    url,
    contentType: '',
    savedTo: null,
    textContent: null,
    statusCode: 0,
  }

  // URL validation
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    result.error = `Geçersiz URL: ${url}`
    return result
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    result.error = `Sadece http/https desteklenir: ${parsed.protocol}`
    return result
  }

  // Block private/internal IPs (SSRF protection)
  const hostname = parsed.hostname
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.') ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  ) {
    result.error = `İç ağ adreslerine erişim engellendi: ${hostname}`
    return result
  }

  const downloadDir = path.join(os.tmpdir(), 'osint-downloads')
  await fs.mkdir(downloadDir, { recursive: true })

  const filename = saveAs || parsed.pathname.split('/').pop() || 'download'
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = path.join(downloadDir, `${Date.now()}_${sanitizedFilename}`)

  try {
    // Önce HEAD ile content-type al (bazı siteler HEAD'i reddeder, o zaman GET fallback)
    let headerOut = ''
    try {
      const { stdout } = await execFileAsync('curl', [
        '-sIL',
        '--max-time', '10',
        '--max-filesize', '10485760',
        '-A', USER_AGENT,
        '-o', '/dev/null',
        '-w', '%{http_code}|%{content_type}',
        url,
      ], { timeout: TIMEOUT })
      headerOut = stdout.trim()
    } catch (headErr: unknown) {
      // curl non-zero çıkışı: stdout içinde hâlâ bilgi olabilir
      const execErr = headErr as { stdout?: string; code?: number }
      headerOut = execErr.stdout?.trim() ?? ''
      // Tamamen boşsa (DNS hata, timeout) → bilgi yoktur
      if (!headerOut || headerOut === '|' || headerOut.startsWith('0|')) {
        const curlCode = execErr.code
        const curlMsg: Record<number, string> = {
          6: 'Host çözümlenemedi (DNS hatası)',
          7: 'Bağlantı reddedildi',
          28: 'Bağlantı zaman aşımına uğradı',
          35: 'SSL/TLS hatası',
          52: 'Sunucu boş yanıt döndürdü',
        }
        result.error = `Bağlantı kurulamadı: ${curlMsg[curlCode ?? -1] ?? `curl hata kodu ${curlCode ?? 'bilinmeyen'}`}`
        return result
      }
    }

    const [statusStr, contentType] = headerOut.split('|')
    result.statusCode = parseInt(statusStr, 10)
    result.contentType = contentType || ''

    if (result.statusCode >= 400) {
      result.error = `HTTP ${result.statusCode}`
      return result
    }

    // Dosyayı indir
    try {
      await execFileAsync('curl', [
        '-sL',
        '--max-time', '15',
        '--max-filesize', '10485760',
        '-A', USER_AGENT,
        '-o', filePath,
        url,
      ], { timeout: TIMEOUT + 5000 })
    } catch (dlErr: unknown) {
      const curlCode = (dlErr as { code?: number }).code
      const curlMsg: Record<number, string> = {
        6: 'Host çözümlenemedi (DNS hatası)',
        7: 'Bağlantı reddedildi',
        22: `HTTP ${result.statusCode || 'hata'}`,
        28: 'Bağlantı zaman aşımına uğradı',
        35: 'SSL/TLS hatası',
        47: 'Çok fazla yönlendirme',
        52: 'Sunucu boş yanıt döndürdü',
        56: 'Ağ bağlantısı kesildi',
      }
      result.error = `İndirme başarısız: ${curlMsg[curlCode ?? -1] ?? `curl hata kodu ${curlCode ?? 'bilinmeyen'}`}`
      return result
    }

    result.savedTo = filePath

    // Metin içerik ise oku (max 50KB)
    const isText = contentType.includes('text') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('svg') ||
      contentType.includes('javascript') ||
      contentType.includes('pgp') ||
      contentType.includes('gpg') ||
      contentType.includes('plain')

    if (isText) {
      const stat = await fs.stat(filePath)
      if (stat.size <= 51200) {
        result.textContent = await fs.readFile(filePath, 'utf-8')
      } else {
        const buf = Buffer.alloc(51200)
        const fh = await fs.open(filePath, 'r')
        await fh.read(buf, 0, 51200, 0)
        await fh.close()
        result.textContent = buf.toString('utf-8') + '\n... (truncated)'
      }
    }
  } catch (e) {
    result.error = `Fetch hatası: ${(e as Error).message}`
  }

  return result
}

/**
 * URL'den sadece metin içerik çeker (sayfa HTML/text).
 * Dosya kaydetmeden doğrudan text döner.
 */
export async function webFetchText(url: string): Promise<string> {
  const result = await webFetch(url)
  if (result.error) return `Hata: ${result.error}`
  return result.textContent || `Binary dosya (${result.contentType}), metin içerik yok. Dosya: ${result.savedTo}`
}

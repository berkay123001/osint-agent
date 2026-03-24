/**
 * Wayback Machine Tool — archive.org üzerinden silinmiş/eski sayfa snapshot'larını çeker.
 * OSINT'te silinmiş profiller, eski tweet'ler, değiştirilmiş bio'lar için kullanılır.
 * API key gerektirmez.
 */

const WAYBACK_API = 'https://web.archive.org'
const TIMEOUT = 60000

interface WaybackSnapshot {
  url: string
  timestamp: string
  date: string
  status: string
}

export interface WaybackResult {
  originalUrl: string
  snapshots: WaybackSnapshot[]
  latestContent: string | null
  error?: string
}

async function fetchWithTimeout(url: string, ms = TIMEOUT): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'osint-agent/1.0' },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wayback Machine CDX API ile bir URL'nin tüm arşiv snapshot'larını listeler.
 * CDX API: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
 */
export async function waybackSearch(targetUrl: string, limit = 20): Promise<WaybackResult> {
  const result: WaybackResult = {
    originalUrl: targetUrl,
    snapshots: [],
    latestContent: null,
  }

  try {
    // CDX API ile snapshot listesi al
    const cdxUrl = `${WAYBACK_API}/cdx/search/cdx?url=${encodeURIComponent(targetUrl)}&output=json&limit=${limit}&fl=timestamp,original,statuscode&filter=statuscode:200`

    const res = await fetchWithTimeout(cdxUrl)
    if (!res.ok) {
      result.error = `Wayback CDX API hatası: HTTP ${res.status}`
      return result
    }

    const data = await res.json() as string[][]

    // İlk satır header, atla
    for (let i = 1; i < data.length; i++) {
      const [timestamp, original, status] = data[i]
      const year = timestamp.slice(0, 4)
      const month = timestamp.slice(4, 6)
      const day = timestamp.slice(6, 8)
      const hour = timestamp.slice(8, 10)
      const minute = timestamp.slice(10, 12)

      result.snapshots.push({
        url: `${WAYBACK_API}/web/${timestamp}/${original}`,
        timestamp,
        date: `${year}-${month}-${day} ${hour}:${minute}`,
        status,
      })
    }

    // En son snapshot'ın içeriğini çek
    if (result.snapshots.length > 0) {
      const latest = result.snapshots[result.snapshots.length - 1]
      try {
        // id_ suffix ile raw/original content al (wayback wrapper olmadan)
        const rawUrl = `${WAYBACK_API}/web/${latest.timestamp}id_/${targetUrl}`
        const contentRes = await fetchWithTimeout(rawUrl)
        if (contentRes.ok) {
          const text = await contentRes.text()
          // Max 10KB
          result.latestContent = text.length > 10240
            ? text.slice(0, 10240) + '\n... (truncated)'
            : text
        }
      } catch {
        // Content fetch failed, ok - we still have snapshot list
      }
    }
  } catch (e) {
    result.error = `Wayback hatası: ${(e as Error).message}`
  }

  return result
}

/**
 * Belirli bir tarihteki en yakın snapshot'ı çeker.
 * Wayback Availability API kullanır.
 */
export async function waybackClosest(targetUrl: string, timestamp?: string): Promise<{
  available: boolean
  url: string | null
  date: string | null
  error?: string
}> {
  try {
    let apiUrl = `${WAYBACK_API}/wayback/available?url=${encodeURIComponent(targetUrl)}`
    if (timestamp) apiUrl += `&timestamp=${timestamp}`

    const res = await fetchWithTimeout(apiUrl)
    if (!res.ok) {
      return { available: false, url: null, date: null, error: `HTTP ${res.status}` }
    }

    const data = await res.json() as {
      archived_snapshots?: {
        closest?: { available: boolean; url: string; timestamp: string; status: string }
      }
    }

    const snap = data.archived_snapshots?.closest
    if (snap?.available) {
      const ts = snap.timestamp
      return {
        available: true,
        url: snap.url,
        date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      }
    }

    return { available: false, url: null, date: null }
  } catch (e) {
    return { available: false, url: null, date: null, error: (e as Error).message }
  }
}

/**
 * Wayback sonucunu okunabilir metin formatına çevirir.
 */
export function formatWaybackResult(result: WaybackResult): string {
  if (result.error) return `Wayback Hata: ${result.error}`

  const lines: string[] = [`=== Wayback Machine: ${result.originalUrl} ===`]

  if (result.snapshots.length === 0) {
    lines.push('⚠️  Bu URL için arşivlenmiş snapshot bulunamadı.')
    return lines.join('\n')
  }

  lines.push(`\n📸 ${result.snapshots.length} snapshot bulundu:`)
  for (const snap of result.snapshots) {
    lines.push(`  [${snap.date}] ${snap.url}`)
  }

  if (result.latestContent) {
    lines.push(`\n📄 En son snapshot içeriği (özet):`)
    // İlk 2000 karakter
    const preview = result.latestContent.slice(0, 2000)
    lines.push(preview)
  }

  return lines.join('\n')
}

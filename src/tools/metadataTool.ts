/**
 * Metadata Extraction Tool — exiftool CLI wrapper.
 * Dosya veya URL'den EXIF/XMP/IPTC metadata çıkarır.
 * OSINT'te fotoğraf analizi, dosya kökeni tespiti, username çıkarma için kullanılır.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { webFetch } from './webFetchTool.js'

const execFileAsync = promisify(execFile)

export interface MetadataResult {
  source: string
  fields: Record<string, string>
  rawOutput: string
  interestingFields: Record<string, string>
  error?: string
}

// OSINT açısından önemli metadata alanları
const INTERESTING_KEYS = [
  'Author', 'Creator', 'Artist', 'Copyright',
  'XPAuthor', 'OwnerName', 'CameraOwnerName',
  'GPS', 'GPSLatitude', 'GPSLongitude', 'GPSPosition',
  'Make', 'Model', 'LensModel', 'Software',
  'CreateDate', 'DateTimeOriginal', 'ModifyDate',
  'Comment', 'UserComment', 'ImageDescription', 'Description',
  'Title', 'Subject', 'Keywords',
  'ExportFilename', 'FileName', 'OriginalFilename',
  'ProfileDescription', 'ICCProfileName',
  'Serial', 'SerialNumber', 'InternalSerialNumber',
  'HostComputer', 'OwnerID',
  'Producer', 'PDFAuthor',
  'Email', 'URL', 'WebStatement',
]

/**
 * Dosya yolundan metadata çıkarır (exiftool).
 */
export async function extractMetadataFromFile(filePath: string): Promise<MetadataResult> {
  const result: MetadataResult = {
    source: filePath,
    fields: {},
    rawOutput: '',
    interestingFields: {},
  }

  try {
    const { stdout } = await execFileAsync('exiftool', [
      '-json',
      '-G',           // Show group name
      '-n',           // Numeric values
      '-All',         // All metadata
      filePath,
    ], { timeout: 10000 })

    result.rawOutput = stdout
    const parsed = JSON.parse(stdout)

    if (parsed && parsed[0]) {
      const meta = parsed[0] as Record<string, unknown>

      // Tüm alanları string olarak kaydet
      for (const [key, value] of Object.entries(meta)) {
        if (value !== null && value !== undefined && value !== '') {
          result.fields[key] = String(value)
        }
      }

      // İlginç alanları filtrele
      for (const [key, value] of Object.entries(result.fields)) {
        const cleanKey = key.replace(/^[^:]+:/, '') // Group prefix'i kaldır
        if (INTERESTING_KEYS.some((ik) => cleanKey.toLowerCase().includes(ik.toLowerCase()))) {
          result.interestingFields[key] = value
        }
      }
    }
  } catch (e) {
    result.error = `Metadata çıkarma hatası: ${(e as Error).message}`
  }

  return result
}

/**
 * URL'den dosya indirip metadata çıkarır.
 */
export async function extractMetadataFromUrl(url: string): Promise<MetadataResult> {
  const fetchResult = await webFetch(url)
  if (fetchResult.error || !fetchResult.savedTo) {
    return {
      source: url,
      fields: {},
      rawOutput: '',
      interestingFields: {},
      error: fetchResult.error || 'Dosya indirilemedi',
    }
  }

  const metaResult = await extractMetadataFromFile(fetchResult.savedTo)
  return { ...metaResult, source: url }
}

/**
 * Metadata sonucunu okunabilir metin formatına çevirir.
 */
export function formatMetadata(result: MetadataResult): string {
  if (result.error) return `Hata: ${result.error}`

  const lines: string[] = [`=== Metadata: ${result.source} ===`]

  const interesting = Object.entries(result.interestingFields)
  if (interesting.length > 0) {
    lines.push('\n🔍 OSINT açısından önemli alanlar:')
    for (const [key, value] of interesting) {
      lines.push(`  ${key}: ${value}`)
    }
  }

  lines.push(`\n📋 Tüm metadata (${Object.keys(result.fields).length} alan):`)
  for (const [key, value] of Object.entries(result.fields)) {
    // Skip binary/long fields
    if (String(value).length > 200) continue
    lines.push(`  ${key}: ${value}`)
  }

  return lines.join('\n')
}

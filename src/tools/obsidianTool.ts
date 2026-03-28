/**
 * Obsidian Vault Araçları
 *
 * Agent'ın kendi Obsidian çalışma alanını aktif olarak kullanmasını sağlar:
 * - obsidian_write  : Vault'ta herhangi bir notu yaz / güncelle
 * - obsidian_append : Mevcut nota ek içerik ekle
 * - obsidian_read   : Vault'taki bir notu oku
 * - obsidian_daily  : Günlük defterine kayıt ekle (otomatik tarihleme)
 * - obsidian_list   : Vault içindeki dizin/dosyaları listele
 */

import { mkdir, writeFile, readFile, appendFile, readdir, stat } from 'fs/promises'
import path from 'path'

// ─── Sabitleri ──────────────────────────────────────────────────────────────
export const VAULT_ROOT = path.resolve(
  process.env.HOME ?? '/home/berkayhsrt',
  'Agent_Knowladges/OSINT/OSINT-Agent',
)

const DAILY_DIR = path.join(VAULT_ROOT, '06 - Günlük')
const NOTES_DIR = path.join(VAULT_ROOT, '07 - Notlar')      // agent'ın serbest not alanı
const PROFILES_DIR = path.join(VAULT_ROOT, '08 - Profiller') // araştırılan kişi profilleri

/** Vault dışına çıkmayı engelle (path traversal güvenliği) */
function safePath(relativePath: string): string {
  const resolved = path.resolve(VAULT_ROOT, relativePath)
  if (!resolved.startsWith(VAULT_ROOT)) {
    throw new Error(`Vault dışına erişim engellendi: ${relativePath}`)
  }
  return resolved
}

/** Bugünün tarihini YYYY-MM-DD formatında döndür */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ─── Tool işlevleri ──────────────────────────────────────────────────────────

/**
 * Vault'ta bir not oluştur veya tamamen güncelle.
 * @param notePath  Vault'a göre göreli yol, örn. "07 - Notlar/kullanıcı-tercihleri.md"
 * @param content   Not içeriği (Markdown)
 * @param overwrite true → üzerine yaz, false → sadece yoksa oluştur (varsayılan: true)
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
      return `⏩ Zaten var, üzerine yazılmadı: ${notePath}`
    } catch {
      // Dosya yok → oluştur
    }
  }

  await writeFile(full, content, 'utf8')
  return `✅ Yazıldı: ${notePath}`
}

/**
 * Mevcut bir notun sonuna içerik ekle. Dosya yoksa oluşturur.
 */
export async function obsidianAppend(notePath: string, content: string): Promise<string> {
  const full = safePath(notePath)
  await mkdir(path.dirname(full), { recursive: true })
  await appendFile(full, '\n' + content, 'utf8')
  return `✅ Eklendi: ${notePath}`
}

/**
 * Vault'taki bir notu oku.
 */
export async function obsidianRead(notePath: string): Promise<string> {
  const full = safePath(notePath)
  try {
    const content = await readFile(full, 'utf8')
    return content
  } catch {
    return `❌ Dosya bulunamadı: ${notePath}`
  }
}

/**
 * Bugünün günlük notuna kayıt ekler.
 * Dosya yoksa başlıklı yeni bir günlük sayfası oluşturur.
 * @param entry  Kaydedilecek metin (tek cümle veya Markdown blok)
 * @param tag    Opsiyonel etiket: "araştırma" | "kullanıcı-tercihi" | "gözlem" | "hatırlatma"
 */
export async function obsidianDailyLog(entry: string, tag?: string): Promise<string> {
  const date = today()
  const fileName = `${date}.md`
  const full = path.join(DAILY_DIR, fileName)
  const relPath = path.join('06 - Günlük', fileName)

  await mkdir(DAILY_DIR, { recursive: true })

  // Dosya yoksa başlık oluştur
  let exists = false
  try {
    await stat(full)
    exists = true
  } catch {
    const header = `# ${date} — Günlük\n\n`
    await writeFile(full, header, 'utf8')
  }

  const timestamp = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  const tagStr = tag ? ` #${tag}` : ''
  const line = `\n## ${timestamp}${tagStr}\n${entry}\n`

  await appendFile(full, line, 'utf8')
  return `✅ Günlüğe kaydedildi: ${relPath} (${exists ? 'mevcut dosyaya eklendi' : 'yeni günlük oluşturuldu'})`
}

/**
 * Vault içindeki bir dizini listele (özyinelemeli değil).
 * @param dir Göreli yol veya boş bırakarak vault kökünü listele
 */
export async function obsidianList(dir = ''): Promise<string> {
  const full = dir ? safePath(dir) : VAULT_ROOT
  try {
    const entries = await readdir(full, { withFileTypes: true })
    const lines = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
    return lines.length > 0 ? lines.join('\n') : '(boş dizin)'
  } catch {
    return `❌ Dizin bulunamadı: ${dir || '(vault kökü)'}`
  }
}

// ─── Dizinlerin varlığını garantile ─────────────────────────────────────────
export async function ensureVaultDirs(): Promise<void> {
  await Promise.all([
    mkdir(NOTES_DIR, { recursive: true }),
    mkdir(PROFILES_DIR, { recursive: true }),
    mkdir(DAILY_DIR, { recursive: true }),
  ])
}

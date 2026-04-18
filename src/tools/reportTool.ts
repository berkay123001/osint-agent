import { copyFile, mkdir, writeFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Automatic sync to Obsidian vault
const VAULT_BASE = process.env.OBSIDIAN_VAULT ||
  path.resolve(process.env.HOME ?? os.homedir(), 'Agent_Knowladges/OSINT/OSINT-Agent')
const OBSIDIAN_REPORTS_DIR = path.join(VAULT_BASE, '04 - Research Reports')

/** Sanitize file name: Turkish → ASCII, special characters → space, truncate */
function sanitizeFileName(subject: string, maxLength = 60): string {
  return subject
    .replace(/[Ğğ]/g, 'G').replace(/[Üü]/g, 'U').replace(/[Şş]/g, 'S')
    .replace(/[İı]/g, 'I').replace(/[Öö]/g, 'O').replace(/[Çç]/g, 'C')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim()
}

/** Tarih bazlı alt klasör + temiz dosya adı ile kaydet */
async function saveReport(fileName: string, markdown: string): Promise<string> {
  const now = new Date()
  const dateDir = now.toISOString().slice(0, 10) // "2026-03-28"
  const reportsDir = path.resolve(__dirname, '../../.osint-sessions/reports', dateDir)
  await mkdir(reportsDir, { recursive: true })
  const filePath = path.join(reportsDir, fileName)
  await writeFile(filePath, markdown, 'utf-8')
  return filePath
}

async function syncToObsidian(filePath: string): Promise<void> {
  try {
    // Obsidian'da da aynı tarih klasörü yapısını koru
    const dateDir = path.basename(path.dirname(filePath)) // "2026-03-28"
    const destDir = path.join(OBSIDIAN_REPORTS_DIR, dateDir)
    await mkdir(destDir, { recursive: true })
    const dest = path.join(destDir, path.basename(filePath))
    await copyFile(filePath, dest)
  } catch {
    // Silently skip if Obsidian vault is not present
  }
}

export interface ReportSection {
  title: string
  items: string[]
}

export interface OsintReportInput {
  subject: string
  title?: string
  reportType?: 'osint' | 'academic' | 'factcheck'
  // Graf verisinden doldurulur — dışarıdan da ek bilgi geçilebilir
  additionalFindings?: string
}

export interface OsintReportResult {
  filePath: string
  markdown: string
  summary: string
  error?: string
}

// ─── Neo4j Bağımsız Rapor Verisi ─────────────────────────────────────────────
interface GraphData {
  connections: Array<{ from: string; relation: string; to: string; toLabel: string; confidence?: string; source?: string }>
  identifiers: { emails: string[]; realNames: string[]; handles: string[]; websites: string[] }
  stats: { nodes: number; relationships: number }
  nodesByLabel: Array<{ label: string; count: number }>
}

async function fetchGraphData(subject: string): Promise<GraphData | null> {
  try {
    const { getConnections, findLinkedIdentifiers, getGraphStats, getGraphNodeCountsByLabel } = await import('../lib/neo4j.js')
    const [connections, identifiers, stats, nodesByLabel] = await Promise.all([
      getConnections(subject),
      findLinkedIdentifiers(subject),
      getGraphStats(),
      getGraphNodeCountsByLabel(),
    ])
    return { connections, identifiers, stats, nodesByLabel }
  } catch {
    return null
  }
}

// ─── Markdown Rapor Oluşturucu ────────────────────────────────────────────────
function buildAcademicMarkdownReport(subject: string, title: string, findings?: string): string {
  const now = new Date()
  const dateStr = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
  const lines: string[] = []

  lines.push(`# ${title}`)
  lines.push(``)
  lines.push(`> **Konu:** ${subject}  `)
  lines.push(`> **Tarih:** ${dateStr}  `)
  lines.push(`> **Oluşturan:** OSINT Multi-Agent / AcademicAgent  `)
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  if (findings) {
    // AcademicAgent'ın raporu zaten yapılandırılmış Markdown — doğrudan ekle
    lines.push(findings)
  } else {
    lines.push(`*Araştırma verisi bulunamadı. Lütfen önce ask_academic_agent ile araştırma yürütün.*`)
  }

  lines.push(``)
  lines.push(`---`)
  lines.push(`*Bu rapor OSINT Multi-Agent Sistemi tarafından otomatik oluşturulmuştur.*`)

  return lines.join('\n')
}

function buildFactcheckMarkdownReport(subject: string, title: string, findings?: string): string {
  const now = new Date()
  const dateStr = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
  const lines: string[] = []

  lines.push(`# ${title}`)
  lines.push(``)
  lines.push(`> **İddia:** ${subject}  `)
  lines.push(`> **Tarih:** ${dateStr}  `)
  lines.push(`> **Oluşturan:** OSINT Multi-Agent / MediaAgent  `)
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  if (findings) {
    lines.push(findings)
  } else {
    lines.push(`*Doğrulama verisi bulunamadı.*`)
  }

  lines.push(``)
  lines.push(`---`)
  lines.push(`*Bu rapor OSINT Multi-Agent Sistemi tarafından otomatik oluşturulmuştur.*  `)
  lines.push(`*Doğrulanmamış bilgiler hukuki amaçlarla kullanılmamalıdır.*`)

  return lines.join('\n')
}

// ─── OSINT Kişi Araştırması Rapor Oluşturucu ─────────────────────────────────
function buildMarkdownReport(subject: string, title: string, data: GraphData | null, additionalFindings?: string): string {
  const now = new Date()
  const dateStr = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
  const lines: string[] = []

  // Başlık
  lines.push(`# ${title}`)
  lines.push(``)
  lines.push(`> **Hedef:** \`${subject}\`  `)
  lines.push(`> **Tarih:** ${dateStr}  `)
  lines.push(`> **Oluşturan:** OSINT Multi-Agent Sistemi  `)
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  if (!data) {
    lines.push(`## ⚠️ Graf Verisi Yok`)
    lines.push(``)
    lines.push(`Neo4j bağlantısı kurulamadı. Lütfen araştırma yürütün ve tekrar deneyin.`)
    lines.push(``)
    if (additionalFindings) {
      lines.push(`## 📝 Ek Bulgular`)
      lines.push(``)
      lines.push(additionalFindings)
    }
    return lines.join('\n')
  }

  // ─── 1. Yönetici Özeti ──────────────────────────────────────────────────────
  lines.push(`## 📋 Yönetici Özeti`)
  lines.push(``)

  const totalIdentifiers = data.identifiers.emails.length + data.identifiers.realNames.length +
    data.identifiers.handles.length + data.identifiers.websites.length

  const breachConns = data.connections.filter(c => c.relation === 'LEAKED_IN')
  const profileConns = data.connections.filter(c => c.relation === 'HAS_PROFILE')
  const platformConns = data.connections.filter(c => c.relation === 'REGISTERED_ON')

  lines.push(`| Alan | Değer |`)
  lines.push(`|------|-------|`)
  lines.push(`| Toplam Graf Bağlantısı | ${data.stats.relationships} |`)
  lines.push(`| Toplam Node | ${data.stats.nodes} |`)
  lines.push(`| Doğrulanmış Tanımlayıcı | ${totalIdentifiers} |`)
  lines.push(`| Bulunan Profil | ${profileConns.length} |`)
  lines.push(`| Platform Kaydı | ${platformConns.length} |`)
  lines.push(`| Veri Sızıntısı | ${breachConns.length} |`)
  lines.push(``)

  // Risk seviyesi
  let riskLevel = '🟢 Düşük'
  if (breachConns.length > 3 || profileConns.length > 20) riskLevel = '🔴 Yüksek'
  else if (breachConns.length > 0 || profileConns.length > 5) riskLevel = '🟡 Orta'
  lines.push(`**Dijital Ayak İzi Risk Seviyesi:** ${riskLevel}`)
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  // ─── 2. Kimlik Bilgileri ────────────────────────────────────────────────────
  lines.push(`## 🪪 Kimlik Bilgileri`)
  lines.push(``)

  if (data.identifiers.realNames.length > 0) {
    lines.push(`### Gerçek İsim`)
    for (const name of data.identifiers.realNames) {
      lines.push(`- \`${name}\``)
    }
    lines.push(``)
  }

  if (data.identifiers.emails.length > 0) {
    lines.push(`### E-posta Adresleri`)
    for (const email of data.identifiers.emails) {
      lines.push(`- \`${email}\``)
    }
    lines.push(``)
  }

  if (data.identifiers.handles.length > 0) {
    lines.push(`### Bağlı Kullanıcı Adları / Handle'lar`)
    for (const handle of data.identifiers.handles) {
      lines.push(`- \`${handle}\``)
    }
    lines.push(``)
  }

  if (data.identifiers.websites.length > 0) {
    lines.push(`### Web Siteleri / Blog`)
    for (const site of data.identifiers.websites) {
      lines.push(`- ${site}`)
    }
    lines.push(``)
  }

  if (totalIdentifiers === 0) {
    lines.push(`*Henüz doğrulanmış kimlik bilgisi bulunamadı.*`)
    lines.push(``)
  }

  lines.push(`---`)
  lines.push(``)

  // ─── 3. Sosyal Medya & Profiller ───────────────────────────────────────────
  if (profileConns.length > 0) {
    lines.push(`## 🌐 Bulunan Sosyal Medya Profilleri`)
    lines.push(``)
    for (const c of profileConns) {
      const confidenceBadge = c.confidence === 'high' ? ' ✅ **Doğrulandı**' : c.confidence ? ` (${c.confidence})` : ''
      lines.push(`- ${c.to}${confidenceBadge}`)
    }
    lines.push(``)
    lines.push(`---`)
    lines.push(``)
  }

  // ─── 4. Platform Kayıtları (Holehe) ────────────────────────────────────────
  if (platformConns.length > 0) {
    lines.push(`## 📱 Platform Kayıtları (Email ile)`)
    lines.push(``)

    // Email grupla
    const byEmail = new Map<string, string[]>()
    for (const c of platformConns) {
      const emailNode = c.from
      if (!byEmail.has(emailNode)) byEmail.set(emailNode, [])
      byEmail.get(emailNode)!.push(c.to)
    }

    for (const [email, platforms] of byEmail) {
      lines.push(`**\`${email}\`** üzerinde kayıtlı platformlar:`)
      for (const p of platforms) {
        lines.push(`  - ${p}`)
      }
      lines.push(``)
    }

    lines.push(`---`)
    lines.push(``)
  }

  // ─── 5. Veri Sızıntıları ───────────────────────────────────────────────────
  if (breachConns.length > 0) {
    lines.push(`## 🔓 Veri Sızıntıları`)
    lines.push(``)
    lines.push(`> ⚠️ Aşağıdaki sızıntılarda bilgiler ele geçirilmiş olabilir.`)
    lines.push(``)
    for (const c of breachConns) {
      lines.push(`- **${c.from}** → sızıntı: \`${c.to}\``)
    }
    lines.push(``)
    lines.push(`---`)
    lines.push(``)
  }

  // ─── 6. Tüm Graf Bağlantıları ──────────────────────────────────────────────
  const otherConns = data.connections.filter(
    c => !['HAS_PROFILE', 'REGISTERED_ON', 'LEAKED_IN'].includes(c.relation)
  )

  if (otherConns.length > 0) {
    lines.push(`## 🕸️ Diğer Graf Bağlantıları`)
    lines.push(``)
    lines.push(`| İlişki | Hedef | Tip | Kaynak |`)
    lines.push(`|--------|-------|-----|--------|`)
    for (const c of otherConns.slice(0, 50)) {
      const source = c.source ? c.source : '-'
      lines.push(`| \`${c.relation}\` | ${c.to} | ${c.toLabel} | ${source} |`)
    }
    if (otherConns.length > 50) {
      lines.push(``)
      lines.push(`*... ve ${otherConns.length - 50} bağlantı daha (graf'ta mevcut)*`)
    }
    lines.push(``)
    lines.push(`---`)
    lines.push(``)
  }

  // ─── 7. Ek Bulgular ────────────────────────────────────────────────────────
  if (additionalFindings) {
    lines.push(`## 📝 Ek Bulgular ve Analist Notları`)
    lines.push(``)
    lines.push(additionalFindings)
    lines.push(``)
    lines.push(`---`)
    lines.push(``)
  }

  // ─── 8. İstatistikler ──────────────────────────────────────────────────────
  lines.push(`## 📊 Graf İstatistikleri`)
  lines.push(``)
  lines.push(`| Etiket | Adet |`)
  lines.push(`|--------|------|`)
  for (const item of data.nodesByLabel) {
    lines.push(`| ${item.label} | ${item.count} |`)
  }
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  // ─── Footer ────────────────────────────────────────────────────────────────
  lines.push(`*Bu rapor otomatik olarak OSINT araştırma ajanı tarafından oluşturulmuştur.*  `)
  lines.push(`*Doğrulanmamış bilgiler hukuki amaçlarla kullanılmamalıdır.*`)
  lines.push(``)

  return lines.join('\n')
}

// ─── Ana Export Fonksiyon ─────────────────────────────────────────────────────
export async function generateOsintReport(input: OsintReportInput): Promise<OsintReportResult> {
  const { subject, title, additionalFindings, reportType = 'osint' } = input

  // Akademik ve Fact-check raporları grafı kullanmaz — tamamen findings bazlı
  if (reportType === 'academic') {
    const reportTitle = title ?? `Akademik Araştırma Raporu: ${subject}`
    const markdown = buildAcademicMarkdownReport(subject, reportTitle, additionalFindings)
    const fileName = `${sanitizeFileName(subject)}.md`
    const filePath = await saveReport(fileName, markdown)
    await syncToObsidian(filePath)
    return { filePath, markdown, summary: `Akademik rapor oluşturuldu → ${filePath}` }
  }

  if (reportType === 'factcheck') {
    const reportTitle = title ?? `Doğrulama Raporu: ${subject}`
    const markdown = buildFactcheckMarkdownReport(subject, reportTitle, additionalFindings)
    const fileName = `${sanitizeFileName(subject)}.md`
    const filePath = await saveReport(fileName, markdown)
    await syncToObsidian(filePath)
    return { filePath, markdown, summary: `Fact-check raporu oluşturuldu → ${filePath}` }
  }

  // OSINT kişi araştırması (varsayılan)
  const reportTitle = title ?? `OSINT Raporu: ${subject}`

  // Graf verisini çek
  const graphData = await fetchGraphData(subject)

  // Markdown oluştur
  const markdown = buildMarkdownReport(subject, reportTitle, graphData, additionalFindings)

  // Kayıt
  const fileName = `${sanitizeFileName(subject)}.md`
  const filePath = await saveReport(fileName, markdown)
  await syncToObsidian(filePath)

  // Özet
  const profileCount = graphData?.connections.filter(c => c.relation === 'HAS_PROFILE').length ?? 0
  const breachCount = graphData?.connections.filter(c => c.relation === 'LEAKED_IN').length ?? 0
  const emailCount = graphData?.identifiers.emails.length ?? 0

  const summary = graphData
    ? `Rapor oluşturuldu → ${filePath} | ${emailCount} email, ${profileCount} profil, ${breachCount} sızıntı`
    : `Rapor oluşturuldu → ${filePath} | (Neo4j çevrimdışı — ek bulgular varsa dahil edildi)`

  return { filePath, markdown, summary }
}

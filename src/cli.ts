#!/usr/bin/env node
/**
 * cli.ts — `osint` global komutu için giriş noktası
 *
 * npm install -g osint-agent → `osint` komutu kullanılabilir olur.
 *
 * Kullanım:
 *   osint                   İnteraktif REPL başlat
 *   osint "soru"            Tek soru gönder
 *   osint --setup           Docker + .env kurulum sihirbazı
 *   osint --graph           Neo4j graf görselleştirme sunucusu (port 3333)
 *   osint --version         Versiyon göster
 *   osint --help            Yardım
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import chalk from 'chalk'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const pkgPath = join(__dirname, '..', 'package.json')
let version = '1.0.0'
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  version = pkg.version ?? '1.0.0'
} catch { /* fallback */ }

const args = process.argv.slice(2)

// ── Flag işleme ──────────────────────────────────────────────────────────

if (args.includes('--version') || args.includes('-v')) {
  console.log(`osint-agent v${version}`)
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
${chalk.bold.cyan('osint-agent')} v${version} — Cok ajanli acik kaynak istihbarat sistemi

${chalk.bold('Kullanim:')}
  ${chalk.green('osint')}                   Interaktif REPL baslat
  ${chalk.green('osint')} "soru"            Tek soru gonder, sonucu yazdir
  ${chalk.green('osint')} --setup           Kurulum sihirbazi (Docker + .env + Neo4j + Python)
  ${chalk.green('osint')} --graph           Neo4j graf gorsellestirme sunucusu (port 3333)
  ${chalk.green('osint')} --version         Versiyon goster
  ${chalk.green('osint')} --help            Bu yardim

${chalk.bold('REPL Komutlari:')}
  /reset     Oturumu sifirla ve arsivle
  /history   Oturum gecmisi
  /resume    Kayitli oturumlari listele ve sec
  exit       Oturumu arsivleyip cik

${chalk.bold('Ajanlar:')}
  Supervisor    Koordinator + graf + rapor
  Identity      Kisi/username/email arastirmasi
  Media         Gorsel/haber dogrulama
  Academic      Akademik makale taramasi

${chalk.bold('Gereksinimler:')}
  Node.js 18+, OpenRouter API key
  Istege bagli: Docker (SearXNG + Firecrawl), Neo4j, Python 3.10+
`)
  process.exit(0)
}

// ── Docker + .env setup ──────────────────────────────────────────────────

if (args.includes('--setup')) {
  const { runSetup } = await import('./tools/setupCommand.js')
  await runSetup()
  process.exit(0)
}

// ── Graf gorsellestirme sunucusu ─────────────────────────────────────────

if (args.includes('--graph')) {
  await import('./graphServer.js')
  process.exit(0)
}

// ── Tek soru modu ────────────────────────────────────────────────────────

if (args.length > 0 && !args[0].startsWith('-')) {
  const message = args.join(' ')
  const { runSupervisor } = await import('./agents/supervisorAgent.js')
  const { closeNeo4j } = await import('./lib/neo4j.js')
  const history: Array<{ role: string; content: string }> = [
    { role: 'user', content: message },
  ]

  try {
    await runSupervisor(history as any)
  } catch (e) {
    console.error(chalk.red(`Hata: ${(e as Error).message}`))
  } finally {
    await closeNeo4j()
    process.exit(0)
  }
}

// ── Interaktif REPL ─────────────────────────────────────────────────────

await import('./chat.js')

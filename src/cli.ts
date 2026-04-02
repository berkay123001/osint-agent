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
  ${chalk.green('osint')} --setup           Docker servislerini baslat + .env olustur
  ${chalk.green('osint')} --graph           Neo4j graf gorsellestirme sunucusu (port 3333)
  ${chalk.green('osint')} --version         Versiyon goster
  ${chalk.green('osint')} --help            Bu yardim

${chalk.bold('REPL Komutlari:')}
  !reset     Oturumu sifirla
  !history   Oturum gecmisi
  exit       Cikis

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
  const { execSync } = await import('child_process')

  console.log(chalk.bold.cyan('\nOSINT Agent Kurulum Sihirbazi\n'))

  // 1. Docker
  console.log(chalk.dim('1. Docker kontrol ediliyor...'))
  try {
    const dockerVer = execSync('docker --version', { encoding: 'utf-8' }).trim()
    console.log(chalk.green(`   ${dockerVer}`))
  } catch {
    console.log(chalk.red('   Docker bulunamadi. https://docs.docker.com/get-docker/'))
    console.log(chalk.dim('      Docker olmadan da kullanabilirsiniz — SearXNG ve Firecrawl devre disi kalir.'))
  }

  // 2. Docker Compose servisleri
  console.log(chalk.dim('\n2. Docker servisleri baslatiliyor...'))
  try {
    execSync('docker compose up -d', { encoding: 'utf-8', stdio: 'inherit' })
    console.log(chalk.green('   SearXNG + Firecrawl baslatildi'))
  } catch {
    console.log(chalk.yellow('   Docker compose basarisiz — servisler zaten calisiyor olabilir.'))
  }

  // 3. .env
  console.log(chalk.dim('\n3. .env dosyasi kontrol ediliyor...'))
  const envPath = join(process.cwd(), '.env')
  try {
    readFileSync(envPath, 'utf-8')
    console.log(chalk.green('   .env dosyasi mevcut'))
  } catch {
    const examplePath = join(process.cwd(), '.env.example')
    try {
      const example = readFileSync(examplePath, 'utf-8')
      const { writeFileSync } = await import('fs')
      writeFileSync(envPath, example, 'utf-8')
      console.log(chalk.yellow('   .env olusturuldu (.env.example\'den kopyalandi)'))
      console.log(chalk.bold.red('   Lutfen .env dosyasini API key\'lerinizle doldurun!'))
    } catch {
      console.log(chalk.red('   .env.example bulunamadi'))
    }
  }

  // 4. Neo4j
  console.log(chalk.dim('\n4. Neo4j kontrol ediliyor...'))
  try {
    const neo4jUri = process.env.NEO4J_URI || 'bolt://localhost:7687'
    const { default: neo4j } = await import('neo4j-driver')
    const driver = neo4j.driver(neo4jUri)
    const session = driver.session()
    await session.run('RETURN 1')
    await session.close()
    await driver.close()
    console.log(chalk.green(`   Neo4j baglantisi basarili (${neo4jUri})`))
  } catch {
    console.log(chalk.yellow('   Neo4j baglanamadi — graf ozellikleri devre disi'))
    console.log(chalk.dim('      Kurulum: docker run -p 7474:7474 -p 7687:7687 neo4j:latest'))
  }

  console.log(chalk.bold.cyan('\nKurulum tamamlandi! `osint` ile baslayabilirsiniz.\n'))
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

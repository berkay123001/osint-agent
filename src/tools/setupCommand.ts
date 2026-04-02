#!/usr/bin/env node
/**
 * setupCommand.ts — `osint --setup` kurulum sihirbazi
 *
 * Kontroller:
 *   1. Docker (versiyon)
 *   2. Docker Compose servisleri (SearXNG + Firecrawl)
 *   3. Neo4j (baglanti testi veya Docker ile baslatma)
 *   4. Python + sherlock + holehe + scrapling
 *   5. .env dosyasi olusturma (interaktif)
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'
import chalk from 'chalk'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..', '..')

// ── Yardimci fonksiyonlar ────────────────────────────────────────────────────

function run(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim()
  } catch {
    return null
  }
}

function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(query, ans => {
      rl.close()
      resolve(ans.trim())
    })
  })
}

function checkUrl(url: string): boolean {
  return run(`curl -sf -o /dev/null -m 3 ${url}`) !== null
}

function step(n: number, label: string) {
  console.log(chalk.dim(`\n${n}. ${label}`))
}

function ok(msg: string) {
  console.log(chalk.green(`   ✅ ${msg}`))
}

function warn(msg: string) {
  console.log(chalk.yellow(`   ⚠️  ${msg}`))
}

function fail(msg: string) {
  console.log(chalk.red(`   ❌ ${msg}`))
}

// ── Kontroller ───────────────────────────────────────────────────────────────

async function checkDocker(): Promise<boolean> {
  step(1, 'Docker kontrol ediliyor...')
  const ver = run('docker --version')
  if (ver) {
    ok(ver)
    return true
  }
  fail('Docker bulunamadi')
  console.log(chalk.dim('      Kurulum: https://docs.docker.com/get-docker/'))
  console.log(chalk.dim('      Docker olmadan SearXNG ve Firecrawl devre disi kalir.'))
  return false
}

async function checkDockerServices(): Promise<void> {
  step(2, 'Docker servisleri kontrol ediliyor...')

  // SearXNG
  if (checkUrl('http://localhost:8888')) {
    ok('SearXNG calisiyor (localhost:8888)')
  } else {
    console.log(chalk.dim('   SearXNG baslatiliyor...'))
    const composeResult = run('docker compose up -d searxng')
    if (composeResult !== null) {
      // servisin ayaga kalkmasini bekle
      let tries = 0
      while (tries < 10) {
        if (checkUrl('http://localhost:8888')) break
        await new Promise(r => setTimeout(r, 1500))
        tries++
      }
      if (checkUrl('http://localhost:8888')) {
        ok('SearXNG baslatildi (localhost:8888)')
      } else {
        warn('SearXNG baslatilamadi — elle calistirin: docker compose up -d searxng')
      }
    } else {
      warn('docker compose bulunamadi — SearXNG\'yi elle baslatin')
    }
  }

  // Firecrawl
  if (checkUrl('http://localhost:3002')) {
    ok('Firecrawl calisiyor (localhost:3002)')
  } else {
    warn('Firecrawl calismiyor — scrape araci olarak Puppeteer/Scrapling kullanilacak')
    console.log(chalk.dim('      Baslatmak icin: docker compose up -d firecrawl'))
  }
}

async function checkNeo4j(): Promise<void> {
  step(3, 'Neo4j kontrol ediliyor...')

  const uri = process.env.NEO4J_URI || 'bolt://localhost:7687'
  const user = process.env.NEO4J_USER || 'neo4j'
  const password = process.env.NEO4J_PASSWORD

  // Baglanti testi
  try {
    const neo4j = await import('neo4j-driver')
    const driver = neo4j.default.driver(uri, neo4j.default.auth.basic(user, password || 'neo4j'))
    const session = driver.session()
    await session.run('RETURN 1')
    await session.close()
    await driver.close()
    ok(`Neo4j baglantisi basarili (${uri})`)
    return
  } catch {
    // baglanti basarisiz
  }

  warn('Neo4j baglanilamadi')

  if (password) {
    fail('Kimlik bilgileri hatali — .env dosyasindaki NEO4J_USER ve NEO4J_PASSWORD kontrol edin')
    return
  }

  // Docker ile baslatma onerisi
  const ans = await question(chalk.bold.yellow('   Neo4j Docker ile baslatilsin mi? [Y/n] '))
  if (ans.toLowerCase() === 'n') {
    console.log(chalk.dim('      Manuel kurulum: docker run -d -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/test1234 neo4j:latest'))
    return
  }

  const neo4jPassword = await question(chalk.bold.yellow('   Neo4j sifre belirleyin [test1234]: ')) || 'test1234'

  console.log(chalk.dim('   Neo4j baslatiliyor...'))
  const result = run(
    `docker run -d --name osint-neo4j -p 7474:7474 -p 7687:7687 ` +
    `-e NEO4J_AUTH=neo4j/${neo4jPassword} ` +
    `neo4j:latest`
  )

  if (result) {
    ok('Neo4j baslatildi (bolt://localhost:7687)')
    console.log(chalk.dim(`      Web arayuz: http://localhost:7474`))
    console.log(chalk.dim(`      Kullanici: neo4j / ${neo4jPassword}`))
    // .env'e yazilacak bilgiyi dondur
    neo4jSetupPassword = neo4jPassword
  } else {
    fail('Neo4j baslatilamadi — elle kurun')
  }
}

let neo4jSetupPassword: string | null = null

async function checkPython(): Promise<void> {
  step(4, 'Python kontrol ediliyor...')

  const pythonPath = process.env.PYTHON_PATH || 'python3'
  const ver = run(`${pythonPath} --version`)
  if (!ver) {
    warn('Python bulunamadi — Sherlock, Holehe, Scrapling devre disi')
    console.log(chalk.dim('      PYTHON_PATH env degiskeni ile yol belirtebilirsiniz'))
    return
  }
  ok(ver)

  // Sherlock
  const sherlock = run(`${pythonPath} -c "import sherlock_project"`)
  if (sherlock !== null || run(`${pythonPath} -m sherlock --help`) !== null) {
    ok('sherlock-project kurulu')
  } else {
    console.log(chalk.dim('   sherlock-project kuruluyor...'))
    const pipResult = run(`${pythonPath} -m pip install sherlock-project -q`)
    if (pipResult !== null) {
      ok('sherlock-project kuruldu')
    } else {
      warn('sherlock-project kurulamadi — elle: pip install sherlock-project')
    }
  }

  // Holehe
  const holehe = run(`${pythonPath} -c "import holehe"`)
  if (holehe !== null || run(`${pythonPath} -m holehe --help`) !== null) {
    ok('holehe kurulu')
  } else {
    console.log(chalk.dim('   holehe kuruluyor...'))
    const pipResult = run(`${pythonPath} -m pip install holehe -q`)
    if (pipResult !== null) {
      ok('holehe kuruldu')
    } else {
      warn('holehe kurulamadi — elle: pip install holehe')
    }
  }

  // Scrapling
  const scrapling = run(`${pythonPath} -c "import scrapling"`)
  if (scrapling !== null) {
    ok('scrapling kurulu')
  } else {
    console.log(chalk.dim('   scrapling kuruluyor...'))
    const pipResult = run(`${pythonPath} -m pip install scrapling -q`)
    if (pipResult !== null) {
      ok('scrapling kuruldu')
    } else {
      warn('scrapling kurulamadi — elle: pip install scrapling')
    }
  }
}

async function setupEnv(): Promise<void> {
  step(5, '.env dosyasi olusturuluyor...')

  const envPath = join(PROJECT_ROOT, '.env')

  if (existsSync(envPath)) {
    ok('.env dosyasi zaten mevcut — degerler korunacak')
    // Neo4j sifresini güncelle (eger yeni kurulduysa)
    if (neo4jSetupPassword) {
      let content = readFileSync(envPath, 'utf-8')
      content = content.replace(
        /NEO4J_PASSWORD=.*/,
        `NEO4J_PASSWORD=${neo4jSetupPassword}`
      )
      writeFileSync(envPath, content, 'utf-8')
      ok(`NEO4J_PASSWORD .env'e yazildi`)
    }
    return
  }

  // .env.example'den kopyala veya interaktif olustur
  const examplePath = join(PROJECT_ROOT, '.env.example')
  if (existsSync(examplePath)) {
    let content = readFileSync(examplePath, 'utf-8')

    // Neo4j sifresini güncelle
    if (neo4jSetupPassword) {
      content = content.replace(/NEO4J_PASSWORD=.*/, `NEO4J_PASSWORD=${neo4jSetupPassword}`)
    }

    writeFileSync(envPath, content, 'utf-8')
    ok('.env olusturuldu (.env.example\'den kopyalandi)')
    console.log(chalk.bold.red('\n   ⚠️  .env dosyasini API key\'lerinizle doldurun!'))
    console.log(chalk.dim('      Zorunlu: OPENROUTER_API_KEY'))
    console.log(chalk.dim('      Opsiyonel: BRAVE_SEARCH_API_KEY, GITHUB_TOKEN, vb.'))
    return
  }

  // .env.example yoksa minimal olustur
  const apiKey = await question(chalk.bold.yellow('   OPENROUTER_API_KEY: '))
  if (!apiKey) {
    warn('API key girilmedi — .env olusturulmadi')
    return
  }

  const minimalEnv = [
    `# OSINT Agent - otomatik olusturuldu`,
    `OPENROUTER_API_KEY=${apiKey}`,
    `SEARXNG_URL=http://localhost:8888`,
    `FIRECRAWL_URL=http://localhost:3002/v1/scrape`,
    `NEO4J_URI=bolt://localhost:7687`,
    `NEO4J_USER=neo4j`,
    `NEO4J_PASSWORD=${neo4jSetupPassword || ''}`,
    `PYTHON_PATH=python3`,
  ].join('\n')

  writeFileSync(envPath, minimalEnv, 'utf-8')
  ok('.env olusturuldu')
}

// ── Ozet ─────────────────────────────────────────────────────────────────────

function printSummary() {
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════════════╗'))
  console.log(chalk.bold.cyan('║          KURULUM OZETI                       ║'))
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════╝'))

  const checks: [string, boolean, string][] = [
    ['Docker', run('docker --version') !== null, 'docker --version'],
    ['SearXNG', checkUrl('http://localhost:8888'), 'docker compose up -d searxng'],
    ['Firecrawl', checkUrl('http://localhost:3002'), 'docker compose up -d firecrawl'],
    ['.env', existsSync(join(PROJECT_ROOT, '.env')), '.env dosyasi olusturun'],
  ]

  for (const [name, ok_, fix] of checks) {
    const icon = ok_ ? chalk.green('✅') : chalk.red('❌')
    const note = ok_ ? '' : chalk.dim(` → ${fix}`)
    console.log(`   ${icon} ${name}${note}`)
  }

  console.log()
  console.log(chalk.bold('Sonraki adimlar:'))
  console.log(chalk.dim('   1. .env dosyasini kontrol edin: cat .env'))
  console.log(chalk.dim('   2. Baslatin: osint'))
  console.log()
}

// ── Ana akis ─────────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  console.log(chalk.bold.cyan('\n  🔍 OSINT Agent Kurulum Sihirbazi\n'))
  console.log(chalk.dim('  ─────────────────────────────────────────────────────────'))

  await checkDocker()
  await checkDockerServices()
  await checkNeo4j()
  await checkPython()
  await setupEnv()

  console.log(chalk.dim('\n  ─────────────────────────────────────────────────────────'))
  printSummary()
}

// ── Kaldirma sihirbazi ──────────────────────────────────────────────────────

export async function runUninstall(): Promise<void> {
  console.log(chalk.bold.red('\n  🗑️  OSINT Agent Kaldirma Sihirbazi\n'))
  console.log(chalk.dim('  ─────────────────────────────────────────────────────────'))

  const { rmSync, readdirSync } = await import('fs')

  // 1. Docker container'lar
  step(1, 'Docker servisleri durduruluyor...')
  const containers = ['osint-searxng', 'osint-neo4j']
  for (const name of containers) {
    const exists = run(`docker ps -aq -f name=${name}`)
    if (exists) {
      console.log(chalk.dim(`   ${name} durduruluyor...`))
      const stopped = run(`docker stop ${name}`)
      const removed = run(`docker rm ${name}`)
      if (stopped !== null && removed !== null) {
        ok(`${name} durduruldu ve kaldirildi`)
      } else {
        warn(`${name} durdurulamadi — elle: docker stop ${name} && docker rm ${name}`)
      }
    } else {
      console.log(chalk.dim(`   ${name} — bulunamadi (zaten kaldirilmis)`))
    }
  }

  // Docker Compose servisleri (firecrawl vs.)
  const composeFile = join(PROJECT_ROOT, 'docker-compose.yml')
  if (existsSync(composeFile)) {
    console.log(chalk.dim('   docker compose servisleri kapatiliyor...'))
    run('docker compose down')
    ok('docker compose servisleri kapatildi')
  }

  // 2. Oturum dosyalari
  step(2, 'Oturum dosyalari temizleniyor...')
  const sessionDir = join(PROJECT_ROOT, '.osint-sessions')
  if (existsSync(sessionDir)) {
    try {
      rmSync(sessionDir, { recursive: true, force: true })
      ok('.osint-sessions/ silindi')
    } catch {
      warn('.osint-sessions/ silinemedi — elle silin')
    }
  } else {
    console.log(chalk.dim('   .osint-sessions/ bulunamadi'))
  }

  // .pids
  const pidsFile = join(PROJECT_ROOT, '.pids')
  if (existsSync(pidsFile)) {
    try { rmSync(pidsFile, { force: true }) } catch { /* no-op */ }
    ok('.pids silindi')
  }

  // 3. .env dosyasi
  step(3, '.env dosyasi...')
  const envPath = join(PROJECT_ROOT, '.env')
  if (existsSync(envPath)) {
    const ans = await question(chalk.bold.yellow('   .env dosyasi silinsin mi? (API keyler icor!) [y/N] '))
    if (ans.toLowerCase() === 'y') {
      try {
        rmSync(envPath, { force: true })
        ok('.env silindi')
      } catch {
        warn('.env silinemedi')
      }
    } else {
      console.log(chalk.dim('   .env korundu'))
    }
  } else {
    console.log(chalk.dim('   .env bulunamadi'))
  }

  // 4. Ozet
  console.log(chalk.dim('\n  ─────────────────────────────────────────────────────────'))
  console.log(chalk.bold.cyan('\n  🧹 Kaldirma tamamlandi!\n'))
  console.log(chalk.bold('   Kalan adimlar:'))
  console.log(chalk.dim('   npm uninstall -g osint-agent    ← paketi kaldirir'))
  console.log(chalk.dim('   docker system prune              ← kullanilmayan Docker imajlarini temizler'))
  console.log(chalk.dim('   pip uninstall sherlock-project holehe scrapling  ← Python paketleri'))
  console.log()
}

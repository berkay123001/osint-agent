import 'dotenv/config'
import OpenAI from 'openai'
import * as readline from 'readline'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import chalk from 'chalk'
import { githubOsint } from './tools/githubTool.js'
import { writeOsintToGraph, getConnections, getGraphStats, getGraphNodeCountsByLabel, listGraphNodes, pruneMisclassifiedFullNameUsernames, findLinkedIdentifiers, writeEmailRegistrations, writeBreachData, closeNeo4j, clearGraph } from './lib/neo4j.js'
import { normalizeAssistantMessage, normalizeToolContent, sanitizeHistoryForProvider } from './lib/chatHistory.js'
import { isLikelyUsernameCandidate } from './lib/osintHeuristics.js'
import { extractMetadataFromUrl, extractMetadataFromFile, formatMetadata } from './tools/metadataTool.js'
import { parseGithubGpgKey, formatGpgResult } from './tools/gpgParserTool.js'
import { waybackSearch, formatWaybackResult } from './tools/waybackTool.js'
import { webFetch } from './tools/webFetchTool.js'
import { checkEmailRegistrations, formatHoleheResult } from './tools/holeheTool.js'
import { checkBreaches, formatBreachResult } from './tools/breachCheckTool.js'
import { searchWeb, formatSearchResult } from './tools/searchTool.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'
const MODEL = 'qwen/qwen3.5-flash-02-23'

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

// ─── Tool Definitions ────────────────────────────────────────────────
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'clear_graph',
      description:
        'Neo4j graf veritabanındaki tüm düğümleri (node) ve ilişkileri kalıcı olarak siler. Sadece kullanıcı açıkça veritabanını temizlemeni/silmeni istediğinde kullan.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Silme işlemini onaylamak için true gönder' },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Tavily AI arama motoru üzerinden web araması yapar. İsim, email, dork (site:example.com), kurum araması vb. için kullan. BULUNAN SONUÇLARI DOĞRUDAN KABUL ETME: Sonuçların hedefin bilinen diğer tanımlayıcılarıyla (email, username vb.) örtüşüp örtüşmediğini çapraz kontrol et.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Arama sorgusu (Örn: "sakurasnowangel83" veya site:pastebin.com "hedef@mail.com")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sherlock',
      description:
        'Search a username across 400+ social platforms (Instagram, Twitter, GitHub, Reddit, etc.). Use this when investigating a username/nickname.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'The username or nickname to search' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_github_osint',
      description:
        'Extract emails, real name, company, location, GPG/SSH keys from a GitHub username using the official GitHub API. Use when investigating a GitHub user.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub username to investigate' },
        },
        required: ['username'],
      },
    },
  },  {
    type: 'function',
    function: {
      name: 'query_graph',
      description:
        'Query the investigation graph (Neo4j) to see all connections for a given username, email, or entity. Use when the user asks about relationships, connections, or the graph.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'The username, email, or entity to query connections for' },
        },
        required: ['value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_stats',
      description:
        'Get overall statistics of the investigation graph (total nodes and relationships). Use when the user asks how much data is in the graph.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_graph_nodes',
      description:
        'List nodes currently stored in the investigation graph, optionally filtered by label such as Username, Email, Person, Platform, or Profile. Use when the user asks what the nodes actually are.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional node label filter like Username, Email, Person, Platform, Profile' },
          limit: { type: 'string', description: 'Optional max number of nodes to list, default 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cross_reference',
      description:
        'Get all verified identifiers (emails, handles, websites) linked to a known username in the graph. Use this BEFORE searching for a real name to find pivot points. Returns the trust chain so you can search by verified email or handle instead of a common name.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'The seed username whose linked identifiers to retrieve' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_metadata',
      description:
        'Extract EXIF/XMP/IPTC metadata from a file URL (image, SVG, PDF, etc.). Reveals hidden info like author name, GPS coordinates, camera model, software, export filename. Use when investigating a file or image for hidden clues.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL of the file to analyze for metadata' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_gpg_key',
      description:
        'Download and parse a GitHub user\'s GPG public key to extract hidden email addresses and real names. Very effective when commit emails are masked with noreply@github.com. Use when investigating a GitHub user\'s identity.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub username whose GPG key to analyze' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wayback_search',
      description:
        'Search the Wayback Machine (archive.org) for archived/cached versions of a URL. Finds deleted profiles, old tweets, changed bios, removed content. Use when investigating deleted or modified online content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to search in Wayback Machine archives' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Download and read content from a URL (web pages, text files, JSON, etc.). Works best with open/public pages. NOTE: Google Scholar, ResearchGate, Academia.edu, and most university portal search pages block automated access (403). Do NOT try these. Instead prefer: ORCID (orcid.org/search), GitHub profiles, personal blog/portfolio pages, public API endpoints, news articles, and LinkedIn public pages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch content from' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_email_registrations',
      description:
        'Check which online platforms/services an email address is registered on (Holehe). This is the key PIVOT tool: use a discovered email to find linked accounts on Amazon, Spotify, Gravatar, WordPress, Adobe, etc. Results are written to the graph as Email→REGISTERED_ON→Platform.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address to check across platforms' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_breaches',
      description:
        'Check if an email address appears in known data breaches (Have I Been Pwned / local DB). Returns which breaches, what data was exposed (passwords, phone numbers, etc.), and breach dates. This is the LEAK DETECTION tool: finding an email in a breach can reveal linked accounts, old passwords, and hidden identities.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address to check for data breaches' },
        },
        required: ['email'],
      },
    },
  },
]

// ─── Tool Executors ──────────────────────────────────────────────────
async function runSherlock(username: string): Promise<string> {
  if (!isLikelyUsernameCandidate(username)) {
    return `Sherlock yalnızca username/handle aramaları için uygundur. "${username}" boşluk içeriyor; bu bir gerçek isim gibi görünüyor ve yanlış pozitif üretebilir.`
  }

  const sherlockDir = path.resolve(__dirname, '../../osint_collection/sherlock')
  return new Promise((resolve) => {
    console.log(chalk.cyan(`\n   🌐 Sherlock `) + chalk.yellow.bold(username) + chalk.cyan(` için taranıyor...`))
    console.log(chalk.gray('   (Bu işlem 1-2 dk sürebilir)'))
    const proc = spawn(
      PYTHON,
      [
        '-m', 'sherlock_project', username,
        '--print-found',
        '--timeout', '10',
      ],
      { cwd: sherlockDir, timeout: 180000 }
    )
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', () => {})
    proc.on('close', async () => {
      const lines = out.split('\n').filter((l) => l.startsWith('[+'))
      console.log(chalk.green(`   ✅ Sherlock: `) + chalk.green.bold(`${lines.length} platform bulundu`))

      // Grafa yaz
      try {
        const platforms = lines.map((l) => {
          const urlMatch = l.match(/https?:\/\/[^\s]+/)
          const nameMatch = l.match(/\[\+\]\s+([^:]+):/)
          return { platform: nameMatch?.[1]?.trim() || 'unknown', url: urlMatch?.[0] || '' }
        }).filter(p => p.url)
        const stats = await writeOsintToGraph(username, { platforms }, 'sherlock')
        console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
      } catch (e) {
        console.log(chalk.gray(`   ⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)`))
      }

      resolve(out || 'No results found.')
    })
    proc.on('error', (e) => resolve(`Sherlock error: ${e.message}`))
  })
}

async function runGithubOsint(username: string): Promise<string> {
  console.log(chalk.cyan(`\n   🐙 GitHub API OSINT: `) + chalk.yellow.bold(username) + chalk.cyan(`...`))
  const result = await githubOsint(username)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return result.error
  }
  console.log(chalk.green(`   ✅ GitHub OSINT: `) + chalk.green.bold(`${result.emails.length} email bulundu`))

  // Grafa yaz
  try {
    const profile = result.profile as Record<string, any>
    const stats = await writeOsintToGraph(username, {
      emails: result.emails,
      realName: profile.name || undefined,
      location: profile.location || undefined,
      company: profile.company || undefined,
      twitter: profile.twitter_username || undefined,
      blog: profile.blog || undefined,
    }, 'github_api')
    console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
  } catch (e) {
    console.log(chalk.gray(`   ⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)`))
  }

  return result.rawSummary
}

async function executeTool(
  name: string,
  args: Record<string, string>
): Promise<string> {
  if (name === 'run_sherlock') return runSherlock(args.username)
  if (name === 'run_github_osint') return runGithubOsint(args.username)
  if (name === 'query_graph') return queryGraph(args.value)
  if (name === 'graph_stats') return graphStats()
  if (name === 'list_graph_nodes') return runListGraphNodes(args.label, args.limit)
  if (name === 'cross_reference') return runCrossReference(args.username)
  if (name === 'extract_metadata') return runExtractMetadata(args.url)
  if (name === 'parse_gpg_key') return runParseGpgKey(args.username)
  if (name === 'wayback_search') return runWaybackSearch(args.url)
  if (name === 'web_fetch') return runWebFetch(args.url)
  if (name === 'check_email_registrations') return runEmailRegistrations(args.email)
  if (name === 'check_breaches') return runBreachCheck(args.email)
  if (name === 'search_web') return runSearchWeb(args.query)
  if (name === 'clear_graph') return runClearGraph(args.confirm === true || args.confirm === 'true')
  return `Unknown tool: ${name}`
}

async function runExtractMetadata(url: string): Promise<string> {
  console.log(chalk.cyan(`\n   🔍 Metadata çıkarılıyor: `) + chalk.yellow.bold(url) + chalk.cyan(`...`))
  const result = await extractMetadataFromUrl(url)
  const interesting = Object.keys(result.interestingFields).length
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
  } else {
    console.log(chalk.green(`   ✅ ${Object.keys(result.fields).length} metadata alanı bulundu (${interesting} OSINT-relevant)`))
  }
  return formatMetadata(result)
}

async function runParseGpgKey(username: string): Promise<string> {
  console.log(chalk.cyan(`\n   🔑 GPG key analizi: `) + chalk.yellow.bold(username) + chalk.cyan(`...`))
  const result = await parseGithubGpgKey(username)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
  } else {
    console.log(chalk.green(`   ✅ ${result.emails.length} email, ${result.names.length} isim bulundu`))
  }

  // Email'leri grafa yaz
  if (result.emails.length > 0) {
    try {
      const stats = await writeOsintToGraph(username, { emails: result.emails, realName: result.names[0] }, 'gpg_key')
      console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
    } catch {
      console.log(chalk.gray(`   ⚠️  Graf yazma atlandı`))
    }
  }

  return formatGpgResult(result)
}

async function runWaybackSearch(url: string): Promise<string> {
  console.log(chalk.cyan(`\n   📸 Wayback Machine aranıyor: `) + chalk.yellow.bold(url) + chalk.cyan(`...`))
  const result = await waybackSearch(url)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
  } else {
    console.log(chalk.green(`   ✅ ${result.snapshots.length} arşiv snapshot'ı bulundu`))
  }
  return formatWaybackResult(result)
}

async function runWebFetch(url: string): Promise<string> {
  console.log(chalk.cyan(`\n   🌐 Sayfa çekiliyor: `) + chalk.yellow.bold(url) + chalk.cyan(`...`))
  const result = await webFetch(url)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return `Fetch hatası: ${result.error}`
  }
  console.log(chalk.green(`   ✅ ${result.contentType} (HTTP ${result.statusCode})`))
  if (result.textContent) {
    return result.textContent.slice(0, 5000)
  }
  return `Binary dosya indirildi: ${result.savedTo} (${result.contentType})`
}

async function runEmailRegistrations(email: string): Promise<string> {
  console.log(chalk.cyan(`\n   📧 Email kayıt kontrolü (Holehe): `) + chalk.yellow.bold(email) + chalk.cyan(`...`))
  console.log(chalk.gray('   (120+ platform taranıyor, ~30-60sn)'))
  const result = await checkEmailRegistrations(email)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return formatHoleheResult(result)
  }
  console.log(chalk.green(`   ✅ ${result.totalChecked} platform tarandı, ${result.services.length} kayıt bulundu`))

  // Grafa yaz: Email → REGISTERED_ON → Platform
  if (result.services.length > 0) {
    try {
      const stats = await writeEmailRegistrations(email, result.services, 'holehe')
      console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
    } catch {
      console.log(chalk.gray(`   ⚠️  Graf yazma atlandı`))
    }
  }

  return formatHoleheResult(result)
}



async function runClearGraph(confirm: boolean): Promise<string> {
  if (!confirm) return 'Silme işlemi onaylanmadı.';
  console.log(chalk.red.bold(`\n   ⚠️  Graf veritabanı temizleniyor...`));
  try {
    process.env.NEO4J_ALLOW_CLEAR = '1';
    await clearGraph();
    console.log(chalk.green(`   ✅ Graf veritabanı başarıyla temizlendi.`));
    return 'Tüm graf veritabanı kalıcı olarak silindi ve sıfırlandı.';
  } catch (e) {
    console.log(chalk.red(`   ❌ Hata: ${(e as Error).message}`));
    return `Temizleme hatası: ${(e as Error).message}`;
  }
}

async function runSearchWeb(query: string): Promise<string> {
  console.log(chalk.cyan(`\n   🔎 Web'de aranıyor (Dorking): `) + chalk.yellow.bold(query) + chalk.cyan(`...`))
  const result = await searchWeb(query)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return formatSearchResult(result)
  }
  console.log(chalk.green(`   ✅ ${result.results.length} sonuç bulundu`))
  return formatSearchResult(result)
}

async function runBreachCheck(email: string): Promise<string> {
  console.log(chalk.cyan(`\n   🔓 Veri sızıntısı kontrolü: `) + chalk.yellow.bold(email) + chalk.cyan(`...`))
  const result = await checkBreaches(email)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return formatBreachResult(result)
  }
  console.log(chalk.green(`   ✅ ${result.breaches.length} sızıntı bulundu (kaynak: ${result.source})`))

  // Grafa yaz: Email → LEAKED_IN → Breach
  if (result.breaches.length > 0) {
    try {
      const stats = await writeBreachData(email, result.breaches, result.source === 'hibp' ? 'hibp' : 'local_breach_db')
      console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
    } catch {
      console.log(chalk.gray(`   ⚠️  Graf yazma atlandı`))
    }
  }

  return formatBreachResult(result)
}

async function queryGraph(value: string): Promise<string> {
  console.log(chalk.cyan(`\n   📊 Graf sorgulanıyor: `) + chalk.yellow.bold(value) + chalk.cyan(`...`))
  try {
    const connections = await getConnections(value)
    if (connections.length === 0) return `"${value}" için grafta bağlantı bulunamadı.`
    const lines = connections.map((c) => {
      const meta = c.confidence ? ` [✅ ${c.confidence}${c.source ? ` via ${c.source}` : ''}]` : ''
      return `${c.from} --[${c.relation}]--> ${c.to} (${c.toLabel})${meta}`
    })
    console.log(chalk.green(`   ✅ ${connections.length} bağlantı bulundu`))
    return `Graf bağlantıları (${value}):\n${lines.join('\n')}`
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function runCrossReference(username: string): Promise<string> {
  console.log(chalk.cyan(`\n   🔗 Çapraz doğrulama: `) + chalk.yellow.bold(username) + chalk.cyan(`...`))
  try {
    const ids = await findLinkedIdentifiers(username)
    const lines: string[] = [`Çapraz doğrulama sonuçları (“${username}” için doğrulanmış tanımlayıcılar):`]

    if (ids.emails.length > 0) lines.push(`- Email: ${ids.emails.join(', ')}`)
    if (ids.realNames.length > 0) lines.push(`- Gerçek isim: ${ids.realNames.join(', ')}`)
    if (ids.handles.length > 0) lines.push(`- Bağlı handle: ${ids.handles.join(', ')}`)
    if (ids.websites.length > 0) lines.push(`- Website: ${ids.websites.join(', ')}`)

    if (lines.length === 1) {
      lines.push('- Hiçbir doğrulanmış tanımlayıcı bulunamadı. Önce run_github_osint veya run_sherlock ile bilgi toplamalısın.')
    } else {
      lines.push('')
      lines.push('💡 Strateji: Bu doğrulanmış bilgileri kullanarak pivot yap.')
      lines.push('- Email ile arama yap (platformlarda email ile kayıtlı mı?)')
      lines.push('- Diğer handle\'ları Sherlock ile tara')
      lines.push(`- “${ids.realNames[0] || username}” ismi çok yaygınsa, yalnızca isim eşleşmesine güvenme — email veya handle eşleşmesi gerekli.`)
    }

    console.log(chalk.green(`   ✅ ${ids.emails.length} email, ${ids.handles.length} handle, ${ids.realNames.length} isim bulundu`))
    return lines.join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function graphStats(): Promise<string> {
  console.log(chalk.cyan(`\n   📊 Graf istatistikleri çekiliyor...`))
  try {
    const stats = await getGraphStats()
    console.log(chalk.green(`   ✅ ${stats.nodes} node, ${stats.relationships} ilişki`))
    return `Graf istatistikleri:\n- Toplam node: ${stats.nodes}\n- Toplam ilişki: ${stats.relationships}`
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function runListGraphNodes(label?: string, limit?: string): Promise<string> {
  console.log(chalk.cyan(`\n   🧩 Graf node listesi çekiliyor...`))
  try {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 50
    const counts = await getGraphNodeCountsByLabel()
    const nodes = await listGraphNodes(Number.isFinite(parsedLimit) ? parsedLimit : 50, label)

    const lines: string[] = ['Graf node özeti:', 'Not: Bu sayılar ve listeler tüm graf içindir; tek bir kullanıcıya otomatik olarak atfedilmemelidir.']
    for (const item of counts) {
      lines.push(`- ${item.label}: ${item.count}`)
    }

    if (nodes.length === 0) {
      lines.push(label
        ? `- ${label} etiketi için node bulunamadı.`
        : '- Listelenecek node bulunamadı.')
      return lines.join('\n')
    }

    lines.push('')
    lines.push(label ? `${label} node'ları:` : `İlk ${nodes.length} node:`)
    for (const node of nodes) {
      lines.push(`- ${node.label}: ${node.value}`)
    }

    console.log(chalk.green(`   ✅ ${nodes.length} node listelendi`))
    return lines.join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function repairGraphNoise(): Promise<string> {
  console.log(chalk.cyan(`\n   🧹 Graf gürültüsü temizleniyor...`))
  try {
    const result = await pruneMisclassifiedFullNameUsernames()
    console.log(chalk.green(`   ✅ ${result.usernamesRemoved} username, ${result.profilesRemoved} profil temizlendi`))
    return [
      'Graf temizleme özeti:',
      `- Silinen hatalı Username node: ${result.usernamesRemoved}`,
      `- Silinen ilişkili Profile node: ${result.profilesRemoved}`,
      `- Silinen orphan Platform node: ${result.orphanPlatformsRemoved}`,
    ].join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

// ─── Conversation ────────────────────────────────────────────────────
type Message = OpenAI.Chat.ChatCompletionMessageParam

const history: Message[] = [
  {
    role: 'system',
    content: `Sen bir OSINT (açık kaynak istihbarat) asistanısın. Kullanıcıyla normal bir sohbet yapabilirsin.

Kullanılabilir araçlar (12 araç):

🔍 KEŞIF ARAÇLARI:
- run_sherlock: Username'i 400+ sosyal medya platformunda arar.
- run_github_osint: GitHub API ile profil, email, company, location çeker.
- parse_gpg_key: GitHub GPG key'inden gizli email/isim çıkarır. Noreply email varsa çok etkili.
- extract_metadata: Dosya (görsel, PDF, SVG) EXIF/XMP metadata'sı çıkarır.
- wayback_search: Wayback Machine'de silinmiş/eski sayfaları arar.
- web_fetch: URL'den sayfa/dosya indirir. ⛔ Google Scholar, ResearchGate, Academia.edu çalışmaz.
- search_web: Tavily AI üzerinden web'de isim, email, dork (site:example.com) araması yapar.

🔗 PİVOT ARAÇLARI (YENİ — email üzerinden genişletme):
- check_email_registrations: (Holehe) Email'in Amazon, Spotify, Gravatar, WordPress, Adobe vb. 120+ platformda kayıtlı olup olmadığını kontrol eder. Bulunan her platform grafa Email→REGISTERED_ON→Platform olarak yazılır.
- check_breaches: (Have I Been Pwned / lokal DB) Email'in veri sızıntılarında olup olmadığını kontrol eder. Sızıntı bulunursa grafa Email→LEAKED_IN→Breach olarak yazılır. Sızan veriler (şifre, telefon, IP) de gösterilir.

📊 GRAF ARAÇLARI:
- query_graph: Neo4j'de bağlantıları sorgular (kaynak + güven seviyesi ile).
- graph_stats: Graf istatistiklerini gösterir.
- list_graph_nodes: Graf node'larını listeler.
- cross_reference: Username'e bağlı doğrulanmış email/handle/website getirir.
- clear_graph: Tüm grafı siler (sadece kullanıcı isterse kullan).

⚠️ KİMLİK DOĞRULAMA KURALLARI (ÇOK ÖNEMLİ):

Güven Zinciri (Chain of Trust):
- "verified": Doğrudan API'den gelen bilgi. Kesin doğru.
- "high": Username/email tam eşleşmesi (Sherlock, Holehe). Çok güvenilir.
- "medium": Dolaylı bağlantı (Wayback, metadata). Doğrulanmalı.
- "low": Sadece isim eşleşmesi. DİKKAT!

🎯 PİVOT STRATEJİSİ (Araştırma Akışı):
1. USERNAME KEŞFI: run_sherlock + run_github_osint ile doğrulanmış bilgi topla
2. EMAIL PİVOT: Bulunan email'i check_email_registrations ile tara → hangi platformlarda kayıtlı?
3. SIZINTI KONTROLÜ: Aynı email'i check_breaches ile kontrol et → sızıntılarda mı?
4. ÇAPRAZ DOĞRULAMA: cross_reference ile tüm bağları kontrol et
5. GENİŞLETME: Sızıntıdan yeni email/telefon çıkarsa, onlarla da pivot yap
6. GRAF SORGULA: query_graph ile tüm bağlantı ağını göster

Bu akış Neo4j'de şu yapıyı oluşturur:
(Username)→[USES_EMAIL]→(Email)→[REGISTERED_ON]→(Platform)
                                →[LEAKED_IN]→(Breach)
                                →[RECOVERY_EMAIL]→(Email2)
                                →[LINKED_PHONE]→(Phone)

"Altın Senaryo" Örneği:
1. @HackerX girişi → tek mavi nokta
2. Sherlock → 10 platform bağlanır
3. GitHub → email yakalanır (kırmızı nokta)
4. Holehe → email Amazon, Spotify'da kayıtlı → yeni bağlantılar
5. Breach check → email bir sızıntıda! → Breach node bağlanır
6. Sızıntıdaki recovery email → başka bir hesap deşifre edilebilir

Yaygın İsim Problemi:
- "Salih Dursun", "Mehmet Yılmaz" gibi isimler → pivot email/handle üzerinden yap, isimle değil.
- Gerçek isimle arama → ÖNCE cross_reference ile mevcut tanımlayıcıları çek.

Bağlam Doğrulama:
- Kullanıcı bağlam veriyorsa (meslek, kurum), her sonucu bu bağlamla kontrol et.
- Bağlam uyuşmazlığı varsa "⚠️ Bağlam uyuşmazlığı" ile işaretle.
- Sherlock sonuçlarının HEPSİNİ tek kişiye atfetme.

Özel kurallar:
6. Web aramaları (search_web) sonuçlarını KESİNLİKLE doğrudan kabul etme. Sonuçlardaki metinleri hedefin bilinen diğer tanımlayıcılarıyla (email, username, vb.) Çapraz Doğrula. Sadece uyuşan sonuçları hedefe ait kabul et.
7. Gerçek isim → önce cross_reference ile grafta handle ara.
8. list_graph_nodes/graph_stats tüm graf içindir.
9. query_graph sonuçlarında güven seviyesi gösterilir.
10. İsimden username türetme (tahmin). Türetilmişse "⚠️ low confidence — tahmin" etiketle.
11. Bağlamla çelişen sonuçları "⚠️ Bağlam uyuşmazlığı" ile işaretle.
12. Email bulduğunda MUTLAKA check_email_registrations ve check_breaches ile pivot yap. Bu en değerli adımdır.

Kullanım kuralları:
1. Araçları YALNIZCA kullanıcı araştırma istediğinde kullan.
2. Genel sorulara araç KULLANMA.
3. Kapsamlı araştırmada birden fazla aracı sırayla kullan.
4. Sonuçlar otomatik olarak Neo4j'ye yazılır.
5. Sonuçları Türkçe, kısa, madde madde özetle. Güven seviyesini belirt.`,
  },
]

async function chat(userMessage: string): Promise<void> {
  history.push({ role: 'user', content: userMessage })

  // Agent loop — araç çağrısı bitene kadar devam et
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: sanitizeHistoryForProvider(history),
      tools,
      tool_choice: 'auto',
      max_tokens: 4096,
    })

    const message = response.choices[0].message
    history.push(normalizeAssistantMessage(message))

    // Araç çağrısı yok → final cevap
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const refusalText = typeof message.refusal === 'string' && message.refusal.trim().length > 0
        ? message.refusal
        : ''
      const finalText = typeof message.content === 'string' && message.content.trim().length > 0
        ? message.content
        : (refusalText || 'Araçlar çalıştı ama model boş yanıt döndürdü. Elimdeki sonuçları tekrar özetlememi isteyebilirsin.')
      const formatted = formatAgentOutput(finalText)
      console.log(`\n${chalk.magenta.bold('🤖 Agent:')}\n${formatted}\n`)
      return
    }

    // Araçları çalıştır
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function') continue
      let result = ''
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, string>
        result = await executeTool(toolCall.function.name, args)
      } catch (error) {
        result = `Tool hatası (${toolCall.function.name}): ${(error as Error).message}`
      }
      history.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: normalizeToolContent(result),
      })
    }
  }
}

// ─── Markdown-like terminal formatter ──────────────────────────────
function formatAgentOutput(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // ## Başlıklar
      if (/^##\s/.test(line)) return chalk.cyan.bold(line.replace(/^##\s/, ''))
      if (/^#\s/.test(line)) return chalk.cyan.bold.underline(line.replace(/^#\s/, ''))
      // - madde işaretleri
      if (/^[-*]\s/.test(line)) return chalk.white('  • ') + line.slice(2)
      // **bold** → renkli
      line = line.replace(/\*\*(.+?)\*\*/g, (_, m) => chalk.yellow.bold(m))
      // `kod` → renkli
      line = line.replace(/`([^`]+)`/g, (_, m) => chalk.green(m))
      // URL'ler
      line = line.replace(/(https?:\/\/[^\s]+)/g, (url) => chalk.blue.underline(url))
      return line
    })
    .join('\n')
}

// ─── CLI ──────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const border = chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(border)
console.log(chalk.bold.white('🕵️  OSINT Agent') + chalk.gray(' — Dijital Müfettiş'))
console.log(border)
console.log(chalk.gray('Örnek: ') + chalk.cyan('"torvalds hakkında araştır"'))
console.log(chalk.gray('       ') + chalk.cyan('"hippiiee GitHub kullanıcısını incele"'))
console.log(chalk.gray('Çıkmak için: ') + chalk.red('exit') + '\n')

function prompt() {
  if (!process.stdin.readable) return
  rl.question(chalk.bold.green('Sen: '), async (line) => {
    const input = line.trim()
    if (!input) { prompt(); return }
    if (input.toLowerCase() === 'exit') {
      console.log(chalk.gray('Görüşürüz.'))
      await closeNeo4j()
      rl.close()
      process.exit(0)
    }
    try {
      await chat(input)
    } catch (e) {
      console.error(chalk.red('Hata:'), (e as Error).message)
    }
    prompt()
  })
}

rl.on('close', async () => {
  console.log(chalk.gray('\nOturum kapandı.'))
  await closeNeo4j()
  process.exit(0)
})

prompt()

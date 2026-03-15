import 'dotenv/config'
import OpenAI from 'openai'
import * as readline from 'readline'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import chalk from 'chalk'
import { githubOsint } from './tools/githubTool.js'
import { writeOsintToGraph, getConnections, getGraphStats, getGraphNodeCountsByLabel, listGraphNodes, pruneMisclassifiedFullNameUsernames, findLinkedIdentifiers, writeEmailRegistrations, writeBreachData, writeScrapeData, writeFollowingConnections, mergeRelation, closeNeo4j, clearGraph, deleteGraphNodeAndRelations } from './lib/neo4j.js'
import { normalizeAssistantMessage, normalizeToolContent, sanitizeHistoryForProvider } from './lib/chatHistory.js'
import { isLikelyUsernameCandidate } from './lib/osintHeuristics.js'
import { extractMetadataFromUrl, extractMetadataFromFile, formatMetadata } from './tools/metadataTool.js'
import { parseGithubGpgKey, parseGpgKeyFile, formatGpgResult } from './tools/gpgParserTool.js'
import { waybackSearch, formatWaybackResult } from './tools/waybackTool.js'
import { webFetch } from './tools/webFetchTool.js'
import { checkEmailRegistrations, formatHoleheResult } from './tools/holeheTool.js'
import { checkBreaches, formatBreachResult } from './tools/breachCheckTool.js'
import { searchWeb, formatSearchResult } from './tools/searchTool.js'
import { scrapeProfile, formatScrapeResult } from './tools/scrapeTool.js'
import { verifySherlockProfiles, formatVerificationResults } from './tools/profileVerifier.js'
import { fetchAndHashImage } from './tools/imageHasher.js'
import { fetchNitterProfile, formatNitterResult } from './tools/nitterTool.js'
import { findUnexploredPivots, formatUnexploredPivots } from './lib/pivotAnalyzer.js'
import { searchPerson, formatPersonSearchResult } from './tools/personSearchTool.js'
import os from 'os'
import { writeFile, unlink } from 'fs/promises'

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
      name: 'remove_false_positive',
      description: 'Silinmesi gereken hatalı, yanlış eklenmiş veya hedefle uyuşmayan graf düğümünü ve onun ilişkilerini siler (False Positive temizliği için).',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Silinecek düğümün türü/etiketi (örn. Username, Email, Person, Profile)' },
          value: { type: 'string', description: 'Silinecek düğümün spesifik değeri (örn. target@gmail.com, targetUsername)' },
        },
        required: ['label', 'value'],
        additionalProperties: false,
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
        'Extract emails, real name, company, location, bio, blog, GPG/SSH keys from a GitHub username using the official GitHub API. Use when investigating a GitHub user. Set deep=true for DEEP MODE: fetches all following accounts, filters out public figures (>500 followers), and maps real connections with their bios and locations — great for finding social circles and shared context (same university, same city).',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub username to investigate' },
          deep: { type: 'string', enum: ['true', 'false'], description: 'Set to true for deep mode: fetches following list, filters real people by follower count, reads their bios. Slower but reveals social connections.' },
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
  {
    type: 'function',
    function: {
      name: 'scrape_profile',
      description:
        'Scrape a webpage using Firecrawl stealth proxy. Works well on: GitHub, personal blogs, forums, CTF writeup sites, portfolio pages. Returns page as Markdown and auto-extracts emails, crypto wallets (BTC/ETH), Telegram links, and external URLs. NOTE: Twitter/X and Reddit are NOT supported by Firecrawl free tier — use web_fetch for those (will auto-fallback). ⚠️ Monthly limit: 500 requests — use only when web_fetch gets blocked (403).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the profile/page to scrape (e.g. https://twitter.com/username, https://tiktok.com/@user)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_profiles',
      description:
        'Sherlock sonuçlarını çapraz doğrula: Bulunan profil URL\'lerini Firecrawl ile kazıyarak, profil sahibinin hedef kişiye ait olup olmadığını kontrol eder. Bilinen email, gerçek isim, konum, blog ile sayfadaki bilgileri karşılaştırır. Eşleşme varsa güven "high"a yükselir. Sherlock çalıştıktan SONRA kullan — önce GitHub OSINT ile bilinen bilgileri topla.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Araştırılan kullanıcı adı (graftan bilinen tanımlayıcılar çekilir)' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nitter_profile',
      description:
        'Twitter/X profilini Nitter üzerinden oku. Firecrawl ve web_fetch Twitter\'da 403 verdiği için Nitter kullanılır. Bio, konum, website, katılım tarihi, tweet/takipçi sayısı ve son tweetleri çeker. Ücretsiz, API key gerektirmez.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Twitter/X kullanıcı adı (@ olmadan)' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unexplored_pivots',
      description:
        'Graf üzerinden henüz pivot yapılmamış (araştırılmamış) node\'ları ve fırsatları bul. Örneğin: bir email bulundu ama check_email_registrations yapılmadı, veya bir website var ama scrape edilmedi. Agent\'ın "bir sonraki en verimli adımı" otomatik belirlemesine yardımcı olur.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Araştırma kök kullanıcı adı' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_person',
      description:
        'Gerçek isimle araştırma başlat. Grafta ters arama yapar (Person node → Username/Email), olası username\'ler türetir ve web\'de arar. ÖNEMLİ: Yaygın isimler (Mehmet Yılmaz) ile yanlış pozitif riski yüksektir — ek bağlam (şehir, kurum, meslek) ver. Tam isimle Sherlock çalıştırmak da hatalı sonuç verir — önce bu tool ile username bul, sonra Sherlock kullan.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Araştırılan kişinin gerçek ismi (Örn: "Berkay Hasırcı")' },
          context: { type: 'string', description: 'Opsiyonel bağlam: meslek, şehir, kurum (Örn: "İstanbul yazılımcı")' },
        },
        required: ['name'],
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

async function runGithubOsint(username: string, deep = false): Promise<string> {
  console.log(chalk.cyan(`\n   🐙 GitHub API OSINT: `) + chalk.yellow.bold(username) + chalk.cyan(deep ? ` (DEEP MOD)...` : `...`))
  const result = await githubOsint(username, deep)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return result.error
  }
  console.log(chalk.green(`   ✅ GitHub OSINT: `) + chalk.green.bold(`${result.emails.length} email bulundu`))

  // Grafa yaz
  try {
    const profile = result.profile as Record<string, string | null>
    const stats = await writeOsintToGraph(username, {
      emails: result.emails,
      realName: profile.name || undefined,
      location: profile.location || undefined,
      company: profile.company || undefined,
      twitter: profile.twitter_username || undefined,
      blog: profile.blog || undefined,
      avatarUrl: profile.avatar_url || undefined,
    }, 'github_api')
    console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
  } catch {
    console.log(chalk.gray(`   ⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)`))
  }

  // Deep mod: following bağlantılarını grafa yaz
  if (result.following.length > 0) {
    const realPeople = result.following.filter(f => !f.skipped)
    console.log(chalk.cyan(`   🔍 Following analizi: `) + chalk.green.bold(`${realPeople.length} gerçek kişi`) + chalk.gray(` (${result.following.length - realPeople.length} atlandı)`))
    try {
      const stats = await writeFollowingConnections(username, result.following, 'github_api')
      console.log(chalk.blue(`   💾 Following grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
    } catch {
      console.log(chalk.gray(`   ⚠️  Following graf yazma atlandı`))
    }
  }

  return result.rawSummary
}

  // Session bazlı önbellekleme (Caching) yapısı: Aynı aramaların tekrar tekrar yapılmasını önler.
  const toolCache = new Map<string, string>();

  async function executeTool(
    name: string,
    args: Record<string, string>
  ): Promise<string> {
    const cacheableTools = new Set([
      'run_sherlock', 'run_github_osint', 'cross_reference', 'extract_metadata',
      'parse_gpg_key', 'wayback_search', 'web_fetch', 'check_email_registrations',
      'check_breaches', 'search_web', 'scrape_profile', 'verify_profiles',
      'nitter_profile', 'search_person'
    ]);

    const cacheKey = `${name}:${JSON.stringify(args)}`;
    
    if (cacheableTools.has(name) && toolCache.has(cacheKey)) {
      console.log(chalk.yellow(`   ⚡ [Cache Hit] ${name} (${JSON.stringify(args)}) hafızadan getirildi. Tekrar çalıştırılmadı.`));
      return toolCache.get(cacheKey)!;
    }

    let result = '';
    
    if (name === 'run_sherlock') result = await runSherlock(args.username)
    else if (name === 'run_github_osint') result = await runGithubOsint(args.username, args.deep === 'true')
    else if (name === 'query_graph') result = await queryGraph(args.value)
    else if (name === 'graph_stats') result = await graphStats()
    else if (name === 'list_graph_nodes') result = await runListGraphNodes(args.label, args.limit)
    else if (name === 'cross_reference') result = await runCrossReference(args.username)
    else if (name === 'extract_metadata') result = await runExtractMetadata(args.url)
    else if (name === 'parse_gpg_key') result = await runParseGpgKey(args.username)
    else if (name === 'wayback_search') result = await runWaybackSearch(args.url)
    else if (name === 'web_fetch') result = await runWebFetch(args.url)
    else if (name === 'check_email_registrations') result = await runEmailRegistrations(args.email)
    else if (name === 'check_breaches') result = await runBreachCheck(args.email)
    else if (name === 'search_web') result = await runSearchWeb(args.query)
    else if (name === 'scrape_profile') result = await runScrapeProfile(args.url)
    else if (name === 'verify_profiles') result = await runVerifyProfiles(args.username)
    else if (name === 'nitter_profile') result = await runNitterProfile(args.username)
    else if (name === 'unexplored_pivots') result = await runUnexploredPivots(args.username)
    else if (name === 'search_person') result = await runSearchPerson(args.name, args.context)
    else if (name === 'clear_graph') result = await runClearGraph(args.confirm === 'true' || (args.confirm as unknown) === true)
    else if (name === 'remove_false_positive') result = await runRemoveFalsePositive(args.label, args.value)
    else result = `Unknown tool: ${name}`;

    if (cacheableTools.has(name) && !result.startsWith('Unknown tool')) {
      toolCache.set(cacheKey, result);
    }
    
    return result;
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
  let result = await parseGithubGpgKey(username)

  // GitHub .gpg endpoint boş döndüyse → repo'da raw PGP dosyası arama yap
  if (result.error && result.emails.length === 0) {
    console.log(chalk.gray(`   🔍 Repo'da PGP key aranıyor (${username}/PGP)...`))
    const rawUrls = [
      `https://raw.githubusercontent.com/${username}/PGP/main/pgp.asc`,
      `https://raw.githubusercontent.com/${username}/PGP/main/publickey`,
      `https://raw.githubusercontent.com/${username}/pgp/main/pgp.asc`,
      `https://raw.githubusercontent.com/${username}/PGP/master/pgp.asc`,
      `https://raw.githubusercontent.com/${username}/gpg/main/key.asc`,
    ]
    for (const rawUrl of rawUrls) {
      try {
        const raw = await webFetch(rawUrl)
        if (!raw.error && raw.textContent && raw.textContent.includes('BEGIN PGP PUBLIC KEY')) {
          console.log(chalk.green(`   ✅ Repo'da PGP key bulundu: ${rawUrl}`))
          const tmpFile = `${os.tmpdir()}/pgp-${Date.now()}.asc`
          await writeFile(tmpFile, raw.textContent)
          result = await parseGpgKeyFile(tmpFile)
          result = { ...result, source: rawUrl }
          await unlink(tmpFile).catch(() => {})
          break
        }
      } catch { /* bu URL'de yok, devam */ }
    }
  }

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
  let result = await webFetch(url)
  
  // HİBRİT FALLBACK: Eğer 403 (Cloudflare/Bot protection) veya bağlantı hatası alırsak, Firecrawl API'sine (scrapeTool) düş.
  if (result.error || result.statusCode === 403 || result.statusCode === 401) {
    console.log(chalk.gray(`   ⚠️ curl engellendi (HTTP ${result.statusCode || 'Hata'}). Firecrawl Stealth Proxy'ye geçiliyor...`))
    try {
      const scrapeResult = await scrapeProfile(url)
      if (!scrapeResult.error) {
        console.log(chalk.green(`   ✅ Firecrawl ile başarıyla çekildi (Markdown okundu)`))
        // Scrape sonuçlarını formatlayıp dön
        return formatScrapeResult(scrapeResult)
      } else {
        console.log(chalk.red(`   ❌ Firecrawl da başarısız: ${scrapeResult.error}`))
        return `Fetch ve Scrape hatası: ${scrapeResult.error}`
      }
    } catch (e) {
      console.log(chalk.red(`   ❌ Scrape modülü hatası: ${(e as Error).message}`))
      return `Scrape hatası: ${(e as Error).message}`
    }
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

async function runRemoveFalsePositive(label: string, value: string): Promise<string> {
  console.log(chalk.red.bold(`\n   🧹 False Positive Temizleniyor: `) + chalk.yellow(`${label}(${value})`));
  try {
    const success = await deleteGraphNodeAndRelations(label, value);
    if (success) {
      console.log(chalk.green(`   ✅ Düğüm ve ilişkileri Graf'tan silindi.`));
      return `Başarı: ${label} etiketli ve ${value} değerli düğüm (ve bağlı ilişkileri) sinildi.`;
    } else {
      console.log(chalk.yellow(`   ⚠️ Eşleşen düğüm bulunamadı veya silinemedi.`));
      return `Hata: ${label} etiketli ve ${value} değerli düğüm bulunamadı.`;
    }
  } catch (e) {
    console.log(chalk.red(`   ❌ Temizleme hatası: ${(e as Error).message}`));
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

async function runScrapeProfile(url: string): Promise<string> {
  console.log(chalk.cyan(`\n   🕷️  Profil kazınıyor (Firecrawl): `) + chalk.yellow.bold(url) + chalk.cyan(`...`))
  const result = await scrapeProfile(url)
  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    if (result.usageWarning) console.log(chalk.yellow(`   ${result.usageWarning}`))
    return formatScrapeResult(result)
  }
  const found = [result.emails.length, result.cryptoWallets.length, result.usernameHints.length]
    .map((n, i) => n > 0 ? `${n} ${['email', 'cüzdan', 'handle'][i]}` : '')
    .filter(Boolean).join(', ')
  console.log(chalk.green(`   ✅ Sayfa alındı${found ? ` — ${found}` : ''}: ${result.title || url}`))

  // Bulunan OSINT verilerini grafa yaz
  if (result.emails.length > 0 || result.cryptoWallets.length > 0 || result.usernameHints.length > 0) {
    try {
      const stats = await writeScrapeData(url, result, 'firecrawl')
      console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
    } catch {
      console.log(chalk.gray(`   ⚠️  Graf yazma atlandı`))
    }
  }

  return formatScrapeResult(result)
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

async function runVerifyProfiles(username: string): Promise<string> {
  console.log(chalk.cyan(`\n   🔍 Profil doğrulama başlatılıyor: `) + chalk.yellow.bold(username) + chalk.cyan(`...`))

  // Graftan bilinen tanımlayıcıları çek
  let known: { emails: string[]; realNames: string[]; handles: string[]; websites: string[]; avatarUrl?: string }
  try {
    known = await findLinkedIdentifiers(username)
  } catch {
    return 'Neo4j bağlantısı kurulamadı — bilinen tanımlayıcılar çekilemedi.'
  }

  if (known.emails.length === 0 && known.realNames.length === 0 && !known.avatarUrl) {
    return `"${username}" için grafta bilinen email, gerçek isim veya avatar yok. Önce run_github_osint ile bilgi topla.`
  }

  // Eğer bilinen avatar URL'si varsa, hash'ini baştan hesapla ki her profilde tekrar indirmeyelim
  let avatarHash: string | undefined;
  if (known.avatarUrl) {
    console.log(chalk.gray(`   🖼️ Hedefin bilinen bir avatarı var, referans hash hesaplanıyor...`));
    avatarHash = (await fetchAndHashImage(known.avatarUrl)) || undefined;
    if (avatarHash) {
      console.log(chalk.green(`   ✅ Referans avatar hash eşleşti: `) + chalk.gray(avatarHash.substring(0, 16) + '...'));
    } else {
      console.log(chalk.yellow(`   ⚠️ Referans avatar indirilemedi veya hash hesaplanamadı.`));
    }
  }

  // Graftan Sherlock profil URL'lerini çek
  let profiles: Array<{ platform: string; url: string }>
  try {
    const connections = await getConnections(username)
    profiles = connections
      .filter(c => c.relation === 'HAS_PROFILE')
      .map(c => {
        // Platform adını URL'den çıkar
        const urlMatch = c.to.match(/(?:www\.)?([^./]+)\.\w+/)
        return { platform: urlMatch?.[1] || 'unknown', url: c.to }
      })
  } catch {
    return 'Neo4j bağlantısı kurulamadı — profiller çekilemedi.'
  }

  if (profiles.length === 0) {
    return `"${username}" için grafta doğrulanacak profil yok. Önce run_sherlock çalıştır.`
  }

  console.log(chalk.gray(`   📋 ${profiles.length} profil bulundu, doğrulama yapılıyor (max 10)...`))

  const knownIds = {
    username,
    realName: known.realNames[0],
    emails: known.emails,
    avatarUrl: known.avatarUrl,
    avatarHash: avatarHash
  }

  const { results, verified, unverified, skipped } = await verifySherlockProfiles(profiles, knownIds, 10)

  console.log(
    chalk.green(`   ✅ Doğrulama tamamlandı: `) +
    chalk.green.bold(`${verified} doğrulandı`) +
    chalk.gray(`, ${unverified} doğrulanmadı, ${skipped} atlandı`)
  )

  // Doğrulanan profillerin güven seviyesini grafta yükselt
  for (const r of results.filter(r => r.verified)) {
    try {
      await mergeRelation('Username', username, 'Profile', r.url, 'HAS_PROFILE', {
        source: 'profile_verification',
        confidence: 'high',
      })
    } catch { /* sessiz geç */ }
  }

  return formatVerificationResults(results)
}

async function runNitterProfile(username: string): Promise<string> {
  console.log(chalk.cyan(`\n   🐦 Twitter/X profil çekiliyor (Nitter): `) + chalk.yellow.bold(username) + chalk.cyan(`...`))
  const result = await fetchNitterProfile(username)

  if (result.error) {
    console.log(chalk.red(`   ❌ ${result.error}`))
    return formatNitterResult(result)
  }

  console.log(chalk.green(`   ✅ Twitter profili çekildi: `) + chalk.green.bold(result.displayName || username))

  // Grafa yaz
  try {
    const data: Record<string, string | undefined> = {}
    if (result.displayName) data.realName = result.displayName
    if (result.location) data.location = result.location
    if (result.website) data.blog = result.website

    const stats = await writeOsintToGraph(username, {
      realName: data.realName,
      location: data.location,
      blog: data.blog,
    }, 'nitter')
    console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`))
  } catch {
    console.log(chalk.gray(`   ⚠️  Graf yazma atlandı`))
  }

  return formatNitterResult(result)
}

async function runUnexploredPivots(username: string): Promise<string> {
  console.log(chalk.cyan(`\n   🧭 Keşfedilmemiş pivot noktaları aranıyor: `) + chalk.yellow.bold(username) + chalk.cyan(`...`))
  try {
    const pivots = await findUnexploredPivots(username)
    console.log(chalk.green(`   ✅ ${pivots.suggestions.length} öneri bulundu`))
    return formatUnexploredPivots(pivots)
  } catch (e) {
    console.log(chalk.red(`   ❌ ${(e as Error).message}`))
    return `Pivot analizi hatası: ${(e as Error).message}`
  }
}

async function runSearchPerson(name: string, context?: string): Promise<string> {
  console.log(chalk.cyan(`\n   👤 İsim araştırması: `) + chalk.yellow.bold(name) + (context ? chalk.gray(` (${context})`) : '') + chalk.cyan(`...`))
  const result = await searchPerson(name, context)

  if (result.graphMatches.length > 0) {
    const totalUsernames = result.graphMatches.reduce((sum, m) => sum + m.linkedUsernames.length, 0)
    console.log(chalk.green(`   ✅ Grafta ${result.graphMatches.length} eşleşme, ${totalUsernames} bağlı username bulundu`))
  } else {
    console.log(chalk.yellow(`   ⚠️ Grafta eşleşme yok — web araması yapıldı`))
  }

  return formatPersonSearchResult(result)
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
- run_github_osint: GitHub API ile profil, email, company, location, bio, blog çeker. deep=true ile following listesinden gerçek kişileri (< 500 follower) filtreler, biyolarını ve konumlarını haritalar.
- parse_gpg_key: GitHub GPG key'inden gizli email/isim çıkarır. Noreply email varsa çok etkili.
- extract_metadata: Dosya (görsel, PDF, SVG) EXIF/XMP metadata'sı çıkarır.
- wayback_search: Wayback Machine'de silinmiş/eski sayfaları arar.
- web_fetch: URL'den sayfa/dosya indirir. ⛔ Google Scholar, ResearchGate, Academia.edu çalışmaz.
- search_web: Tavily AI üzerinden web'de isim, email, dork (site:example.com) araması yapar.

🔗 PİVOT ARAÇLARI (YENİ — email üzerinden genişletme):
- check_email_registrations: (Holehe) Email'in Amazon, Spotify, Gravatar, WordPress, Adobe vb. 120+ platformda kayıtlı olup olmadığını kontrol eder. Bulunan her platform grafa Email→REGISTERED_ON→Platform olarak yazılır.
- check_breaches: (Have I Been Pwned / lokal DB) Email'in veri sızıntılarında olup olmadığını kontrol eder. Sızıntı bulunursa grafa Email→LEAKED_IN→Breach olarak yazılır. Sızan veriler (şifre, telefon, IP) de gösterilir.
- scrape_profile: (Firecrawl stealth) GitHub, kişisel bloglar, forum ve CTF writeup siteleri gibi sayfaları kazır. Bio, email, kripto cüzdan, Telegram linki çıkarır. Grafa Website→SCRAPE_FOUND→Email/CryptoWallet/Username olarak yazılır. ⚠️ Twitter/X ve Reddit Firecrawl free tier'da DESTEKLENM‌İYOR. ⚠️ Aylık 500 istek limiti var — web_fetch 403 verdiğinde fallback olarak otomatik devreye girer.

� DOĞRULAMA ARAÇLARI:
- verify_profiles: Sherlock'un bulduğu profilleri Firecrawl ile kazıyarak çapraz doğrular. Bio'daki email, isim, konum, blog bilgileri ile veya profil fotoğraflarının(avatar) uyuşması ile (Image hash karşılaştırması) bilinen tanımlayıcıları karşılaştırır. Eşleşme varsa güven "high"a yükselir. Önce GitHub OSINT ile bilinen bilgileri (avatar dahil) topla, sonra bunu kullan.
- nitter_profile: Twitter/X profilini Nitter üzerinden oku. Bio, konum, website, katılım tarihi, tweet/takipçi sayısı ve son tweetleri çeker. Firecrawl/web_fetch Twitter'da 403 verdiği için bu tool'u kullan. Ücretsiz, API key gerektirmez.
- search_person: Gerçek isimle araştırma başlat. Grafta ters arama yapar (Person → Username/Email), olası username'ler türetir ve web'de isim araması yapar. ÖNEMLİ: Yaygın isimlerle yanlış pozitif riski yüksek — ek bağlam ver (şehir, kurum, meslek). Önce bu tool ile username bul, sonra Sherlock kullan.

📊 GRAF ARAÇLARI:
- query_graph: Neo4j'de bağlantıları sorgular (kaynak + güven seviyesi ile).
- graph_stats: Graf istatistiklerini gösterir.
- list_graph_nodes: Graf node'larını listeler.
- cross_reference: Username'e bağlı doğrulanmış email/handle/website getirir.
- clear_graph: Tüm grafı siler (sadece kullanıcı isterse kullan).
- unexplored_pivots: Grafta henüz pivot yapılmamış (araştırılmamış) node'ları ve fırsatları bulur. Örneğin: email bulundu ama check_email_registrations yapılmadı, website var ama scrape edilmedi. Agent'ın bir sonraki en verimli adımı otomatik belirler.

⚠️ KİMLİK DOĞRULAMA KURALLARI (ÇOK ÖNEMLİ):

Güven Zinciri (Chain of Trust):
- "verified": Doğrudan API'den gelen bilgi. Kesin doğru. (github_api, gpg_key)
- "high": Email tam eşleşmesi (Holehe, HIBP, commit_email). Çok güvenilir.
- "medium": URL var ama kimlik doğrulanmadı (Sherlock, Wayback, metadata). DOĞRULANMALI.
- "low": Sadece isim eşleşmesi veya web araması. DİKKAT!

⚠️ SHERLOCK GÜVEN KURALI: Sherlock sonuçları "⚠️ Orta — URL mevcut, kimlik doğrulanmadı" olarak raporlanmalı. Sherlock sadece HTTP 200 kontrol eder; platformda o username'in hedef kişiye AİT olup olmadığını doğrulamaz. Örneğin TikTok'ta aynı username varsa bile farklı birine ait olabilir. Sherlock sonuçlarını yüksek güvenle raporlamak İSTİSNA: GitHub gibi profil içeriği (bio, email) ile çapraz doğrulama yapıldığında güven "high"a yükseltilebilir.

🎯 PİVOT STRATEJİSİ (Araştırma Akışı):
1. USERNAME KEŞFI: run_sherlock + run_github_osint ile doğrulanmış bilgi topla
2. PROFİL DOĞRULAMA: verify_profiles ile Sherlock sonuçlarını çapraz doğrula → eşleşen profillerin güveni "high"a yükselir
3. PROFİL KAZIMA: Sherlock'un bulduğu önemli profil URL'lerini scrape_profile ile tara → bio, email, kripto cüzdan
4. TWITTER OSINT: Sherlock'ta Twitter bulunursa nitter_profile ile bio/konum/website çek
5. EMAIL PİVOT: Bulunan email'i check_email_registrations ile tara → hangi platformlarda kayıtlı?
6. SIZINTI KONTROLÜ: Aynı email'i check_breaches ile kontrol et → sızıntılarda mı?
7. ÇAPRAZ DOĞRULAMA: cross_reference ile tüm bağları kontrol et
8. GENİŞLETME: Sızıntıdan yeni email/telefon çıkarsa, onlarla da pivot yap
9. GRAF SORGULA: query_graph ile tüm bağlantı ağını göster
10. PİVOT ANALİZİ: unexplored_pivots ile henüz araştırılmamış fırsatları bul → sonraki en verimli adımı seç

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
- Gerçek isimle arama → ÖNCE search_person ile grafta ters arama yap ve olası username'leri türet.
- cross_reference ile mevcut tanımlayıcıları çek.

Bağlam Doğrulama:
- Kullanıcı bağlam veriyorsa (meslek, kurum), her sonucu bu bağlamla kontrol et.
- Bağlam uyuşmazlığı varsa "⚠️ Bağlam uyuşmazlığı" ile işaretle.
- Sherlock sonuçlarının HEPSİNİ tek kişiye atfetme. Sherlock yalnızca URL varlığını kontrol eder; profil sahibinin hedef kişi olup olmadığını DOĞRULAMAZ.

Özel kurallar:
6. Web aramaları (search_web) sonuçlarını KESİNLİKLE doğrudan kabul etme. Sonuçlardaki metinleri hedefin bilinen diğer tanımlayıcılarıyla (email, username, vb.) Çapraz Doğrula. Sadece uyuşan sonuçları hedefe ait kabul et.
7. Gerçek isim → önce search_person ile grafta ters arama yap, username türet. Grafta yoksa cross_reference ile handle ara.
8. list_graph_nodes/graph_stats tüm graf içindir.
9. query_graph sonuçlarında güven seviyesi gösterilir.
10. İsimden username türetme (tahmin). Türetilmişse "⚠️ low confidence — tahmin" etiketle.
11. Bağlamla çelişen sonuçları "⚠️ Bağlam uyuşmazlığı" ile işaretle.
12. Email bulduğunda MUTLAKA check_email_registrations ve check_breaches ile pivot yap. Bu en değerli adımdır.
13. GÜVEN SEVİYESİ KURALI: search_web (web araması) ile bulunan bilgiler asla ✅ Doğrulandı veya 🔵 Yüksek olarak raporlanmaz. Web araması bulgular DAIMA ⚠️ Orta veya 🔻 Düşük seviyededir. Yalnızca API çağrıları (github_api, holehe, hibp) ile doğrulanan bilgiler yüksek/doğrulanmış olabilir.

Kullanım kuralları:
1. Araçları YALNIZCA kullanıcı araştırma istediğinde kullan.
2. Genel sorulara araç KULLANMA.
3. Kapsamlı araştırmada birden fazla aracı sırayla kullan.
4. Sonuçlar otomatik olarak Neo4j'ye yazılır.
5. Sonuçları Türkçe, kısa, madde madde özetle. Güven seviyesini belirt.

CRITICAL INSTRUCTION: Asla sessiz kalma veya boş mesaj dönme. Araçlar çalıştıktan ve verileri topladıktan sonra MUTLAKA elde ettiğin tüm bulguları ve graf bağlantılarını (Markdown tablo/liste formatında) kullanıcıya sun. Eğer bir araç hata verdiyse veya sonuç bulamadıysa bunu da raporda belirt.`,
  },
]

const MAX_TOOL_CALLS_PER_TURN = 30

async function chat(userMessage: string): Promise<void> {
  history.push({ role: 'user', content: userMessage })
  let toolCallCount = 0

  // Agent loop — araç çağrısı bitene kadar devam et
  while (true) {
    // Çok fazla araç çağrısı → modeli özet yazmaya zorla
    const toolChoice: 'auto' | 'none' = toolCallCount >= MAX_TOOL_CALLS_PER_TURN ? 'none' : 'auto'
    if (toolChoice === 'none') {
      console.log(chalk.yellow(`\n   ⚠️  Maksimum araç çağrısı (${MAX_TOOL_CALLS_PER_TURN}) aşıldı, özet isteniyor...`))
    }

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: sanitizeHistoryForProvider(history),
      tools,
      tool_choice: toolChoice,
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
      toolCallCount++
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

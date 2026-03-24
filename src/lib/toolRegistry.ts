import { addCustomNodeTool, deleteCustomNodeTool, addCustomRelationshipTool } from '../tools/customGraphTool.js';
import 'dotenv/config'
import OpenAI from 'openai'
import * as readline from 'readline'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import chalk from 'chalk'
import { githubOsint } from '../tools/githubTool.js'
import { writeOsintToGraph, getConnections, getGraphStats, getGraphNodeCountsByLabel, listGraphNodes, pruneMisclassifiedFullNameUsernames, findLinkedIdentifiers, writeEmailRegistrations, writeBreachData, writeScrapeData, writeFollowingConnections, mergeRelation, closeNeo4j, clearGraph, deleteGraphNodeAndRelations } from './neo4j.js'
import { normalizeAssistantMessage, normalizeToolContent, sanitizeHistoryForProvider } from './chatHistory.js'
import { isLikelyUsernameCandidate } from './osintHeuristics.js'
import { extractMetadataFromUrl, extractMetadataFromFile, formatMetadata } from '../tools/metadataTool.js'
import { parseGithubGpgKey, parseGpgKeyFile, formatGpgResult } from '../tools/gpgParserTool.js'
import { waybackSearch, formatWaybackResult } from '../tools/waybackTool.js'
import { webFetch } from '../tools/webFetchTool.js'
import { checkEmailRegistrations, formatHoleheResult } from '../tools/holeheTool.js'
import { checkBreaches, formatBreachResult } from '../tools/breachCheckTool.js'
import { searchWeb, formatSearchResult } from '../tools/searchTool.js'
import { scrapeProfile, formatScrapeResult } from '../tools/scrapeTool.js'
import { verifySherlockProfiles, formatVerificationResults } from '../tools/profileVerifier.js'
import { fetchAndHashImage } from '../tools/imageHasher.js'
import { fetchNitterProfile, formatNitterResult } from '../tools/nitterTool.js'
import { findUnexploredPivots, formatUnexploredPivots } from './pivotAnalyzer.js'
import { compareImages } from '../tools/phashCompareTool.js';
import { writeFactCheckToGraph } from './neo4jFactCheck.js';
import { searchReverseImage, formatReverseImageResult } from '../tools/reverseImageTool.js';
import { searchPerson, formatPersonSearchResult } from '../tools/personSearchTool.js'
import { searchAcademicPapers, formatAcademicResult, writeAcademicPapersToGraph, searchAuthorPapers, formatAuthorResult } from '../tools/academicSearchTool.js'
import os from 'os'
import { writeFile, unlink } from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'
// ─── Tool Definitions ────────────────────────────────────────────────
export const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_custom_node",
      description: "Neo4j graf veritabanına özel (custom) bir düğüm (node) ekler. Standart nesneler (Username, Email vb.) dışındaki bulguları (ör: CryptoWallet, Malware) kaydetmek için kullanılır. Etiketleri CamelCase kullanın.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Düğümün tipi (Örn: CryptoWallet, Malware)" },
          properties: { 
            type: "object", 
            additionalProperties: { type: "string" },
            description: "Düğüm özellikleri. Key-value (string:string) formatında."
          }
        },
        required: ["label", "properties"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_custom_node",
      description: "Graph veritabanından hatalı eklenmiş bir düğümü ID veya özellik bazlı olarak siler.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Silinecek düğümün etiketi. (Örn: CryptoWallet)" },
          matchKey: { type: "string", description: "Arama anahtarı. (Örn: address)" },
          matchValue: { type: "string", description: "Arama yapılacak değer. (Örn: 0x123...)" }
        },
        required: ["label", "matchKey", "matchValue"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_custom_relationship",
      description: "Graf veritabanındaki iki nesne arasına özel bir ilişki (Örn: OWNS, DISTRIBUTES) ekler.",
      parameters: {
        type: "object",
        properties: {
          sourceLabel: { type: "string", description: "Kaynak etiket (Örn: Username)" },
          sourceKey: { type: "string", description: "Kaynak arama anahtarı (Örn: value)" },
          sourceValue: { type: "string", description: "Kaynak değer (Örn: wgodbarrelv4)" },
          targetLabel: { type: "string", description: "Hedef etiket (Örn: Malware)" },
          targetKey: { type: "string", description: "Hedef arama anahtarı (Örn: name)" },
          targetValue: { type: "string", description: "Hedef arama değeri (Örn: Vidar)" },
          relationshipType: { type: "string", description: "İlişki tipi BÜYÜK HARFLERLE (Örn: DISTRIBUTES)" }
        },
        required: ["sourceLabel", "sourceKey", "sourceValue", "targetLabel", "targetKey", "targetValue", "relationshipType"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fact_check_to_graph",
      description: "Şüpheli bir iddia (Claim) ile ilgili yapılan Doğruluk Kontrolü (Fact-Check) sonucunu Neo4j veritabanına kaydeder. Kaynak, görsel ve iddiayı birbirine bağlar.",
      parameters: {
        type: "object",
        properties: {
          claimId: { type: "string" },
          claimText: { type: "string" },
          source: { type: "string" },
          claimDate: { type: "string" },
          verdict: { type: "string", enum: ["YALAN", "DOĞRU", "ŞÜPHELİ"] },
          truthExplanation: { type: "string" },
          imageUrl: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["claimId", "claimText", "source", "claimDate", "verdict", "truthExplanation"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reverse_image_search",
      description: "Bir görselin internette ilk nerede ve ne zaman paylaşıldığını (Google Lens / SerpApi ile) bulur. Yalan haber veya yanlış bağlamdaki fotoğrafların gerçek kaynağını (eski deprem vb.) göstermek için kullanılır.",
      parameters: {
        type: "object",
        properties: {
          imageUrl: { type: "string", description: "Aranacak görselin tam URL'si" }
        },
        required: ["imageUrl"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "compare_images_phash",
      description: "İki görselin perceptual hash (pHash) değerlerini karşılaştırarak kriptografik olarak benzerliklerini ölçer. Bir haberdeki görselin başka bağlamdaki bir fotoğrafla aynı olup olmadığını analiz eder.",
      parameters: {
        type: "object",
        properties: {
          url1: { type: "string", description: "Birinci görselin tam URL'si" },
          url2: { type: "string", description: "Karşılaştırma yapılacak ikinci görselin tam URL'si" }
        },
        required: ["url1", "url2"]
      }
    }
  },
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
      name: 'search_academic_papers',
      description: 'arXiv üzerinden güncel akademik makaleleri arar. "LLM RL eğitimi", "transformer mimarisi" gibi araştırma konuları için kullan. Sonuçları otomatik olarak Neo4j graf veritabanına kaydeder (Paper→Author, Paper→Topic).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Araştırma sorgusu (Örn: "reinforcement learning large language models 2024")' },
          maxResults: { type: 'string', description: 'Kaç makale getirilsin? (varsayılan: 10, max: 50)' },
          sortBy: { type: 'string', description: '"submittedDate" (en yeni) veya "relevance" (en alakalı). Varsayılan: submittedDate.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_researcher_papers',
      description: 'Semantic Scholar Author API üzerinden bir araştırmacının tüm yayınlarını, h-index değerini ve atıf sayılarını getirir. Kişi adı + kurum kombinasyonuyla çalışır. arXiv\'de olmayan Türk akademisyenler için de idealdir.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Araştırmacının adı soyadı (Örn: "Bihter Daş" veya "Bihter Das")' },
          affiliation: { type: 'string', description: 'Kurum adı — doğru kişiyi seçmek için kullanılır (Örn: "Fırat Üniversitesi" veya "Firat University")' },
        },
        required: ['name'],
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
        'Brave Search (öncelikli) veya Tavily AI (fallback) ile web araması yapar. İsim, email, dork (site:example.com), kurum araması vb. için kullan. BULUNAN SONUÇLARI DOĞRUDAN KABUL ETME: Sonuçların hedefin bilinen diğer tanımlayıcılarıyla (email, username vb.) örtüşüp örtüşmediğini çapraz kontrol et.',
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
      platforms: result.socialAccounts?.map(acc => ({
        platform: acc.provider,
        url: acc.url
      })),
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

  export async function executeTool(
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
        else if (name === 'fact_check_to_graph') {
      console.log(chalk.cyan(`\n   🧠 Fact Check Kaydı (Neo4j): `) + chalk.yellow.bold(args.claimId))
      try {
        await writeFactCheckToGraph({
           claimId: args.claimId,
           claimText: args.claimText,
           source: args.source,
           claimDate: args.claimDate,
           verdict: args.verdict as "YALAN" | "DOĞRU" | "ŞÜPHELİ",
           truthExplanation: args.truthExplanation,
           imageUrl: args.imageUrl,
           tags: args.tags ? JSON.parse(args.tags) : []
        });
        result = `✅ Fact-Check sonucu Neo4j Veri Grafiğine başarıyla kaydedildi! (Claim ID: ${args.claimId})`;
      } catch (e: any) {
        result = `❌ Graph kaydetme hatası: ${e.message}`;
      }
    }
    else if (name === 'reverse_image_search') {
      console.log(chalk.cyan(`\n   🖼️ Reverse Image Search (SerpApi): `) + chalk.yellow.bold(args.imageUrl))
      const res = await searchReverseImage(args.imageUrl)
      result = formatReverseImageResult(res)
    }
    else if (name === 'compare_images_phash') {
      console.log(chalk.cyan(`\n   🧩 pHash Karşılaştırması: `) + chalk.yellow.bold(args.url1 + ' vs ' + args.url2))
      result = await compareImages(args.url1, args.url2)
    }
    else if (name === 'add_custom_node') {
      console.log(chalk.cyan(`\n   ➕ Özel düğüm ekleniyor: `) + chalk.yellow.bold(args.label));
      const res = await addCustomNodeTool({ label: args.label, properties: args.properties as any });
      result = JSON.stringify(res);
    }
    else if (name === 'delete_custom_node') {
      console.log(chalk.cyan(`\n   ➖ Özel düğüm siliniyor: `) + chalk.yellow.bold(`${args.label} (${args.matchKey}: ${args.matchValue})`));
      const res = await deleteCustomNodeTool({ label: args.label, matchKey: args.matchKey, matchValue: args.matchValue });
      result = JSON.stringify(res);
    }
    else if (name === 'add_custom_relationship') {
      console.log(chalk.cyan(`\n   🔗 Özel ilişki ekleniyor: `) + chalk.yellow.bold(`${args.sourceLabel} -[${args.relationshipType}]-> ${args.targetLabel}`));
      const res = await addCustomRelationshipTool({
        sourceLabel: args.sourceLabel,
        sourceKey: args.sourceKey,
        sourceValue: args.sourceValue,
        targetLabel: args.targetLabel,
        targetKey: args.targetKey,
        targetValue: args.targetValue,
        relationshipType: args.relationshipType
      });
      result = JSON.stringify(res);
    }
    else if (name === 'search_researcher_papers') {
      console.log(chalk.cyan(`
   👤 Araştırmacı Arama (Semantic Scholar): `) + chalk.yellow.bold(args.name))
      const authorResult = await searchAuthorPapers(args.name, args.affiliation)
      result = formatAuthorResult(authorResult)
    }
    else if (name === 'search_academic_papers') {
      const maxResults = parseInt(args.maxResults ?? '10') || 10
      const sortBy = (args.sortBy as 'relevance' | 'submittedDate' | 'lastUpdatedDate') ?? 'submittedDate'
      console.log(chalk.cyan(`\n   🔬 Akademik Araştırma (arXiv): `) + chalk.yellow.bold(args.query))
      const searchResult = await searchAcademicPapers(args.query, maxResults, sortBy)
      result = formatAcademicResult(searchResult)
      // Graf'a yaz
      try {
        const { getDriver } = await import('./neo4j.js')
        const driver = getDriver()
        const neo4jWrite = async (query: string, params: Record<string, unknown>) => {
          const session = driver.session()
          try { await session.run(query, params) } finally { await session.close() }
        }
        const stats = await writeAcademicPapersToGraph(searchResult.papers, args.query, neo4jWrite)
        console.log(chalk.blue(`   💾 Grafa yazıldı: ${stats.papersCreated} makale, ${stats.authorsLinked} yazar bağlantısı`))
        result += `\n\n💾 Neo4j Graf: ${stats.papersCreated} Paper node, ${stats.authorsLinked} AUTHORED_BY ilişkisi oluşturuldu.`
      } catch {
        console.log(chalk.gray(`   ⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)`))
      }
    }
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
    // Akademik URL'ler için deep-read modu: 50K — diğerleri için 8K
    const isDeepReadUrl = /ar5iv\.|arxiv\.org\/(abs|pdf)|doi\.org|dergipark\.org\.tr|ncbi\.nlm\.nih\.gov|pubmed\.|semanticscholar\.org/.test(url)
    const limit = isDeepReadUrl ? 50000 : 8000
    if (isDeepReadUrl) console.log(chalk.blue(`   📖 Deep-read modu aktif (${limit.toLocaleString()} char)`))
    return result.textContent.slice(0, limit)
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


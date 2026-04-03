import { addCustomNodeTool, deleteCustomNodeTool, addCustomRelationshipTool } from '../tools/customGraphTool.js';
import 'dotenv/config'
import OpenAI from 'openai'
import * as readline from 'readline'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { logger } from './logger.js'
import { githubOsint } from '../tools/githubTool.js'
import { writeOsintToGraph, getConnections, getGraphStats, getGraphNodeCountsByLabel, listGraphNodes, pruneMisclassifiedFullNameUsernames, findLinkedIdentifiers, writeEmailRegistrations, writeBreachData, writeFollowingConnections, mergeRelation, closeNeo4j, clearGraph, deleteGraphNodeAndRelations, writeFinding, writeCybersecurityNode, linkEntities, markNodeMlLabel, batchWriteFindings } from './neo4j.js'
import { normalizeAssistantMessage, normalizeToolContent, sanitizeHistoryForProvider } from './chatHistory.js'
import { isLikelyUsernameCandidate } from './osintHeuristics.js'
import { extractMetadataFromUrl, extractMetadataFromFile, formatMetadata } from '../tools/metadataTool.js'
import { parseGithubGpgKey, parseGpgKeyFile, formatGpgResult } from '../tools/gpgParserTool.js'
import { waybackSearch, formatWaybackResult } from '../tools/waybackTool.js'
import { webFetch } from '../tools/webFetchTool.js'
import { checkEmailRegistrations, formatHoleheResult } from '../tools/holeheTool.js'
import { checkBreaches, formatBreachResult } from '../tools/breachCheckTool.js'
import { searchWeb, searchWebMulti, formatSearchResult } from '../tools/searchTool.js'
import { scrapeProfile, formatScrapeResult } from '../tools/scrapeTool.js'
import { formatSourceBadge } from './sourceCredibility.js'
import { verifyClaim, formatVerifyResult } from '../tools/verifyClaimTool.js'
import { verifySherlockProfiles, formatVerificationResults } from '../tools/profileVerifier.js'
import { fetchAndHashImage } from '../tools/imageHasher.js'
import { fetchNitterProfile, formatNitterResult } from '../tools/nitterTool.js'
import { findUnexploredPivots, formatUnexploredPivots } from './pivotAnalyzer.js'
import { compareImages } from '../tools/phashCompareTool.js';
import { writeFactCheckToGraph } from './neo4jFactCheck.js';
import { searchReverseImage, formatReverseImageResult } from '../tools/reverseImageTool.js';
import { searchPerson, formatPersonSearchResult } from '../tools/personSearchTool.js'
import { searchAcademicPapers, formatAcademicResult, writeAcademicPapersToGraph, searchAuthorPapers, formatAuthorResult } from '../tools/academicSearchTool.js'
import type { AcademicSearchResult } from '../tools/academicSearchTool.js'
import { generateOsintReport } from '../tools/reportTool.js'
import { checkPlagiarism } from '../tools/plagiarismTool.js'
import { analyzeGpxFiles, formatGpxResult } from '../tools/gpxAnalyzerTool.js'
import { obsidianWrite, obsidianAppend, obsidianRead, obsidianDailyLog, obsidianList, obsidianSearch, obsidianWriteProfile } from '../tools/obsidianTool.js'
import os from 'os'
import { writeFile, unlink } from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'

// ─── Report Content Buffer ────────────────────────────────────────────────────
// Supervisor sub-agent raporlarını buraya yazar. generate_report additionalFindings
// yoksa bu buffer'ı kullanır (model JSON'a encode edemiyorsa fallback).
let _reportContentBuffer: string = '';
export function setReportContentBuffer(content: string): void { _reportContentBuffer = content; }
export function clearReportContentBuffer(): void { _reportContentBuffer = ''; }

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
          verdict: { type: "string", enum: ["FALSE", "TRUE", "UNVERIFIED"] },
          truthExplanation: { type: "string" },
          imageUrl: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["claimId", "claimText", "source", "claimDate", "verdict", "truthExplanation"]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_finding',
      description: 'Araştırma sırasında keşfedilen önemli bir bulguyu Neo4j grafına yazar. Sadece doğrulanmış veya yüksek güvenilirlikli bulgular için kullan — spekülatif sonuçları kaydetme.',
      parameters: {
        type: 'object',
        properties: {
          subject_label: { type: 'string', description: 'Özne node tipi (Username, Email, Person, Website vb.)' },
          subject_value: { type: 'string', description: 'Özne node değeri' },
          finding_type: {
            type: 'string',
            enum: ['identity', 'location', 'affiliation', 'alias', 'association'],
            description: 'Bulgu kategorisi'
          },
          target_label: { type: 'string', description: 'Hedef node tipi' },
          target_value: { type: 'string', description: 'Hedef node değeri' },
          relation: { type: 'string', description: 'İlişki tipi (USES_EMAIL, LOCATED_IN, WORKS_AT, ALIAS_OF, ASSOCIATED_WITH vb.)' },
          confidence: {
            type: 'string',
            enum: ['verified', 'high', 'medium', 'low'],
            description: 'Güvenilirlik seviyesi'
          },
          evidence: { type: 'string', description: 'Bulgunun kanıtı (kaynak URL veya açıklama)' },
        },
        required: ['subject_label', 'subject_value', 'finding_type', 'target_label', 'target_value', 'relation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_save_findings',
      description: 'Birden fazla OSINT bulgusunu tek seferde Neo4j grafına toplu yazar. save_finding yerine 5+ bulgu varsa bunu kullan — çok daha verimli (tek API call). Maksimum 30 bulgu. Her bulgu için subject→relation→target yapısı kullanılır.',
      parameters: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            description: 'Bulgu listesi. Her eleman bir save_finding çağrısına denk gelir.',
            items: {
              type: 'object',
              properties: {
                subject_label: { type: 'string', description: 'Özne node tipi (Username, Email, Person, Website vb.)' },
                subject_value: { type: 'string', description: 'Özne node değeri' },
                target_label: { type: 'string', description: 'Hedef node tipi' },
                target_value: { type: 'string', description: 'Hedef node değeri' },
                relation: { type: 'string', description: 'İlişki tipi (USES_EMAIL, LOCATED_IN, WORKS_AT vb.)' },
                confidence: { type: 'string', enum: ['verified', 'high', 'medium', 'low'], description: 'Güvenilirlik seviyesi' },
                evidence: { type: 'string', description: 'Kısa kanıt notu (max 200 karakter)' },
              },
              required: ['subject_label', 'subject_value', 'target_label', 'target_value', 'relation'],
            },
            maxItems: 30,
          },
        },
        required: ['findings'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_ioc',
      description: 'Siber tehdit göstergesi (IOC), tehdit aktörü veya araştırma kaynağını Neo4j grafına yazar. ThreatActor, C2Server, Malware, Campaign, IOC, PhishingDomain, Tool, Framework tipleri desteklenir. UYARI: Akademik framework/tool (BloodHound, OpenCTI, THREATKG vb.) için Tool veya Framework kullan — Campaign DEĞİL.',
      parameters: {
        type: 'object',
        properties: {
          node_type: {
            type: 'string',
            description: 'Node tipi: ThreatActor | C2Server | Malware | Campaign | IOC | PhishingDomain | Tool | Framework'
          },
          value: { type: 'string', description: 'Node değeri (domain, IP, hash, isim vb.)' },
          properties: {
            type: 'object',
            description: 'Ek özellikler (category, tlp, description, firstSeen vb.) — anahtar-değer çifti',
            additionalProperties: { type: 'string' }
          },
          linked_label: { type: 'string', description: 'Bağlanacak mevcut node tipi (opsiyonel)' },
          linked_value: { type: 'string', description: 'Bağlanacak mevcut node değeri (opsiyonel)' },
          linked_relation: { type: 'string', description: 'İlişki tipi (opsiyonel, ör: USES_C2, PART_OF_CAMPAIGN)' },
        },
        required: ['node_type', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_entities',
      description: 'Grafta zaten var olan (veya oluşturulacak) iki node\'u ilişkilendirir. SAME_AS, ALIAS_OF, ASSOCIATED_WITH gibi genel ilişkiler için kullan.',
      parameters: {
        type: 'object',
        properties: {
          from_label: { type: 'string', description: 'Kaynak node tipi' },
          from_value: { type: 'string', description: 'Kaynak node değeri' },
          to_label: { type: 'string', description: 'Hedef node tipi' },
          to_value: { type: 'string', description: 'Hedef node değeri' },
          relation: { type: 'string', description: 'İlişki tipi (SAME_AS, ALIAS_OF, ASSOCIATED_WITH vb.)' },
          evidence: { type: 'string', description: 'İlişkinin kanıtı (opsiyonel)' },
          confidence: {
            type: 'string',
            enum: ['verified', 'high', 'medium', 'low'],
            description: 'Güvenilirlik seviyesi (opsiyonel)'
          },
        },
        required: ['from_label', 'from_value', 'to_label', 'to_value', 'relation'],
      },
    },
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
      description: 'Silinmesi gereken hatalı, yanlış eklenmiş veya hedefle uyuşmayan graf düğümünü ve onun ilişkilerini KALICI OLARAK siler. ⚠️ GNN eğitimi için negatif örnek korumak istiyorsan bunun yerine mark_false_positive kullan.',
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
      name: 'mark_false_positive',
      description: 'Bir graf node\'unu silmeden GNN eğitimi için etiketler (soft label). false_positive → negatif eğitim örneği olarak korunur; verified → onaylanmış pozitif örnek; uncertain → eğitim setinden dışla. remove_false_positive\'in aksine node silinmez.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Node tipi (örn. Username, Email, Profile)' },
          value: { type: 'string', description: 'Node değeri' },
          ml_label: {
            type: 'string',
            enum: ['false_positive', 'verified', 'uncertain'],
            description: 'false_positive: bu hesap hedefle ilgisiz; verified: doğrulanmış hedef; uncertain: belirsiz'
          },
          reason: { type: 'string', description: 'Etiketleme gerekçesi (opsiyonel, ör: "ZTE geliştiricisi, Linus değil")' },
        },
        required: ['label', 'value', 'ml_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'SearXNG (self-hosted, öncelikli), Brave Search veya Tavily AI (fallback) ile web araması yapar. İsim, email, dork (site:example.com), kurum araması vb. için kullan. BULUNAN SONUÇLARI DOĞRUDAN KABUL ETME: Sonuçların hedefin bilinen diğer tanımlayıcılarıyla (email, username vb.) örtüşüp örtüşmediğini çapraz kontrol et.',
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
      name: 'search_web_multi',
      description:
        'Aynı konuyu farklı açılardan aramak için birden fazla sorguyu PARALEL çalıştırır ve URL bazlı tekilleştirilmiş sonuçlar döndürür. Maksimum 3 sorgu (virgülle ayrılmış). Örnek: "gamma app free plan, gamma presentation no signup, gamma.app pricing 2025"',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'string',
            description: 'Virgülle ayrılmış arama sorguları (maks. 3). Örn: "ücretsiz AI sunum, AI slides kayıt olmadan, gamma app bedava"',
          },
        },
        required: ['queries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_claim',
      description:
        'Bir iddianın ("ücretsiz", "kayıt gerektirmez", "Turkey based" vb.) birden fazla bağımsız kaynakla doğrulanıp doğrulanamadığını kontrol eder. Vendor sitesi iddiayı açıkça yazmıyorsa bu CEVAPSIZsaklanmaz — community kaynaklarında arar. Güven: high=2+ bağımsız kaynak, medium=1, low=yalnızca vendor, inconclusive=kanıt yok.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'İddianın test edileceği ana URL (ürün/servis sitesi)' },
          claim: { type: 'string', description: 'Doğrulanacak iddia metni (Örn: "ücretsiz kullanıma sahip, kredi kartı gerektirmez")' },
        },
        required: ['url', 'claim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sherlock',
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
        'Scrape a webpage using Firecrawl (self-hosted veya cloud). Works well on: GitHub, personal blogs, forums, CTF writeup sites, portfolio pages. Returns page as Markdown and auto-extracts emails, crypto wallets (BTC/ETH), Telegram links, and external URLs. NOTE: Twitter/X and Reddit are NOT supported by Firecrawl — use web_fetch for those (will auto-fallback to Puppeteer/Scrapling).',
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
  {
    type: 'function',
    function: {
      name: 'check_plagiarism',
      description:
        'Akademik metin, makale bölümü veya abstract üzerinde intihal/şatekarlık analizi ve/veya özgünlük değerlendirmesi yapar.\n\nmod seçenekleri:\n- "plagiarism" (varsayılan): Metin kopyası tespiti — Jaccard benzerlik, CrossRef/Semantic Scholar karşılaştırması, web exact-phrase arama.\n- "originality": Özgünlük değerlendirmesi — zaman önceliği (prior art), kavramsal yenilik (TF-IDF), dergi güvenilirliği (DOAJ/predatory kontrolü), atıf pattern analizi.\n- "full": İntihal + özgünlük birlikte.\n\nBulgular Neo4j\'e (:Publication)-[:SIMILAR_TO {score}]->(:Publication) olarak kaydedilir. "Bu makale intihal mi?", "Bu makale özgün mü?", "Bu dergi güvenilir mi?", "Bu yazar self-plagiarism yapıyor mu?" sorularında kullan.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'İncelenecek metin (abstract, makale bölümü veya tam metin)' },
          mode: { type: 'string', enum: ['plagiarism', 'originality', 'full'], description: 'Analiz modu. Varsayılan: "plagiarism". Özgünlük için "originality", her ikisi için "full".' },
          author: { type: 'string', description: 'Yazar adı soyadı — self-plagiarism tespiti için (opsiyonel)' },
          title: { type: 'string', description: 'Makalenin başlığı — CrossRef metadata araması için (opsiyonel)' },
          doi: { type: 'string', description: 'Makalenin DOI\'si — metadata araması için (opsiyonel, Örn: "10.1016/j.jss.2023.111234")' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_report',
      description:
        'Araştırma tamamlandıktan sonra tüm bulguları yapılandırılmış Markdown raporu olarak dosyaya kaydeder.\n\n🟣 OBSİDİAN SYNC: Bu araç her çalıştığında rapor OTOMATIK OLARAK Obsidian vault\'una kopyalanır:\n→ /home/berkayhsrt/Agent_Knowladges/OSINT/OSINT-Agent/04 - Araştırma Raporları/\nBu kod seviyesinde aktif bir entegrasyondur (syncToObsidian). Kullanıcı Obsidian vault\'unu açtığında rapor hazır olarak bulunur.\n\nreportType seçenekleri:\n- "osint" (varsayılan): Kişi/username araştırması — Neo4j grafından profil/email/sızıntı/platform verisini çeker.\n- "academic": Makale/konu araştırması — AcademicAgent raporu bittikten sonra kullan.\n- "factcheck": Haber/görsel doğrulama — MediaAgent raporu bittikten sonra kullan.\n\nKullanıcı "rapor oluştur" / "rapor ver" / "kaydet" dediğinde ya da bir alt-ajan tamamlandığında HEMEN çağır.\n⚠️ SADECE subject ve reportType gönder — içerik dahili buffer\'dan otomatik okunur, additionalFindings GÖNDERME.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Araştırılan konu, kişi veya entity (username, makale konusu, iddia metni vb.)' },
          reportType: { type: 'string', enum: ['osint', 'academic', 'factcheck'], description: 'Rapor tipi. Makale/akademik çalışma için "academic", görsel/haber doğrulama için "factcheck", kişi OSINT için "osint" (varsayılan).' },
          title: { type: 'string', description: 'Opsiyonel rapor başlığı' },
        },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_gpx',
      description:
        'Analyze GPS track files (GPX format) for OSINT investigations. Parses tracks, calculates geographic center, identifies repeated locations (hotspots), and reverse-geocodes coordinates to identify landmarks, cities, and addresses. Use for fitness tracker data (Strava, Garmin), GPS route forensics, and location pattern analysis. Returns: track names, timestamps, coordinate center, hotspot locations with addresses, and landmark identification.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description: 'Comma-separated list of GPX file paths to analyze (absolute or relative paths)',
          },
        },
        required: ['files'],
      },
    },
  },
  // ─── Obsidian Vault Araçları ─────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'obsidian_write',
      description: 'Obsidian vault\'unda bir not oluştur veya güncelle. Agent\'ın kendi bilgi tabanına kayıt açar. Vault kökü: Agent_Knowladges/OSINT/OSINT-Agent/. Örnek yollar: "07 - Notlar/kullanici-tercihleri.md", "08 - Profiller/torvalds.md"',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Vault\'a göre göreli dosya yolu (örn: "07 - Notlar/önemli-bulgular.md")' },
          content: { type: 'string', description: 'Notun tam Markdown içeriği' },
          overwrite: { type: 'boolean', description: 'true → üzerine yaz (varsayılan), false → sadece yoksa oluştur' },
        },
        required: ['note_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_append',
      description: 'Obsidian vault\'undaki mevcut bir notun sonuna içerik ekle. Günlük defteri güncellemeleri, araştırma notları ve önemli bulgular için kullan.',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Vault\'a göre göreli dosya yolu' },
          content: { type: 'string', description: 'Eklenecek Markdown içerik' },
        },
        required: ['note_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_read',
      description: 'Obsidian vault\'undaki bir notu oku. Önceki notlar, kullanıcı tercihleri veya araştırma bağlamını hatırlamak için kullan.',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Vault\'a göre göreli dosya yolu' },
        },
        required: ['note_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_daily',
      description: 'Bugünün günlük defterine kayıt ekle (06 - Günlük/YYYY-MM-DD.md). Önemli bulguları, kullanıcı tercihlerini, gözlemleri ve hatırlatmaları buraya yaz. Dosya yoksa otomatik oluşturur.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'Günlüğe eklenecek metin (Markdown)' },
          tag: { type: 'string', description: 'Opsiyonel etiket: "araştırma" | "kullanıcı-tercihi" | "gözlem" | "hatırlatma"' },
        },
        required: ['entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_write_profile',
      description: 'Araştırılan kişi için yapılandırılmış profil sayfası oluştur (08 - Profiller/[username].md). Frontmatter metadata + Markdown özet. Kişi araştırması tamamlandığında veya önemli bulgular elde edildiğinde kullan. Obsidian wikilink [[username]] ile diğer profillere bağlantı kur.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Profil sahibi username veya identifier' },
          content: { type: 'string', description: 'Profil içeriği (Markdown). Sections: ## Kimlik, ## Platformlar, ## Bulgular, vs.' },
          real_name: { type: 'string', description: 'Gerçek isim (biliniyorsa)' },
          emails: { type: 'string', description: 'Email adresleri (virgülle ayrılmış)' },
          platforms: { type: 'string', description: 'Bulunduğu platformlar (virgülle ayrılmış)' },
          confidence: { type: 'string', description: 'Güvenilirlik: verified | high | medium | low', enum: ['verified', 'high', 'medium', 'low'] },
        },
        required: ['username', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_list',
      description: 'Obsidian vault\'undaki bir dizinin içeriğini listele. Mevcut notları keşfetmek veya vault yapısını görmek için kullan.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Listelenecek dizin (göreli yol). Boş bırakılırsa vault kökü listelenir.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_search',
      description: 'Obsidian vault\'unda tam metin arama yap. Tüm .md dosyalarını tarar, eşleşen dosyaları ve bağlam satırlarını döndürür. Önceki araştırmaları, profil notlarını veya kullanıcı tercihlerini bulmak için kullan. Örnek: "torvalds", "GitHub", "kullanıcı-tercihi"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Aranacak anahtar kelime veya ifade (case-insensitive)' },
          limit: { type: 'number', description: 'Maksimum sonuç sayısı (varsayılan: 10)' },
        },
        required: ['query'],
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
    logger.info('TOOL', `🌐 Sherlock ${username} için taranıyor...`)
    logger.info('TOOL', '(Bu işlem 1-2 dk sürebilir)')
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
      logger.info('TOOL', `✅ Sherlock: ${lines.length} platform bulundu`)

      // Grafa yaz
      try {
        const platforms = lines.map((l) => {
          const urlMatch = l.match(/https?:\/\/[^\s]+/)
          const nameMatch = l.match(/\[\+\]\s+([^:]+):/)
          return { platform: nameMatch?.[1]?.trim() || 'unknown', url: urlMatch?.[0] || '' }
        }).filter(p => p.url)
        const stats = await writeOsintToGraph(username, { platforms }, 'sherlock')
        logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
      } catch (e) {
        logger.warn('GRAPH', '⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)')
      }

      resolve(out || 'No results found.')
    })
    proc.on('error', (e) => resolve(`Sherlock error: ${e.message}`))
  })
}

async function runGithubOsint(username: string, deep = false): Promise<string> {
  logger.info('TOOL', `🐙 GitHub API OSINT: ${username}${deep ? ' (DEEP MOD)' : ''}...`)
  const result = await githubOsint(username, deep)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return result.error
  }
  logger.info('TOOL', `✅ GitHub OSINT: ${result.emails.length} email bulundu`)

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
    logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
  } catch {
    logger.warn('GRAPH', '⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)')
  }

  // Deep mod: following bağlantılarını grafa yaz
  if (result.following.length > 0) {
    const realPeople = result.following.filter(f => !f.skipped)
    logger.info('TOOL', `🔍 Following analizi: ${realPeople.length} gerçek kişi (${result.following.length - realPeople.length} atlandı)`)
    try {
      const stats = await writeFollowingConnections(username, result.following, 'github_api')
      logger.info('GRAPH', `💾 Following grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Following graf yazma atlandı')
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
      'check_breaches', 'search_web', 'search_web_multi', 'scrape_profile', 'verify_profiles',
      'nitter_profile', 'search_person', 'fact_check_to_graph', 'analyze_gpx', 'verify_claim'
    ]);

    const cacheKey = `${name}:${JSON.stringify(args)}`;
    
    if (cacheableTools.has(name) && toolCache.has(cacheKey)) {
      logger.debug('TOOL', `⚡ [Cache Hit] ${name} (${JSON.stringify(args)}) hafızadan getirildi. Tekrar çalıştırılmadı.`);
      return `[⚡ ZATEN OKUNDU — Bu araç daha önce aynı parametrelerle çağrıldı. Aşağıdaki sonuç hafızadan geldi, tekrar çağırman gerekmez — bu veriyi kullanarak ilerle.]\n\n` + toolCache.get(cacheKey)!;
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
    else if (name === 'search_web_multi') result = await runSearchWebMulti(args.queries)
    else if (name === 'scrape_profile') result = await runScrapeProfile(args.url)
    else if (name === 'verify_profiles') result = await runVerifyProfiles(args.username)
    else if (name === 'verify_claim') result = await runVerifyClaim(args.url, args.claim)
    else if (name === 'nitter_profile') result = await runNitterProfile(args.username)
    else if (name === 'unexplored_pivots') result = await runUnexploredPivots(args.username)
    else if (name === 'search_person') result = await runSearchPerson(args.name, args.context)
    else if (name === 'clear_graph') result = await runClearGraph(args.confirm === 'true' || (args.confirm as unknown) === true)
    else if (name === 'remove_false_positive') result = await runRemoveFalsePositive(args.label, args.value)
    else if (name === 'mark_false_positive') {
      const mlLabel = args.ml_label as 'false_positive' | 'verified' | 'uncertain'
      logger.info('TOOL', `🏷️  ML etiket: ${args.label}:${args.value} → ${mlLabel}`)
      try {
        const updated = await markNodeMlLabel(args.label, args.value, mlLabel, args.reason)
        if (updated) {
          result = `✅ Node etiketlendi: ${args.label}:${args.value} → mlLabel="${mlLabel}"${args.reason ? ` (${args.reason})` : ''}. Node graf'ta korunuyor — GNN eğitiminde ${mlLabel === 'false_positive' ? 'negatif örnek' : mlLabel === 'verified' ? 'pozitif örnek' : 'dışlanmış'} olarak kullanılacak.`
        } else {
          result = `⚠️ Node bulunamadı: ${args.label}:${args.value} — graf'ta mevcut değil.`
        }
      } catch (e: any) {
        result = `❌ Etiketleme hatası: ${e.message}`
      }
    }
        else if (name === 'fact_check_to_graph') {
      logger.info('TOOL', `🧠 Fact Check Kaydı (Neo4j): ${args.claimId}`)
      try {
        await writeFactCheckToGraph({
           claimId: args.claimId,
           claimText: args.claimText,
           source: args.source,
           claimDate: args.claimDate,
           verdict: args.verdict as 'FALSE' | 'TRUE' | 'UNVERIFIED',
           truthExplanation: args.truthExplanation,
           imageUrl: args.imageUrl,
           tags: args.tags ? JSON.parse(args.tags) : []
        });
        result = `✅ Fact-Check sonucu Neo4j Veri Grafiğine başarıyla kaydedildi! (Claim ID: ${args.claimId})`;
      } catch (e: any) {
        result = `❌ Graph kaydetme hatası: ${e.message}`;
      }
    }
    else if (name === 'analyze_gpx') {
      const files = args.files.split(',').map((f: string) => f.trim()).filter(Boolean)
      logger.info('TOOL', `📍 GPX analizi: ${files.length} dosya`)
      try {
        const gpxResult = await analyzeGpxFiles(files)
        result = formatGpxResult(gpxResult)
      } catch (e: any) {
        result = `❌ GPX analiz hatası: ${e.message}`
      }
    }
    else if (name === 'batch_save_findings') {
      const findings = args.findings
      if (!Array.isArray(findings) || findings.length === 0) {
        result = '❌ findings boş veya geçersiz — en az 1 bulgu gerekli.'
      } else {
        logger.info('TOOL', `💾 Toplu bulgu kaydı (Neo4j): ${findings.length} bulgu`)
        try {
          const stats = await batchWriteFindings(
            findings.map((f: Record<string, string>) => ({
              subjectLabel: f.subject_label,
              subjectValue: f.subject_value,
              targetLabel: f.target_label,
              targetValue: f.target_value,
              relation: f.relation,
              confidence: (f.confidence as any) ?? 'medium',
              evidence: f.evidence,
            }))
          )
          const parts = [`✅ ${findings.length} bulgu toplu olarak Neo4j grafına yazıldı. (${stats.nodesCreated} node, ${stats.relsCreated} ilişki)`]
          if (stats.errors.length > 0) {
            parts.push(`⚠️ ${stats.errors.length} hata: ${stats.errors.join('; ')}`)
          }
          result = parts.join('\n')
        } catch (e: any) {
          result = `❌ Toplu graf yazma hatası: ${e.message}`
        }
      }
    }
    else if (name === 'save_finding') {
      logger.info('TOOL', `💾 Bulgu kaydediliyor (Neo4j): ${args.subject_label}:${args.subject_value} -[${args.relation}]-> ${args.target_label}:${args.target_value}`)
      try {
        const stats = await writeFinding(args.subject_label, args.subject_value, {
          type: args.finding_type as 'identity' | 'location' | 'affiliation' | 'alias' | 'association',
          targetLabel: args.target_label,
          targetValue: args.target_value,
          relation: args.relation,
          confidence: (args.confidence as any) ?? 'medium',
          evidence: args.evidence,
        })
        result = `✅ Bulgu Neo4j grafına kaydedildi. (${stats.nodesCreated} node, ${stats.relsCreated} ilişki oluşturuldu)`
      } catch (e: any) {
        result = `❌ Graf yazma hatası: ${e.message}`
      }
    }
    else if (name === 'save_ioc') {
      logger.info('TOOL', `🛡️  IOC kaydediliyor (Neo4j): ${args.node_type}:${args.value}`)
      try {
        const props: Record<string, string> = {}
        if (args.properties && typeof args.properties === 'object') {
          Object.assign(props, args.properties)
        }
        const linkedTo = args.linked_label && args.linked_value && args.linked_relation
          ? { label: args.linked_label, value: args.linked_value, relation: args.linked_relation }
          : undefined
        const stats = await writeCybersecurityNode(args.node_type, args.value, props, linkedTo)
        result = `✅ IOC Neo4j grafına kaydedildi. (${stats.nodesCreated} node, ${stats.relsCreated} ilişki oluşturuldu)`
      } catch (e: any) {
        result = `❌ Graf yazma hatası: ${e.message}`
      }
    }
    else if (name === 'link_entities') {
      logger.info('TOOL', `🔗 Varlıklar ilişkilendiriliyor (Neo4j): ${args.from_label}:${args.from_value} -[${args.relation}]-> ${args.to_label}:${args.to_value}`)
      try {
        const stats = await linkEntities(
          args.from_label, args.from_value,
          args.to_label, args.to_value,
          args.relation,
          { evidence: args.evidence, confidence: (args.confidence as any) ?? 'medium' }
        )
        result = `✅ Varlıklar ilişkilendirildi. (${stats.nodesCreated} node, ${stats.relsCreated} ilişki oluşturuldu)`
      } catch (e: any) {
        result = `❌ Graf yazma hatası: ${e.message}`
      }
    }
    else if (name === 'reverse_image_search') {
      logger.info('TOOL', `🖼️ Reverse Image Search (SerpApi): ${args.imageUrl}`)
      const res = await searchReverseImage(args.imageUrl)
      result = formatReverseImageResult(res)
    }
    else if (name === 'compare_images_phash') {
      logger.info('TOOL', `🧩 pHash Karşılaştırması: ${args.url1} vs ${args.url2}`)
      result = await compareImages(args.url1, args.url2)
    }
    else if (name === 'add_custom_node') {
      logger.info('TOOL', `➕ Özel düğüm ekleniyor: ${args.label}`);
      const res = await addCustomNodeTool({ label: args.label, properties: args.properties as any });
      result = JSON.stringify(res);
    }
    else if (name === 'delete_custom_node') {
      logger.info('TOOL', `➖ Özel düğüm siliniyor: ${args.label} (${args.matchKey}: ${args.matchValue})`);
      const res = await deleteCustomNodeTool({ label: args.label, matchKey: args.matchKey, matchValue: args.matchValue });
      result = JSON.stringify(res);
    }
    else if (name === 'add_custom_relationship') {
      logger.info('TOOL', `🔗 Özel ilişki ekleniyor: ${args.sourceLabel} -[${args.relationshipType}]-> ${args.targetLabel}`);
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
      logger.info('TOOL', `👤 Araştırmacı Arama (Semantic Scholar): ${args.name}`)
      const authorResult = await searchAuthorPapers(args.name, args.affiliation)
      result = formatAuthorResult(authorResult)
      // Graf'a yaz — AuthorPaper'ı AcademicPaper formatına çevir
      if (authorResult.author && authorResult.author.papers.length > 0) {
        try {
          const { getDriver } = await import('./neo4j.js')
          const driver = getDriver()
          const neo4jWrite = async (query: string, params: Record<string, unknown>) => {
            const session = driver.session()
            try { await session.run(query, params) } finally { await session.close() }
          }
          const papers = authorResult.author.papers.map((p) => ({
            arxivId: p.arxivId ?? p.paperId,
            title: p.title,
            authors: [authorResult.author!.name],
            abstract: '',
            publishedDate: p.year ? `${p.year}-01-01` : '',
            updatedDate: '',
            categories: [],
            pdfUrl: p.doi ? `https://doi.org/${p.doi}` : '',
            htmlUrl: p.arxivId ? `https://arxiv.org/abs/${p.arxivId}` : '',
            totalCitations: p.citationCount,
          }))
          const stats = await writeAcademicPapersToGraph(papers, args.name, neo4jWrite)
          logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.papersCreated} makale, ${stats.authorsLinked} yazar bağlantısı`)
          result += `\n\n💾 Neo4j Graf: ${stats.papersCreated} Paper node, ${stats.authorsLinked} AUTHORED_BY ilişkisi oluşturuldu.`
        } catch {
          logger.warn('GRAPH', '⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)')
        }
      }
    }
    else if (name === 'generate_report') {
      logger.info('TOOL', `📄 Rapor oluşturuluyor [${args.reportType || 'osint'}]: ${args.subject}`)
      // additionalFindings yoksa buffer'dan oku (model JSON encode edemediyse fallback)
      const findings = args.additionalFindings || _reportContentBuffer || undefined;
      if (!args.additionalFindings && _reportContentBuffer) {
        logger.debug('TOOL', `ℹ️  additionalFindings argümanı yoktu — dahili buffer kullanıldı (${_reportContentBuffer.length} karakter)`);
      }
      try {
        const reportResult = await generateOsintReport({
          subject: args.subject,
          reportType: (args.reportType as 'osint' | 'academic' | 'factcheck') ?? 'osint',
          title: args.title,
          additionalFindings: findings,
        })
        logger.info('TOOL', `✅ Rapor kaydedildi: ${reportResult.filePath}`)
        result = [
          `✅ **Rapor başarıyla oluşturuldu!**`,
          ``,
          `📁 **Dosya:** \`${reportResult.filePath}\``,
          ``,
          `---`,
          ``,
          reportResult.markdown,
        ].join('\n')
      } catch (e) {
        const msg = (e as Error).message
        logger.error('TOOL', `❌ Rapor hatası: ${msg}`)
        result = `❌ Rapor oluşturma hatası: ${msg}`
      }
    }
    else if (name === 'check_plagiarism') {
      const label = args.title ?? args.doi ?? args.author ?? 'metin'
      logger.info('TOOL', `🔬 İntihal Analizi: ${label}`)
      try {
        const report = await checkPlagiarism({
          text: args.text,
          mode: (args.mode as 'plagiarism' | 'originality' | 'full') ?? 'plagiarism',
          author: args.author,
          title: args.title,
          doi: args.doi,
        })
        const riskEmoji = { clean: '🟢', low: '🔵', medium: '🟡', high: '🔴', critical: '🚨' }[report.overallRisk]
        logger.info('TOOL', `✅ Analiz tamamlandı: ${riskEmoji} ${report.overallRisk.toUpperCase()} — ${report.matches.length} eşleşme`)
        result = report.markdown
      } catch (e) {
        const msg = (e as Error).message
        logger.error('TOOL', `❌ İntihal analizi hatası: ${msg}`)
        result = `❌ İntihal analizi hatası: ${msg}`
      }
    }
    else if (name === 'search_academic_papers') {
      const maxResults = parseInt(args.maxResults ?? '10') || 10
      const sortBy = (args.sortBy as 'relevance' | 'submittedDate' | 'lastUpdatedDate') ?? 'submittedDate'
      logger.info('TOOL', `🔬 Akademik Araştırma (arXiv + Semantic Scholar): ${args.query}`)
      const searchResult = await searchAcademicPapers(args.query, maxResults, sortBy)
      const ssNote = (searchResult as AcademicSearchResult & { _ssNote?: string })._ssNote
      if (ssNote) logger.debug('TOOL', ssNote)
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
        logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.papersCreated} makale, ${stats.authorsLinked} yazar bağlantısı`)
        result += `\n\n💾 Neo4j Graf: ${stats.papersCreated} Paper node, ${stats.authorsLinked} AUTHORED_BY ilişkisi oluşturuldu.`
      } catch {
        logger.warn('GRAPH', '⚠️  Graf yazma atlandı (Neo4j bağlantısı yok olabilir)')
      }
    }
    else if (name === 'obsidian_write') {
      const overwrite = String(args.overwrite) !== 'false'
      logger.info('OBSIDIAN', `🟣 Obsidian'a yazılıyor: ${args.note_path}`)
      result = await obsidianWrite(args.note_path, args.content, overwrite)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_append') {
      logger.info('OBSIDIAN', `🟣 Obsidian'a ekleniyor: ${args.note_path}`)
      result = await obsidianAppend(args.note_path, args.content)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_read') {
      logger.info('OBSIDIAN', `🟣 Obsidian okunuyor: ${args.note_path}`)
      result = await obsidianRead(args.note_path)
    }
    else if (name === 'obsidian_daily') {
      logger.info('OBSIDIAN', '🟣 Günlüğe kaydediliyor...')
      result = await obsidianDailyLog(args.entry, args.tag)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_write_profile') {
      logger.info('OBSIDIAN', `🟣 Profil oluşturuluyor: ${args.username}`)
      const metadata = {
        realName: args.real_name,
        emails: args.emails ? String(args.emails).split(',').map((s: string) => s.trim()) : undefined,
        platforms: args.platforms ? String(args.platforms).split(',').map((s: string) => s.trim()) : undefined,
        confidence: args.confidence as 'verified' | 'high' | 'medium' | 'low' | undefined,
      }
      result = await obsidianWriteProfile(args.username, args.content, metadata)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_list') {
      logger.info('OBSIDIAN', `🟣 Obsidian dizini listeleniyor: ${args.dir || '(vault kökü)'}`)
      result = await obsidianList(args.dir)
    }
    else if (name === 'obsidian_search') {
      logger.info('OBSIDIAN', `🟣 Obsidian'da aranıyor: ${args.query}`)
      const limit = args.limit ? parseInt(String(args.limit), 10) : 10
      result = await obsidianSearch(args.query, limit)
      logger.debug('OBSIDIAN', result.slice(0, 200))
    }
    else result = `Unknown tool: ${name}`;

    if (cacheableTools.has(name) && !result.startsWith('Unknown tool')) {
      toolCache.set(cacheKey, result);
    }
    
    return result;
  }

async function runExtractMetadata(url: string): Promise<string> {
  logger.info('TOOL', `🔍 Metadata çıkarılıyor: ${url}...`)
  const result = await extractMetadataFromUrl(url)
  const interesting = Object.keys(result.interestingFields).length
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
  } else {
    logger.info('TOOL', `✅ ${Object.keys(result.fields).length} metadata alanı bulundu (${interesting} OSINT-relevant)`)
  }
  return formatMetadata(result)
}

async function runParseGpgKey(username: string): Promise<string> {
  logger.info('TOOL', `🔑 GPG key analizi: ${username}...`)
  let result = await parseGithubGpgKey(username)

  // GitHub .gpg endpoint boş döndüyse → repo'da raw PGP dosyası arama yap
  if (result.error && result.emails.length === 0) {
    logger.debug('TOOL', `🔍 Repo'da PGP key aranıyor (${username}/PGP)...`)
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
          logger.info('TOOL', `✅ Repo'da PGP key bulundu: ${rawUrl}`)
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
    logger.error('TOOL', `❌ ${result.error}`)
  } else {
    logger.info('TOOL', `✅ ${result.emails.length} email, ${result.names.length} isim bulundu`)
  }

  // Email'leri grafa yaz
  if (result.emails.length > 0) {
    try {
      const stats = await writeOsintToGraph(username, { emails: result.emails, realName: result.names[0] }, 'gpg_key')
      logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
    }
  }

  return formatGpgResult(result)
}

async function runWaybackSearch(url: string): Promise<string> {
  logger.info('TOOL', `📸 Wayback Machine aranıyor: ${url}...`)
  const result = await waybackSearch(url)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
  } else {
    logger.info('TOOL', `✅ ${result.snapshots.length} arşiv snapshot'ı bulundu`)
  }
  return formatWaybackResult(result)
}

async function runWebFetch(url: string): Promise<string> {
  logger.info('TOOL', `🌐 Sayfa çekiliyor: ${url}...`)
  let result = await webFetch(url)
  
  // HİBRİT FALLBACK: Eğer 403 (Cloudflare/Bot protection) veya bağlantı hatası alırsak, Firecrawl API'sine (scrapeTool) düş.
  if (result.error || result.statusCode === 403 || result.statusCode === 401) {
    logger.warn('TOOL', `⚠️ curl engellendi (HTTP ${result.statusCode || 'Hata'}). Firecrawl Stealth Proxy'ye geçiliyor...`)
    try {
      const scrapeResult = await scrapeProfile(url)
      if (!scrapeResult.error) {
        logger.info('TOOL', '✅ Firecrawl ile başarıyla çekildi (Markdown okundu)')
        // Scrape sonuçlarını formatlayıp dön
        return formatScrapeResult(scrapeResult)
      } else {
        logger.error('TOOL', `❌ Firecrawl da başarısız: ${scrapeResult.error}`)
        return `Fetch ve Scrape hatası: ${scrapeResult.error}`
      }
    } catch (e) {
      logger.error('TOOL', `❌ Scrape modülü hatası: ${(e as Error).message}`)
      return `Scrape hatası: ${(e as Error).message}`
    }
  }

  logger.info('TOOL', `✅ ${result.contentType} (HTTP ${result.statusCode})`)
  if (result.textContent) {
    // Akademik URL'ler için deep-read modu: 50K — diğerleri için 8K
    const isDeepReadUrl = /ar5iv\.|arxiv\.org\/(abs|pdf)|doi\.org|dergipark\.org\.tr|ncbi\.nlm\.nih\.gov|pubmed\.|semanticscholar\.org/.test(url)
    const limit = isDeepReadUrl ? 50000 : 8000
    if (isDeepReadUrl) logger.debug('TOOL', `📖 Deep-read modu aktif (${limit.toLocaleString()} char)`)
    return result.textContent.slice(0, limit)
  }
  return `Binary dosya indirildi: ${result.savedTo} (${result.contentType})`
}

async function runEmailRegistrations(email: string): Promise<string> {
  logger.info('TOOL', `📧 Email kayıt kontrolü (Holehe): ${email}...`)
  logger.info('TOOL', '(120+ platform taranıyor, ~30-60sn)')
  const result = await checkEmailRegistrations(email)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return formatHoleheResult(result)
  }
  logger.info('TOOL', `✅ ${result.totalChecked} platform tarandı, ${result.services.length} kayıt bulundu`)

  // Grafa yaz: Email → REGISTERED_ON → Platform
  if (result.services.length > 0) {
    try {
      const stats = await writeEmailRegistrations(email, result.services, 'holehe')
      logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
    }
  }

  return formatHoleheResult(result)
}



async function runClearGraph(confirm: boolean): Promise<string> {
  if (!confirm) return 'Silme işlemi onaylanmadı.';
  logger.warn('GRAPH', '⚠️  Graf veritabanı temizleniyor...');
  try {
    process.env.NEO4J_ALLOW_CLEAR = '1';
    await clearGraph();
    logger.info('GRAPH', '✅ Graf veritabanı başarıyla temizlendi.');
    return 'Tüm graf veritabanı kalıcı olarak silindi ve sıfırlandı.';
  } catch (e) {
    logger.error('GRAPH', `❌ Hata: ${(e as Error).message}`);
    return `Temizleme hatası: ${(e as Error).message}`;
  }
}

async function runRemoveFalsePositive(label: string, value: string): Promise<string> {
  logger.warn('GRAPH', `🧹 False Positive Temizleniyor: ${label}(${value})`);
  try {
    const success = await deleteGraphNodeAndRelations(label, value);
    if (success) {
      logger.info('GRAPH', '✅ Düğüm ve ilişkileri Graf’tan silindi.');
      return `Başarı: ${label} etiketli ve ${value} değerli düğüm (ve bağlı ilişkileri) sinildi.`;
    } else {
      logger.warn('GRAPH', '⚠️ Eşleşen düğüm bulunamadı veya silinemedi.');
      return `Hata: ${label} etiketli ve ${value} değerli düğüm bulunamadı.`;
    }
  } catch (e) {
    logger.error('GRAPH', `❌ Temizleme hatası: ${(e as Error).message}`);
    return `Temizleme hatası: ${(e as Error).message}`;
  }
}

async function runSearchWeb(query: string): Promise<string> {
  logger.info('SEARCH', `🔎 Web'de aranıyor (Dorking): ${query}...`)
  const result = await searchWeb(query)
  if (result.error) {
    logger.error('SEARCH', `❌ ${result.error}`)
    return formatSearchResult(result)
  }
  logger.info('SEARCH', `✅ ${result.results.length} sonuç bulundu`)

  // Kaynak etiketlerini sonuçlara ekle
  const lines: string[] = []
  const header = formatSearchResult(result)
  // Header formatSearchResult'dan gelir, sonuçları ayır
  const headerLines = header.split('\n')
  for (const line of headerLines) {
    lines.push(line)
    // "   URL: https://..." satırından sonra kaynak etiketi ekle
    if (line.trim().startsWith('URL:')) {
      const url = line.trim().replace(/^URL:\s*/, '')
      const resultItem = result.results.find(r => r.url === url)
      lines.push(`   ${formatSourceBadge(url, resultItem?.snippet)}`)
    }
  }
  return lines.join('\n')
}

async function runSearchWebMulti(queriesRaw: string): Promise<string> {
  const queries = queriesRaw.split(',').map(q => q.trim()).filter(Boolean).slice(0, 3)
  logger.info('SEARCH', `🔎 Paralel arama (${queries.length} sorgu): ${queries.join(' | ')}`)
  const result = await searchWebMulti(queries)
  logger.info('SEARCH', `✅ ${result.totalUnique} benzersiz sonuç`)

  const lines: string[] = [
    `🔍 Paralel Web Arama (${queries.length} sorgu): ${queries.join(', ')}`,
    `Benzersiz sonuç: ${result.totalUnique}`,
    '',
    `⚠️ SİSTEM NOTU: Sonuçları doğrudan %100 doğru kabul etmeyin.`,
    '',
  ]
  result.results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`)
    lines.push(`   URL: ${r.url}`)
    lines.push(`   ${formatSourceBadge(r.url, r.snippet)}`)
    lines.push(`   Özet: ${r.snippet}`)
    lines.push('')
  })
  return lines.join('\n')
}

async function runVerifyClaim(url: string, claim: string): Promise<string> {
  logger.info('TOOL', `🔍 İddia doğrulama: "${claim}" @ ${url}`)
  // claim metninden basit anahtar kelimeler çıkar
  const keywords = claim
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['olan', 'için', 'veya', 'and', 'the', 'with', 'that', 'this'].includes(w))
    .slice(0, 5)
  const result = await verifyClaim(claim, url, keywords)
  logger.info('TOOL', `✅ Doğrulama tamamlandı — güven: ${result.confidence}`)
  return formatVerifyResult(result)
}

async function runScrapeProfile(url: string): Promise<string> {  logger.info('TOOL', `🕷️  Sayfa kazınıyor: ${url}...`)
  const result = await scrapeProfile(url)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    if (result.usageWarning) logger.warn('TOOL', result.usageWarning)
    return formatScrapeResult(result)
  }
  const found = [result.emails.length, result.cryptoWallets.length, result.usernameHints.length]
    .map((n, i) => n > 0 ? `${n} ${['email', 'cüzdan', 'handle'][i]}` : '')
    .filter(Boolean).join(', ')
  logger.info('TOOL', `✅ Sayfa alındı${found ? ` — ${found}` : ''}: ${result.title || url}`)

  return formatScrapeResult(result)
}

async function runBreachCheck(email: string): Promise<string> {
  logger.info('TOOL', `🔓 Veri sızıntısı kontrolü: ${email}...`)
  const result = await checkBreaches(email)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return formatBreachResult(result)
  }
  logger.info('TOOL', `✅ ${result.breaches.length} sızıntı bulundu (kaynak: ${result.source})`)

  // Grafa yaz: Email → LEAKED_IN → Breach
  if (result.breaches.length > 0) {
    try {
      const stats = await writeBreachData(email, result.breaches, result.source === 'hibp' ? 'hibp' : 'local_breach_db')
      logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
    }
  }

  return formatBreachResult(result)
}

async function runVerifyProfiles(username: string): Promise<string> {
  logger.info('TOOL', `🔍 Profil doğrulama başlatılıyor: ${username}...`)

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
    logger.debug('TOOL', '🖼️ Hedefin bilinen bir avatarı var, referans hash hesaplanıyor...');
    avatarHash = (await fetchAndHashImage(known.avatarUrl)) || undefined;
    if (avatarHash) {
      logger.info('TOOL', `✅ Referans avatar hash eşleşti: ${avatarHash.substring(0, 16)}...`);
    } else {
      logger.warn('TOOL', '⚠️ Referans avatar indirilemedi veya hash hesaplanamadı.');
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

  logger.info('TOOL', `📋 ${profiles.length} profil bulundu, doğrulama yapılıyor (max 10)...`)

  const knownIds = {
    username,
    realName: known.realNames[0],
    emails: known.emails,
    avatarUrl: known.avatarUrl,
    avatarHash: avatarHash
  }

  const { results, verified, unverified, skipped } = await verifySherlockProfiles(profiles, knownIds, 10)

  logger.info('TOOL', `✅ Doğrulama tamamlandı: ${verified} doğrulandı, ${unverified} doğrulanmadı, ${skipped} atlandı`)

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
  logger.info('TOOL', `🐦 Twitter/X profil çekiliyor (Scrapling Stealth): ${username}...`)
  const result = await fetchNitterProfile(username)

  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return formatNitterResult(result)
  }

  logger.info('TOOL', `✅ Twitter profili çekildi: ${result.displayName || username}`)

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
    logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
  } catch {
    logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
  }

  return formatNitterResult(result)
}

async function runUnexploredPivots(username: string): Promise<string> {
  logger.info('TOOL', `🧭 Keşfedilmemiş pivot noktaları aranıyor: ${username}...`)
  try {
    const pivots = await findUnexploredPivots(username)
    logger.info('TOOL', `✅ ${pivots.suggestions.length} öneri bulundu`)
    return formatUnexploredPivots(pivots)
  } catch (e) {
    logger.error('TOOL', `❌ ${(e as Error).message}`)
    return `Pivot analizi hatası: ${(e as Error).message}`
  }
}

async function runSearchPerson(name: string, context?: string): Promise<string> {
  logger.info('TOOL', `👤 İsim araştırması: ${name}${context ? ` (${context})` : ''}...`)
  const result = await searchPerson(name, context)

  if (result.graphMatches.length > 0) {
    const totalUsernames = result.graphMatches.reduce((sum, m) => sum + m.linkedUsernames.length, 0)
    logger.info('TOOL', `✅ Grafta ${result.graphMatches.length} eşleşme, ${totalUsernames} bağlı username bulundu`)
  } else {
    logger.info('TOOL', '⚠️ Grafta eşleşme yok — web araması yapıldı')
  }

  return formatPersonSearchResult(result)
}

async function queryGraph(value: string): Promise<string> {
  logger.info('GRAPH', `📊 Graf sorgulanıyor: ${value}...`)
  try {
    const connections = await getConnections(value)
    if (connections.length === 0) return `"${value}" için grafta bağlantı bulunamadı.`
    const lines = connections.map((c) => {
      const meta = c.confidence ? ` [✅ ${c.confidence}${c.source ? ` via ${c.source}` : ''}]` : ''
      return `${c.from} --[${c.relation}]--> ${c.to} (${c.toLabel})${meta}`
    })
    logger.info('GRAPH', `✅ ${connections.length} bağlantı bulundu`)
    return `Graf bağlantıları (${value}):\n${lines.join('\n')}`
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function runCrossReference(username: string): Promise<string> {
  logger.info('GRAPH', `🔗 Çapraz doğrulama: ${username}...`)
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

    logger.info('GRAPH', `✅ ${ids.emails.length} email, ${ids.handles.length} handle, ${ids.realNames.length} isim bulundu`)
    return lines.join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function graphStats(): Promise<string> {
  logger.info('GRAPH', '📊 Graf istatistikleri çekiliyor...')
  try {
    const stats = await getGraphStats()
    logger.info('GRAPH', `✅ ${stats.nodes} node, ${stats.relationships} ilişki`)
    return `Graf istatistikleri:\n- Toplam node: ${stats.nodes}\n- Toplam ilişki: ${stats.relationships}`
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function runListGraphNodes(label?: string, limit?: string): Promise<string> {
  logger.info('GRAPH', '🧩 Graf node listesi çekiliyor...')
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

    logger.info('GRAPH', `✅ ${nodes.length} node listelendi`)
    return lines.join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function repairGraphNoise(): Promise<string> {
  logger.info('GRAPH', '🧹 Graf gürültüsü temizleniyor...')
  try {
    const result = await pruneMisclassifiedFullNameUsernames()
    logger.info('GRAPH', `✅ ${result.usernamesRemoved} username, ${result.profilesRemoved} profil temizlendi`)
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


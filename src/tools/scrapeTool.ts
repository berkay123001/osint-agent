import { extractMetadataFromUrl, formatMetadata } from './metadataTool.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { emitProgress } from '../lib/progressEmitter.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Scrapling Python executable — set SCRAPLING_PYTHON or PYTHON_PATH in .env
const SCRAPLING_PYTHON = process.env.SCRAPLING_PYTHON || process.env.PYTHON_PATH || 'python3'
// dist/tools/ → src/tools/ (tsc doesn't copy .py files, run from source directory)
const SCRAPLING_RUNNER = __dirname.includes('/dist/')
  ? path.join(__dirname, '..', '..', 'src', 'tools', 'scrapling_runner.py')
  : path.join(__dirname, 'scrapling_runner.py')

/**
 * Profile scraping tool.
 * Chain: Scrapling (stealth, anti-bot) → Puppeteer (JS rendering) → Firecrawl cloud (last resort).
 * Scrapling is the primary scraper — can bypass Cloudflare and anti-bot protections.
 */

export interface ScrapeResult {
  url: string
  markdown: string
  title: string
  description: string
  links: string[]
  emails: string[]
  cryptoWallets: string[]
  usernameHints: string[]
  avatarUrl?: string
  metadataAlerts?: string[]
  loginWallDetected?: boolean
  error?: string
  usageWarning?: string
}


export function isInterestingFile(url: string | undefined): boolean {
  if (!url) return false
  const lowerUrl = url.toLowerCase()
  if (!lowerUrl.match(/\.(pdf|docx?|jpg|jpeg|png)$/)) return false
  const ignoredDomains = [
    'avatars.githubusercontent.com', 'pbs.twimg.com', 'instagram.', 
    'facebook.', 'googleusercontent.', 'cdn.', 'gravatar.com', 'twimg', 'tiktok', 'licdn.com'
  ]
  if (ignoredDomains.some(d => lowerUrl.includes(d))) return false
  return true
}

/**
 * Giriş/kayıt duvarı tespiti.
 * Sayfa içeriğinin kısıtlı olduğunu gösteren belirgin desenleri arar.
 */
export function detectLoginWall(markdown: string, title: string): boolean {
  const combined = `${title} ${markdown}`.toLowerCase()
  const WALL_PATTERNS = [
    'sign in to continue', 'sign in to view', 'sign in to access',
    'create an account', 'register to view', 'register to access',
    'login required', 'log in to continue', 'log in to view',
    'sign up to access', 'sign up to continue', 'sign up to view',
    'üye ol', 'giriş yap', 'kayıt ol',
    'you need to be logged in', 'please log in', 'please sign in',
    'members only', 'subscribers only',
  ]
  if (WALL_PATTERNS.some(p => combined.includes(p))) return true
  // Ücret sınır: çok az içerik var VE başlık giriş sayfasına benziyor
  if (markdown.trim().length < 300) {
    const titleLower = title.toLowerCase()
    if (
      titleLower.includes('login') || titleLower.includes('sign in') ||
      titleLower.includes('register') || titleLower.includes('sign up') ||
      titleLower.includes('giriş') || titleLower.includes('üye')
    ) return true
  }
  return false
}

async function processMetadataForLinks(links: string[]): Promise<string[]> {
  const interesting = links.filter(isInterestingFile).slice(0, 2); // Max 2 dosya
  const alerts: string[] = []
  for (const link of interesting) {
    alerts.push(`[Yükleniyor...] ${link} (OSINT Metadata Analizi)`)
    const m = await extractMetadataFromUrl(link)
    if (Object.keys(m.interestingFields).length > 0) {
      alerts.push(`⚠️ Otomatik Belge Analizi (${link}):\n${formatMetadata(m)}`)
    }
  }
  return alerts.filter(a => !a.startsWith('[Yükleniyor')); // Yükleniyor loglarını at, sadece sonuçları tut
}

const FIRECRAWL_CLOUD_API = 'https://api.firecrawl.dev/v1/scrape'

function getFirecrawlUrl(): string {
  return process.env.FIRECRAWL_URL || 'http://localhost:3002/v1/scrape'
}

/**
 * Firecrawl endpoint'ine istek atar. Self-hosted ve cloud ayni formati kullanir.
 * Basarisiz olursa null doner, ust kod fallback'e gecer.
 */
async function tryFirecrawlScrape(
  endpoint: string,
  targetUrl: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; body?: string; status?: number }> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: targetUrl,
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        waitFor: 2000,
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      return { ok: false, status: res.status }
    }
    return { ok: true, body: await res.text() }
  } catch {
    return { ok: false }
  }
}

/**
 * Firecrawl JSON yanitini parse edip ScrapeResult olusturur.
 * Self-hosted ve cloud ayni response formatini kullanir.
 */
function parseFirecrawlResponse(body: string, url: string): ScrapeResult | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }

  const pageData = (data.data as Record<string, unknown>) ?? {}
  const md = String((pageData.markdown as string) ?? '')
  const linksRaw = ((pageData.links as string[] | undefined) ?? []).filter(l => typeof l === 'string')

  const emails = [...new Set(md.match(EMAIL_REGEX) ?? [])]
  const btcMatches = md.match(BITCOIN_REGEX) ?? []
  const ethMatches = md.match(ETH_REGEX) ?? []
  const cryptoWallets = [...new Set([...btcMatches, ...ethMatches])]

  const discordHandles = [...md.matchAll(DISCORD_REGEX)].map(m => `discord:${m[0]}`)
  const telegramHandles = [...md.matchAll(TELEGRAM_REGEX)].map(m => `telegram:${m[1]}`)
  const usernameHints = [...new Set([...discordHandles, ...telegramHandles])]

  const meta = (pageData.metadata as Record<string, unknown>) ?? {}
  const ogImage = String(meta.ogImage ?? meta['twitter:image'] ?? '')

  return {
    url,
    markdown: md.slice(0, 4000),
    title: String((meta.title as string) ?? ''),
    description: String((meta.description as string) ?? ''),
    links: linksRaw.slice(0, 30),
    emails,
    cryptoWallets,
    usernameHints,
    avatarUrl: ogImage ? ogImage : undefined,
  }
}

// Regex'ler: scrape çıktısından OSINT değeri olan varlıkları çıkar
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const BITCOIN_REGEX = /\b(bc1[a-z0-9]{25,39}|[13][a-zA-Z0-9]{25,34})\b/g
const ETH_REGEX = /\b0x[a-fA-F0-9]{40}\b/g
const DISCORD_REGEX = /\b[a-zA-Z0-9_.]{2,32}#[0-9]{4}\b/g
// Sadece t.me/ ile başlayan linkler — bare @mention'lar başka platformlarda false positive üretir
const TELEGRAM_REGEX = /t\.me\/([a-zA-Z0-9_]{5,})/g

async function fallbackPuppeteerScrape(url: string): Promise<ScrapeResult> {
  let browser = null;
  try {
    const puppeteerExtra = (await import('puppeteer-extra')).default as any;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default as any;
    puppeteerExtra.use(StealthPlugin());

    // Import TurndownService to convert HTML to Markdown (eğer lazımsa, fakat şimdilik düz metin çıkarıyoruz)
    
    const puppeteerOptions: any = {
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--disable-gpu',
        '--ignore-certificate-errors'
      ]
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteerExtra.launch(puppeteerOptions);
    
    const page = await browser.newPage();
    // Bot detect engellemek için viewport ve useragent ayarları
    await page.setViewport({ width: 1280, height: 800 });
    
    let isLinkedIn = url.includes('linkedin.com/in/');
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Özellikle JS tabanlı yönlendirmeler veya Cloudflare challenge'ları için bekle
    await new Promise(r => setTimeout(r, 5000));

    const title = await page.title();
    
    // Görünen tüm metni al
    const rawText = await page.evaluate(() => {
      // Eğer body yoksa bir şey döndürme (yönlendirme esnasında çökmeyi önler)
      if (!document.body) return '';
      return document.body.innerText || '';
    });
    
    // Avatar fotoğrafını bul (öncelikli og:image veya twitter:image veya ilk profil classına sahip img)
    const avatarUrl = await page.evaluate(() => {
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
      if (ogImage) return ogImage;
      const twImage = document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
      if (twImage) return twImage;
      const img = document.querySelector('img[class*="avatar"], img[class*="profile"]');
      return img ? img.getAttribute('src') : undefined;
    });

    // Linkleri topla
    const links = (await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .map(a => a.href)
        .filter(l => l && l.startsWith('http'));
    })) as string[];
    
    const uniqueLinks = [...new Set(links)].slice(0, 30);
    const md = rawText.substring(0, 4000);
    
    const emails = [...new Set(md.match(EMAIL_REGEX) ?? [])] as string[];
    const btcMatches = md.match(BITCOIN_REGEX) ?? [];
    const ethMatches = md.match(ETH_REGEX) ?? [];
    const cryptoWallets = [...new Set([...btcMatches, ...ethMatches])] as string[];
    
    const discordHandles = [...md.matchAll(DISCORD_REGEX)].map(m => `discord:${m[0]}`);
    const telegramHandles = [...md.matchAll(TELEGRAM_REGEX)].map(m => `telegram:${m[1]}`);
    const usernameHints = [...new Set([...discordHandles, ...telegramHandles])] as string[];

    return {
      url,
      markdown: md,
      title,
      description: 'Scraped via local Puppeteer Stealth (Fallback)',
      links: uniqueLinks,
      emails,
      cryptoWallets,
      usernameHints,
      avatarUrl: avatarUrl ? (avatarUrl.startsWith('//') ? 'https:' + avatarUrl : (avatarUrl.startsWith('/') ? new URL(avatarUrl, url).href : avatarUrl)) : undefined,
      metadataAlerts: await processMetadataForLinks(uniqueLinks),
    };
  } catch (err: any) {
    emitProgress(`[Scrape] Puppeteer başarısız (${(err as Error).message})`)
    return {
      url,
      markdown: '',
      title: '',
      description: '',
      links: [],
      emails: [],
      cryptoWallets: [],
      usernameHints: [],
      error: `Puppeteer Error: ${(err as Error).message}`,
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function fallbackScraplingFetch(url: string): Promise<ScrapeResult> {
  try {
    // Twitter/X ve Instagram için --dynamic (JS rendering), diğerleri için --stealth
    const mode = (url.includes('twitter.com') || url.includes('x.com') || url.includes('instagram.com'))
      ? '--dynamic'
      : '--stealth'

    emitProgress(`[Scrape] Scrapling (${mode}) kullanılıyor: ${url}`)
    const { stdout, stderr } = await execFileAsync(
      SCRAPLING_PYTHON,
      [SCRAPLING_RUNNER, url, mode],
      { timeout: 60000 }
    )

    if (stderr && stderr.trim()) {
      emitProgress(`[Scrapling] ${stderr.slice(0, 120).split('\n')[0]}`)
    }

    const result = JSON.parse(stdout.trim()) as {
      markdown: string
      title: string
      links: string[]
      emails: string[]
      cryptoWallets: string[]
      usernameHints: string[]
      avatarUrl?: string
      status: number
      error?: string
    }

    if (result.error) {
      return {
        url,
        markdown: '',
        title: '',
        description: '',
        links: [],
        emails: [],
        cryptoWallets: [],
        usernameHints: [],
        error: `Scrapling Error: ${result.error}`,
      }
    }

    return {
      url,
      markdown: result.markdown.slice(0, 4000),
      title: result.title,
      description: 'Scraped via Scrapling StealthyFetcher/DynamicFetcher',
      links: result.links.slice(0, 30),
      emails: result.emails,
      cryptoWallets: result.cryptoWallets,
      usernameHints: result.usernameHints,
      avatarUrl: result.avatarUrl,
      metadataAlerts: await processMetadataForLinks(result.links),
    }
  } catch (err: any) {
    return {
      url,
      markdown: '',
      title: '',
      description: '',
      links: [],
      emails: [],
      cryptoWallets: [],
      usernameHints: [],
      error: `Scrapling Fallback Error: ${(err as Error).message}`,
    }
  }
}

export async function scrapeProfile(url: string): Promise<ScrapeResult> {
  // SSRF protection — block private/internal network addresses
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    ) {
      return {
        url, markdown: '', title: '', description: '',
        links: [], emails: [], cryptoWallets: [], usernameHints: [],
        error: `İç ağ adreslerine erişim engellendi: ${hostname}`,
      }
    }
  } catch {
    return {
      url, markdown: '', title: '', description: '',
      links: [], emails: [], cryptoWallets: [], usernameHints: [],
      error: `Geçersiz URL: ${url}`,
    }
  }

  if (isInterestingFile(url)) {
    emitProgress(`[Scrape] Medya/belge dosyası: ${url}`);
    const m = await extractMetadataFromUrl(url);
    const alerts = [];
    if (Object.keys(m.interestingFields).length > 0) {
      alerts.push(`⚠️ Doğrudan Belge Analizi (${url}):\n${formatMetadata(m)}`);
    } else {
      alerts.push(`ℹ️ Dosya incelendi ancak önemli bir metadata bulunamadı.`);
    }
    return {
      url,
      markdown: 'Bu bir belge/medya dosyasıdır (metadata analizi yapıldı).',
      title: 'Medya/Belge Dosyası',
      description: 'Doğrudan analiz',
      links: [], emails: [], cryptoWallets: [], usernameHints: [],
      metadataAlerts: alerts
    };
  }

  // 1) Scrapling (birincil) — Cloudflare bypass, anti-bot, stealth tarama
  emitProgress(`[Scrape] Scrapling ile çekiliyor: ${url}`)
  const scraplingResult = await fallbackScraplingFetch(url)
  if (!scraplingResult.error && scraplingResult.markdown.length > 100) {
    emitProgress(`[Scrape] ✓ Scrapling (${scraplingResult.markdown.length} char): ${url}`)
    return { ...scraplingResult, loginWallDetected: detectLoginWall(scraplingResult.markdown, scraplingResult.title) }
  }
  if (scraplingResult.error) {
    emitProgress(`[Scrape] Scrapling başarısız → Puppeteer: ${url}`)
  } else {
    emitProgress(`[Scrape] Scrapling yetersiz (${scraplingResult.markdown.length} char) → Puppeteer: ${url}`)
  }

  // 2) Puppeteer Stealth (JS rendering gerektiren sayfalar için)
  emitProgress(`[Scrape] Puppeteer Stealth ile çekiliyor: ${url}`)
  const puppeteerResult = await fallbackPuppeteerScrape(url)
  if (!puppeteerResult.error && puppeteerResult.markdown.length > 100) {
    emitProgress(`[Scrape] ✓ Puppeteer (${puppeteerResult.markdown.length} char): ${url}`)
    return { ...puppeteerResult, loginWallDetected: detectLoginWall(puppeteerResult.markdown, puppeteerResult.title) }
  }
  if (puppeteerResult.error) {
    emitProgress(`[Scrape] Puppeteer başarısız: ${puppeteerResult.error}`)
  }

  // 3) Firecrawl cloud (son çare, 500 req/ay limit)
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (apiKey) {
    emitProgress(`[Scrape] Firecrawl cloud (son çare): ${url}`)
    const cloudHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }
    const cloudResult = await tryFirecrawlScrape(FIRECRAWL_CLOUD_API, url, cloudHeaders)
    if (cloudResult.ok && cloudResult.body) {
      const parsed = parseFirecrawlResponse(cloudResult.body, url)
      if (parsed && parsed.markdown.length > 0) {
        emitProgress(`[Scrape] ✓ Cloud Firecrawl: ${url}`)
        const usageWarning = cloudResult.status === 429
          ? '⚠️ Firecrawl aylık 500 istek kotası dolmuş.'
          : undefined
        return {
          ...parsed,
          metadataAlerts: await processMetadataForLinks(parsed.links),
          usageWarning,
          loginWallDetected: detectLoginWall(parsed.markdown, parsed.title),
        }
      }
    }
    emitProgress(`[Scrape] Cloud Firecrawl da başarısız`)
  }

  // Scrapling'in sonucunu döndür (içerik az olsa bile)
  if (scraplingResult.markdown.length > 0) {
    return { ...scraplingResult, loginWallDetected: detectLoginWall(scraplingResult.markdown, scraplingResult.title) }
  }
  // Puppeteer'in sonucunu döndür
  if (puppeteerResult.markdown.length > 0) {
    return { ...puppeteerResult, loginWallDetected: detectLoginWall(puppeteerResult.markdown, puppeteerResult.title) }
  }

  // Hiçbir şey çalışmadı
  return {
    url,
    markdown: '',
    title: '',
    description: '',
    links: [],
    emails: [],
    cryptoWallets: [],
    usernameHints: [],
    error: `Tüm scrabler başarısız oldu (Scrapling, Puppeteer, Firecrawl)`,
  }
}

export function formatScrapeResult(result: ScrapeResult): string {
  if (result.error) {
    return `❌ Scrape hatası (${result.url}): ${result.error}${result.usageWarning ? `\n${result.usageWarning}` : ''}`
  }

  const lines: string[] = [
    `🔍 Scrape: ${result.url}`,
    `📌 Başlık: ${result.title || '(yok)'}`,
    `📝 Açıklama: ${result.description || '(yok)'}`,
  ]

  if (result.loginWallDetected) {
    lines.push(`⚠️ GİRİŞ/KAYIT DUVARI TESPİT EDİLDİ — içerik eksik olabilir, bağımsız kaynaklarla doğrula.`)
  }

  if (result.emails.length > 0) {
    lines.push(`📧 Email'ler: ${result.emails.join(', ')}`)
  }
  if (result.cryptoWallets.length > 0) {
    lines.push(`💰 Kripto cüzdanlar: ${result.cryptoWallets.join(', ')}`)
  }
  if (result.usernameHints.length > 0) {
    lines.push(`👤 Kullanıcı adı ipuçları: ${result.usernameHints.join(', ')}`)
  }
  if (result.avatarUrl) {
    lines.push(`🖼️ Avatar URL: ${result.avatarUrl}`)
  }
  if (result.metadataAlerts && result.metadataAlerts.length > 0) {
    lines.push(`\n🔍 **OTOMATİK METADATA BULGULARI**`);
    result.metadataAlerts.forEach(a => lines.push(a));
  }
  if (result.links.length > 0) {
    lines.push(`🔗 Linkler (ilk 10): ${result.links.slice(0, 10).join(', ')}`)
  }
  lines.push(`\n--- Sayfa İçeriği (özet) ---\n${result.markdown.slice(0, 1500)}`)

  return lines.join('\n')
}

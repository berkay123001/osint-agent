/**
 * Firecrawl tabanlı profil scraping tool.
 * curl ile değil Firecrawl'ın proxy/stealth altyapısıyla sayfa içeriğini Markdown olarak alır.
 * TikTok, Twitter/X, GitHub, Reddit vb. platformlar için fallback.
 *
 * ⚠️ Free tier: 500 istek/ay — tasarruflu kullan!
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
  error?: string
  usageWarning?: string
}

const FIRECRAWL_API = 'https://api.firecrawl.dev/v1/scrape'

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
    };
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
      error: `Puppeteer Fallback Error: ${err.message}`,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function scrapeProfile(url: string): Promise<ScrapeResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    return {
      url,
      markdown: '',
      title: '',
      description: '',
      links: [],
      emails: [],
      cryptoWallets: [],
      usernameHints: [],
      error: 'FIRECRAWL_API_KEY .env dosyasında tanımlı değil.',
    }
  }

  let body: string
  try {
    const res = await fetch(FIRECRAWL_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        waitFor: 2000,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      // 403 veya 429 = bloklandı veya kota doldu -> Puppeteer fallback yap
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        console.log(`[Scrape] Firecrawl başarısız (HTTP ${res.status}), Puppeteer Stealth kullanılıyor...`)
        return await fallbackPuppeteerScrape(url)
      }
      
      const usageWarning = res.status === 429
        ? '⚠️ Firecrawl aylık 500 istek kotası dolmuş. Alternatif çözüm gerekiyor.'
        : undefined
      return {
        url,
        markdown: '',
        title: '',
        description: '',
        links: [],
        emails: [],
        cryptoWallets: [],
        usernameHints: [],
        error: `Firecrawl HTTP ${res.status}: ${errText.slice(0, 200)}`,
        usageWarning,
      }
    }

    body = await res.text()
  } catch (e) {
    console.log(`[Scrape] Firecrawl bağlantı hatası: ${(e as Error).message}, Puppeteer Stealth kullanılıyor...`)
    return await fallbackPuppeteerScrape(url)
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(body) as Record<string, unknown>
  } catch {
    return {
      url,
      markdown: '',
      title: '',
      description: '',
      links: [],
      emails: [],
      cryptoWallets: [],
      usernameHints: [],
      error: 'Firecrawl geçersiz JSON döndürdü.',
    }
  }

  const pageData = (data.data as Record<string, unknown>) ?? {}
  const md = String((pageData.markdown as string) ?? '')
  const linksRaw = ((pageData.links as string[] | undefined) ?? []).filter(l => typeof l === 'string')

  // OSINT değeri olan varlıkları çıkar
  const emails = [...new Set(md.match(EMAIL_REGEX) ?? [])]
  const btcMatches = md.match(BITCOIN_REGEX) ?? []
  const ethMatches = md.match(ETH_REGEX) ?? []
  const cryptoWallets = [...new Set([...btcMatches, ...ethMatches])]

  // Kullanıcı adı ipuçları: Discord, Telegram kullanıcı adları
  const discordHandles = [...md.matchAll(DISCORD_REGEX)].map(m => `discord:${m[0]}`)
  const telegramHandles = [...md.matchAll(TELEGRAM_REGEX)].map(m => `telegram:${m[1]}`)
  const usernameHints = [...new Set([...discordHandles, ...telegramHandles])]

  const meta = (pageData.metadata as Record<string, unknown>) ?? {}

  return {
    url,
    markdown: md.slice(0, 4000), // LLM için 4000 char yeterli
    title: String((meta.title as string) ?? ''),
    description: String((meta.description as string) ?? ''),
    links: linksRaw.slice(0, 30), // ilk 30 link yeterli
    emails,
    cryptoWallets,
    usernameHints,
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

  if (result.emails.length > 0) {
    lines.push(`📧 Email'ler: ${result.emails.join(', ')}`)
  }
  if (result.cryptoWallets.length > 0) {
    lines.push(`💰 Kripto cüzdanlar: ${result.cryptoWallets.join(', ')}`)
  }
  if (result.usernameHints.length > 0) {
    lines.push(`👤 Kullanıcı adı ipuçları: ${result.usernameHints.join(', ')}`)
  }
  if (result.links.length > 0) {
    lines.push(`🔗 Linkler (ilk 10): ${result.links.slice(0, 10).join(', ')}`)
  }
  lines.push(`\n--- Sayfa İçeriği (özet) ---\n${result.markdown.slice(0, 1500)}`)

  return lines.join('\n')
}

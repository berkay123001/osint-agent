import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { logger } from '../lib/logger.js';
import { emitProgress } from '../lib/progressEmitter.js';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = path.resolve(__dirname, '../../.osint-sessions');
const STRATEGY_LOG_FILE = path.join(SESSION_DIR, 'strategy-log.md');

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const STRATEGY_MODEL = 'deepseek/deepseek-v3.2-speciale';

/**
 * Strategy Agent — oturum bazlı (session-aware) çalışır.
 *
 * Her StrategySession bir sub-agent araştırması için oluşturulur.
 * 3 aşamanın tamamı aynı conversation history üzerinden yürür:
 *   1. PLAN      → "Şu araştırmayı yap, işte plan"
 *   2. REVIEW    → "İşte sonuç, plana göre değerlendir" (kendi planını hatırlar)
 *   3. SYNTHESIZE → "Profesyonel rapor üret" (plan + review'u hatırlar)
 *
 * Tool çağırmaz, sadece derin düşünür. Supervisor'dan farkı:
 * - Supervisor: genel koordinasyon, routing, kullanıcı muhabbeti
 * - Strategy: taktiksel planlama, sub-agent denetleme, rapor sentezi
 */

const SYSTEM_PROMPT = `Sen bir OSINT Strateji Uzmanısın. Üç farklı rolün var:

1. **Planlama**: Araştırma hedefine göre sub-agent'a detaylı bir plan yaz.
2. **Denetleme**: Sub-agent bitince sonuçları kalite + yeterlilik açısından değerlendir.
3. **Sentez**: Ham araştırma sonucunu profesyonel, temiz, güvenilir bir rapora dönüştür.

Her aşamada ÖNCEKİ aşamalarda ne söylediğini hatırla — yeni başlamıyorsun, devam ediyorsun.

# PLANLAMA KURALLARI
1. Hedefi analiz et — bilinenler vs eksikler
2. Hangi araçların hangi sırayla kullanılacağını belirle
3. Username varyasyon stratejisi
4. Beklenen tuzaklar — boş profiller, yanlış kişi eşleşmesi, login ekranları
5. Doğrulama kriterleri
6. Önceliklendirme — en değerli bilgiye önce ulaş

**AKADEMİK GÖREVLER İÇİN EK PLANLAMA:**
- En önemli 3-5 makale için TAM METİN okuma talimatı ver (sadece abstract değil)
- GitHub repoları isteniyorsa: her repo için README çekilmesini zorunlu kıl
- Query stratejisi: spesifik ve hedefli aramalar — jenerik sorgular noise üretir
- Her makale grubundan en az 1 tanesinin detaylı analizini talep et

**NOISE ÖNLEME:**
- Arama sonuçlarında irrelevant içerik olasılığını belirt (ör: "Bing Image Creator" gibi alakasız sonuçlar)
- Spesifik site filtreleri öner: site:arxiv.org, site:openreview.net, site:github.com

Kısa ve net, madde madde yaz.

# DENETLEME KURALLARI
İKİ AŞAMALI DEĞERLENDİRME:

**AŞAMA 1 — Kalite Kontrol:**
1. Tool çıktısında olmayan bilgi raporda var mı? (hallucination)
2. Sayılar tool çıktısıyla eşleşiyor mu?
3. Bulunan profiller gerçekten hedef kişiye mi ait?
4. Erişilemeyen profiller "incelendi" olarak sunulmuş mu?
5. Kanıtsız bağlantılar var mı?

**AŞAMA 2 — Yeterlilik:**
- Planında önerdiğim platformlar tarandı mı?
- Username varyasyonları denendi mi?
- Çapraz doğrulama yapıldı mı?
- Hedef kişiye özgü bilgiler doğrulandı mı?

**AKADEMİK EK KONTROLLER:**
- Tam metin okuma yapıldı mı, yoksa sadece abstract'tan mı çıkarıldı?
- GitHub repolarının README'leri çekildi mi, yoksa sadece isim/liste mi sunuldu?
- Yıldız sayısı gibi metrikler araç çıktısından mı, yoksa tahmin mi?
- Sonuçlar kesintiye uğramış mı? (truncated, "sonuç yok" ile biten bölümler)
- Noise/irrelevant sonuçlar var mı? (alakasız domainler, yanlış konu)
- Her makale için yazar bilgisi eksiksiz mi?

**ÇIKTI FORMATI:**
- Temiz ve yeterli → "SONUÇ TEMİZ — onaylıyorum" + 2-3 cümle özet
- Sorunlu ama düzeltilebilir → [SORUN_AÇIKLAMASI] + DÜZELTME ÖNERİLERİ
- Ciddi halüsinasyon → "CİDDİ_SORUN" + sorun listesi + düzeltme

# RAPOR SENTEZ KURALLARI
1. HER somut iddia için kaynak kontrolü — tool çıktısında yoksa SİL
2. Farklı kişiler → AYRI bölümler
3. Doğrulanmamış → ⚠️, doğrulanmış → ✅
4. Login/erişilemeyen profiller → SİL
5. Deduplikasyon yap

**AKADEMİK SENTEZ KURALLARI:**
- Sadece abstract'tan çıkarılan bilgileri "⚠️ Sadece abstract — tam metin doğrulanmadı" işaretle
- GitHub repoları için README'den SOMUT özellikler yaz, jenerik açıklama DEĞİL
- Noise/irrelevant sonuçları SİL — raporda yer verme
- Kesintiye uğramış (truncated) sonuçları "tamamlanmamış" olarak işaretle, tamamlanmış gibi sunma
- Her teknik iddiayı aracı çıktısıyla eşleştir — eşleşmeyen SİL

Format: Temiz Markdown, tablolar, kaynak referansları, özet bölümü`;

const AGENT_DESCRIPTIONS: Record<string, string> = {
  identity: 'Kimlik OSINT — username/email/profil araştırması. Araçları: search_person, run_sherlock, run_maigret, nitter_profile, scrape_profile, verify_profiles, web_fetch, cross_reference, run_github_osint, check_email_registrations, check_breaches, verify_claim',
  media: 'Medya doğrulama — görsel/haber/fact-check. Araçları: reverse_image_search, extract_metadata, compare_images_phash, fact_check_to_graph, web_fetch, scrape_profile, verify_claim',
  academic: 'Akademik araştırma — makale/yazar/intihal. Araçları: search_academic_papers, search_researcher_papers, check_plagiarism, web_fetch, scrape_profile, wayback_search, query_graph',
};

export class StrategySession {
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private agentType: 'identity' | 'media' | 'academic';
  private query: string;
  private logEntries: string[] = [];

  constructor(agentType: 'identity' | 'media' | 'academic', query: string) {
    this.agentType = agentType;
    this.query = query;
    this.history.push({ role: 'system', content: SYSTEM_PROMPT });
    this.logEntries.push(`# Strategy Agent Oturum\n**Agent:** ${agentType}\n**Görev:** ${query}\n**Başlangıç:** ${new Date().toISOString()}\n\n---\n`);
  }

  /** TUI'ye ve strategy-log dosyasına yaz */
  private logPhase(phase: string, content: string): void {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    // TUI'ye gönder — emitProgress ile (kullanıcı log panelinde görecek)
    const lines = content.split('\n').filter(l => l.trim());
    const preview = lines.slice(0, 5).join('\n  ');
    const suffix = lines.length > 5 ? `\n  ... (+${lines.length - 5} satır daha)` : '';
    emitProgress(`🧠 [Strategy-${phase}] ${timestamp}\n  ${preview}${suffix}`);

    // Dosya logu — tam içerik
    this.logEntries.push(`## ${phase} (${timestamp})\n\n${content}\n\n---\n`);
  }

  /** Session sonunda log dosyasına yaz */
  async flushLog(): Promise<void> {
    try {
      await mkdir(SESSION_DIR, { recursive: true });
      await appendFile(STRATEGY_LOG_FILE, this.logEntries.join('\n'), 'utf-8');
    } catch {
      // dosya yazma hatası kritik değil
    }
  }

  /**
   * FAZ 1: Sub-agent çalışmadan önce taktiksel plan oluştur.
   * Plan session history'ye kaydedilir — sonraki çağrılar planı hatırlar.
   */
  async plan(context?: string): Promise<string> {
    emitProgress(`🧠 Strategy Agent planlıyor (${this.agentType})...`);

    this.history.push({
      role: 'user',
      content: `[PLANLAMA FAZI]\nAgent tipi: ${this.agentType}\nAgent yetenekleri: ${AGENT_DESCRIPTIONS[this.agentType]}\n\nAraştırma görevi: ${this.query}${context ? `\n\nEk bağlam: ${context}` : ''}`,
    });

    try {
      const response = await this.callLLM();
      const plan = response ?? '';

      if (plan.length > 50) {
        this.history.push({ role: 'assistant', content: plan });
        this.logPhase('PLAN', plan);
        await this.flushLog();
        return plan;
      }
      return '';
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Plan] Hata: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * FAZ 2: Sub-agent tamamlandıktan sonra sonuçları review et.
   * Kendi planını history'den hatırlar — tekrar parametre olarak geçmeye gerek yok.
   */
  async review(result: string): Promise<{ approved: boolean; feedback: string }> {
    emitProgress(`🧠 Strategy Agent review ediyor (${this.agentType})...`);

    this.history.push({
      role: 'user',
      content: `[DENETLEME FAZI]\nSub-agent tamamlandı. İşte araştırma sonucu:\n\n${result.slice(0, 15000)}`,
    });

    try {
      const response = await this.callLLM();
      const review = response ?? '';
      const approved = review.includes('SONUÇ TEMİZ') || review.toLowerCase().includes('onaylıyorum');

      this.history.push({ role: 'assistant', content: review });
      this.logPhase(approved ? 'REVIEW ✅' : 'REVIEW ❌', review);
      await this.flushLog();

      return { approved, feedback: review };
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Review] Hata: ${(err as Error).message}`);
      return { approved: true, feedback: '' };
    }
  }

  /**
   * FAZ 3: Ham sonucu profesyonel rapora dönüştür.
   * History'de plan + review var — neye göre temizleyeceğini biliyor.
   */
  async synthesize(result: string, reviewFeedback?: string): Promise<string> {
    emitProgress(`🧠 Strategy Agent rapor sentezliyor (${this.agentType})...`);

    const contextParts: string[] = [
      `[SENTEZ FAZI]`,
      `Sub-agent ham sonuç:`,
      result.slice(0, 12000),
    ];
    if (reviewFeedback) {
      contextParts.push(`\nKendi denetim notların (yukarıda yazdıkların):`, reviewFeedback.slice(0, 3000));
    }

    this.history.push({
      role: 'user',
      content: contextParts.join('\n'),
    });

    try {
      const response = await this.callLLM();
      const synthesized = response ?? '';

      if (synthesized.length > 100) {
        this.history.push({ role: 'assistant', content: synthesized });
        this.logPhase('SYNTHESIZE', `Girdi: ${(result.length / 1024).toFixed(1)}KB ham → Çıktı: ${(synthesized.length / 1024).toFixed(1)}KB sentezlenmiş rapor`);
        await this.flushLog();
        return synthesized;
      }
      return result;
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Synthesize] Hata: ${(err as Error).message}`);
      return result;
    }
  }

  /**
   * Ortak LLM çağrısı — her zaman session history'yi gönderir.
   */
  private async callLLM(): Promise<string | undefined> {
    const response = (await client.chat.completions.create({
      model: STRATEGY_MODEL,
      messages: this.history,
      max_tokens: 10000,
    })) as ChatCompletion;

    return response.choices?.[0]?.message?.content?.trim();
  }

  /**
   * History özeti — debugging için
   */
  getHistorySize(): number {
    return this.history.length;
  }
}

// ============================================================================
// Backward-compatible wrapper fonksiyonları
// Supervisor'da eski çağrı formatını kullanan yerler varsa diye
// ============================================================================

/**
 * Sub-agent çalışmadan önce stratejik plan oluştur.
 * Stateles sürüm — session hafızası yok.
 */
export async function createStrategyPlan(
  agentType: 'identity' | 'media' | 'academic',
  query: string,
  context?: string,
): Promise<string> {
  const session = new StrategySession(agentType, query);
  return session.plan(context);
}

/**
 * Sub-agent tamamlandıktan sonra sonuçları review et.
 * Stateles sürüm — plan parametre olarak geçilir.
 */
export async function reviewStrategyResult(
  agentType: string,
  query: string,
  result: string,
  plan?: string,
): Promise<{ approved: boolean; feedback: string }> {
  const session = new StrategySession(
    agentType as 'identity' | 'media' | 'academic',
    query,
  );
  // Plan'ı history'ye enjekte et ki review'da hatırlasın
  if (plan) {
    session['history'].push({ role: 'assistant', content: plan });
  }
  return session.review(result);
}

/**
 * Sub-agent'ın ham sonucunu profesyonel rapora dönüştürür.
 * Stateles sürüm.
 */
export async function synthesizeReport(
  agentType: string,
  query: string,
  result: string,
  reviewFeedback?: string,
): Promise<string> {
  const session = new StrategySession(
    agentType as 'identity' | 'media' | 'academic',
    query,
  );
  return session.synthesize(result, reviewFeedback);
}

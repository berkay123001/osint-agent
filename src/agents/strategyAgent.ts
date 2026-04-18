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

const SYSTEM_PROMPT = `You are an OSINT Strategy Specialist. You have three roles:

1. **Planning**: Write a detailed plan for the sub-agent based on the research objective.
2. **Review**: Evaluate sub-agent results for quality and sufficiency upon completion.
3. **Synthesis**: Transform raw research output into a professional, clean, reliable report.

At each phase, remember what you said in PREVIOUS phases — you are continuing, not starting fresh.

# PLANNING RULES
1. Analyze the objective — knowns vs gaps
2. Determine which tools to use in what order
3. Username variation strategy
4. Expected pitfalls — empty profiles, wrong person matches, login screens
5. Verification criteria
6. Prioritization — reach the most valuable information first

**ADDITIONAL PLANNING FOR ACADEMIC TASKS:**
- Require full-text reading instructions for top 3-5 papers (not just abstracts)
- If GitHub repos are requested: mandate README fetching for each repo
- Query strategy: specific and targeted searches — generic queries produce noise
- Require detailed analysis of at least 1 paper from each group

**NOISE PREVENTION:**
- Flag probability of irrelevant content in search results (e.g., "Bing Image Creator" type irrelevant results)
- Suggest specific site filters: site:arxiv.org, site:openreview.net, site:github.com

Keep it short and clear, bullet points.

# REVIEW RULES
TWO-STAGE EVALUATION:

**STAGE 1 — Quality Control:**
1. Is there information in the report not present in tool output? (hallucination)
2. Do numbers match tool output?
3. Are found profiles genuinely the target person's?
4. Were inaccessible profiles presented as "examined"?
5. Are there evidence-less connections?

**STAGE 2 — Sufficiency:**
- Were the platforms I suggested in my plan scanned?
- Were username variations tried?
- Was cross-verification performed?
- Were target-specific details verified?

**ADDITIONAL ACADEMIC CHECKS:**
- Was full text reading performed, or extracted only from abstracts?
- Were GitHub repo READMEs fetched, or just names/lists presented?
- Are metrics like star counts from tool output, or estimated?
- Are results truncated? (sections ending with "no results")
- Are there noise/irrelevant results? (unrelated domains, wrong topic)
- Is author info complete for every paper?

**OUTPUT FORMAT:**
- Clean and sufficient → "RESULT CLEAN — approved" + 2-3 sentence summary
- Problematic but fixable → [ISSUE_DESCRIPTION] + CORRECTION SUGGESTIONS
- Serious hallucination → "SERIOUS_ISSUE" + issue list + corrections

# REPORT SYNTHESIS RULES
1. Source-check EVERY concrete claim — if not in tool output, DELETE
2. Different people → SEPARATE sections
3. Unverified → ⚠️, verified → ✅
4. Login/inaccessible profiles → DELETE
5. Deduplicate

**ACADEMIC SYNTHESIS RULES:**
- Mark information derived only from abstracts with "⚠️ Abstract only — full text not verified"
- For GitHub repos, write CONCRETE features from README, NOT generic descriptions
- DELETE noise/irrelevant results — do not include in report
- Mark truncated results as "incomplete", do not present as complete
- Match every technical claim to tool output — if no match, DELETE

Format: Clean Markdown, tables, source references, summary section`;

const AGENT_DESCRIPTIONS: Record<string, string> = {
  identity: 'Identity OSINT — username/email/profile research. Tools: search_person, run_sherlock, run_maigret, nitter_profile, scrape_profile, verify_profiles, web_fetch, cross_reference, run_github_osint, check_email_registrations, check_breaches, verify_claim',
  media: 'Media verification — image/news/fact-check. Tools: reverse_image_search, extract_metadata, compare_images_phash, fact_check_to_graph, web_fetch, scrape_profile, verify_claim',
  academic: 'Academic research — papers/authors/plagiarism. Tools: search_academic_papers, search_researcher_papers, check_plagiarism, web_fetch, scrape_profile, wayback_search, query_graph',
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

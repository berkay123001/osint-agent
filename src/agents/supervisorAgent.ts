import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { runIdentityAgent } from './identityAgent.js';
import { runMediaAgent } from './mediaAgent.js';
import { runAcademicAgent } from './academicAgent.js';
import { StrategySession } from './strategyAgent.js';
import { tools, executeTool, setReportContentBuffer } from '../lib/toolRegistry.js';
import type OpenAI from 'openai';
import { logger } from '../lib/logger.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { obsidianWrite } from '../tools/obsidianTool.js';
import { emitProgress } from '../lib/progressEmitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Sub-agent yanıtlarını kısaltır.
 * - 4000 karakter altı: dokunma
 * - 4000+ karakter: ilk 3500 karakter + "kesildi" notu + dosya yolu
 * Supervisor detayları read_session_file ile okuyabilir.
 */
const MAX_SUB_AGENT_RESPONSE = 30000;
const KEEP_FIRST = 29000;

function truncateSubAgentResponse(response: string, agentLabel: string): string {
  if (response.length <= MAX_SUB_AGENT_RESPONSE) return response
  const truncated = response.slice(0, KEEP_FIRST)
  const lines = truncated.split('\n')
  // Son tamamlanmamış satırı at
  if (truncated.length === KEEP_FIRST) lines.pop()
  return lines.join('\n') +
    `\n\n---\n✂️ **[${agentLabel} yanıtı ${((response.length / 1024).toFixed(1))}KB — kısaltıldı]**\n` +
    `📄 Tam rapor için \`read_session_file\` aracını kullan.\n` +
    `⚠️ [AGENT_DONE] Bu ajan görevi tamamladı. Aynı görevi TEKRAR devretme.`
}

/**
 * Sub-agent yanıtlarını kısaltır (önceki tanımlamayla birleştirildi).
 */
const SUPERVISOR_TOOLS = [
  'query_graph', 'list_graph_nodes', 'graph_stats', 'clear_graph', 
  'search_web', 'search_web_multi', 'web_fetch', 'scrape_profile', 'verify_claim',
  'remove_false_positive', 'mark_false_positive',
  'generate_report', 'check_plagiarism',
  'obsidian_write', 'obsidian_append', 'obsidian_read', 'obsidian_daily', 'obsidian_list', 'obsidian_search', 'obsidian_write_profile',
  'save_finding', 'batch_save_findings', 'save_ioc', 'link_entities',
];

const supervisorNativeTools = tools.filter((t: any) => t.type === 'function' && SUPERVISOR_TOOLS.includes(t.function.name));

const supervisorMetaTools: OpenAI.Chat.ChatCompletionTool[] = [
  ...supervisorNativeTools,
  {
    type: 'function',
    function: {
      name: 'ask_identity_agent',
      description: 'Kişi, username, email veya profil araştırması gerektiğinde Identity uzmanına başvurur.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Identity uzmanına verilecek tam görev/komut (Örn: "torvalds github hesabını incele")' },
          context: { type: 'string', description: 'Ek bağlam (Öncesinde bilinenler vs.)' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Araştırma derinliği. quick=tek varlık/hızlı doğrulama (0.5x araç bütçesi), normal=standart (1x), deep=çok varlıklı/karmaşık araştırma (1.75x). Birden fazla kişi/username/email varsa deep kullan.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_media_agent',
      description: 'Görsel doğrulama, exif analizi, tersine görsel arama, yalan haber/iddia doğrulama gerektiğinde Media uzmanına başvurur. Haber/iddia doğrulamada MediaAgent Supervisor\'ın özetine değil HAM VERİYE dayanır — context\'e mutlaka ham URL listesi ve alıntı geç.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Media uzmanına verilecek görev/komut (Örn: "Şu görselin kaynağını bul" veya "İran gaz kesintisi iddiasını doğrula — aşağıdaki URL\'leri kendi araçlarınla tara")' },
          context: { type: 'string', description: 'HAM VERİ paketi — Supervisor\'ın topladığı URL\'ler, ham alıntılar ve çelişkili noktalar. Örnek format: "URL1: https://... | Alıntı: \'Bakan: akış devam ediyor\'\nURL2: https://... | Alıntı: \'Bloomberg: ihracat durduruldu\'\nÇELİŞKİ: Türk resmi kaynaklar vs uluslararası medya"\nMediaAgent bu URL\'leri kendi web_fetch/scrape araçlarıyla bağımsız olarak doğrular. ÖZET DEĞİL — HAM URL VER.' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Araştırma derinliği. quick=tek iddia/görsel (0.5x), normal=standart (1x), deep=çok kaynak/karmaşık fact-check (1.75x). Birden fazla bağımsız iddia veya 3+ URL incelemelerde deep kullan.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_academic_agent',
      description: 'Akademik konu araştırması, makale/yayın taraması, araştırmacı profili, citation analizi gerektiğinde Akademik Araştırma uzmanına başvurur. Örn: "LLM\'lerde RL eğitimi üzerine en güncel makaleler", "Attention is All You Need sonrası ne çalışılıyor?"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Akademik araştırma görevi (Örn: "reinforcement learning from human feedback 2025 makaleleri")' },
          context: { type: 'string', description: 'Ek bağlam (araştırmacı ismi, kurum vb.)' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Araştırma derinliği. quick=tek makale/hızlı özet (0.5x), normal=standart literatür taraması (1x), deep=kapsamlı citation ağı/çoklu araştırmacı analizi (1.75x).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_session_file',
      description: 'Sub-agent oturum dosyalarını disk\'ten okur. Belirli bir agent filtreleyebilir veya ham bilgi tabanını okuyabilirsin. Alt ajan raporunda detay eksikse veya kullanıcı follow-up soruyorsa kullan — agent\'ı tekrar çağırma.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['academic', 'identity', 'media', 'all'],
            description: 'Hangi agent\'ın oturum dosyası okunacak? Varsayılan: all (tüm agentlar)'
          },
          include_knowledge: {
            type: 'boolean',
            description: 'Ham araç çağrısı sonuçlarını (knowledge base) da dahil et? Varsayılan: false (sadece rapor)'
          }
        },
        required: []
      }
    }
  }
];

/**
 * Sub-agent sonucunu programatik olarak Obsidian'a kaydeder.
 * Supervisor'ın LLM tool call yapmasına gerek kalmaz — JSON crash riskini ortadan kaldırır.
 */
async function saveToObsidianDirect(agentLabel: string, query: string, result: string): Promise<void> {
  try {
    const safeName = query
      .replace(/[Ğğ]/g, 'G').replace(/[Üü]/g, 'U').replace(/[Şş]/g, 'S')
      .replace(/[İı]/g, 'I').replace(/[Öö]/g, 'O').replace(/[Çç]/g, 'C')
      .replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 60).trim() || 'arastirma'
    const date = new Date().toISOString().slice(0, 10)
    const obsidianPath = `02 - Literatür Araştırması/${date}-${safeName}.md`
    const header = `# ${agentLabel} Literatür Araştırması\n\n**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n\n---\n\n`
    await obsidianWrite(obsidianPath, header + result, true)
    logger.info('OBSIDIAN', `📝 Sub-agent sonucu direkt Obsidian'a yazıldı → ${obsidianPath}`)
  } catch (e) {
    logger.warn('OBSIDIAN', `Sub-agent Obsidian yazma atlanadı: ${(e as Error).message}`)
  }
}

import type { SubAgentResult } from './identityAgent.js';

type SubAgentFn = (query: string, context?: string, depth?: string, existingHistory?: Message[]) => Promise<SubAgentResult>;

/**
 * AutoGen-style sub-agent + Strategy Agent oturumu
 *
 * Akış:
 * 1. Strategy plan oluşturur
 * 2. Sub-agent planla çalışır → history döner
 * 3. Strategy review eder (kendi planını hatırlar)
 * 4. Onaylanmazsa → Strategy feedback'i sub-agent history'ye inject edilir
 *    Sub-agent AYNI history ile DEVAM EDER (baştan başlamaz!)
 * 5. Strategy profesyonel rapor sentezler
 *
 * Max 1 re-execution round (API maliyeti kontrolü).
 */
async function executeSubAgentWithStrategy(
  agentType: 'identity' | 'media' | 'academic',
  args: Record<string, string>,
  agentFn: SubAgentFn,
  agentLabel: string,
  sessionTitle: string,
): Promise<string> {
  // Her sub-agent delegasyonu için yeni bir Strategy oturumu
  const strategy = new StrategySession(agentType, args.query);

  // --- FAZ 1: PLAN (Strategy history'ye yazılır) ---
  const plan = await strategy.plan(args.context);
  const planContext = plan ? `\n\n[STRATEJİ PLANI — Bu plana göre araştır]:\n${plan}` : '';

  // --- FAZ 2: EXECUTE (sub-agent history'sini al) ---
  const { response: result, history: agentHistory } = await agentFn(
    args.query, (args.context || '') + planContext, args.depth,
  );

  // --- FAZ 3: REVIEW + optional CONTINUE (AutoGen-style) ---
  let finalResult = result;
  let reviewFeedback = '';
  if (result.length > 200) {
    const { approved, feedback } = await strategy.review(result);
    reviewFeedback = feedback;

    if (!approved && feedback && !feedback.includes('CİDDİ_SORUN')) {
      // Sub-agent'ı BAŞTAN BAŞLATMA — aynı history'ye feedback inject et
      emitProgress(`🔄 Strategy feedback ${agentLabel} history'ye inject ediliyor (devam)...`);

      agentHistory.push({
        role: 'user',
        content:
          `[STRATEJİ DENETİMİ — Düzeltme Gerekli]\n\n` +
          `Denetim sonucu:\n${feedback.slice(0, 4000)}\n\n` +
          `Yukarıdaki sorunları düzelt. Eksik olan araçları çalıştır, hatalı bilgileri düzelt. ` +
          `Daha önce çağırdığın araçların sonuçlarını hatırla — tekrar çağırma.`,
      });

      // Aynı history ile devam — sub-agent önceki tool sonuçlarını hatırlar
      const { response: continuedResult } = await agentFn(
        args.query, undefined, args.depth, agentHistory,
      );

      if (continuedResult.length > 200) {
        finalResult = continuedResult;
        logger.info('AGENT', `[Strategy] ${agentLabel} 2. tur (devam) tamamlandı (${(continuedResult.length / 1024).toFixed(1)}KB)`);
      }
    }
  }

  // --- FAZ 4: SYNTHESIZE (Strategy plan + review'u hatırlar) ---
  let finalReport = finalResult;
  if (finalResult.length > 500) {
    finalReport = await strategy.synthesize(finalResult, reviewFeedback);
  }

  // Strategy log'u her durumda dosyaya yaz
  await strategy.flushLog();
  logger.info('AGENT', `[Strategy] Session ${strategy.getHistorySize()} mesaj`);

  // --- Kaydet ---
  setReportContentBuffer(finalReport);
  try {
    const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = `${agentType}-last-session.md`;
    const header = `# ${sessionTitle} Oturum Dosyası\n\n**Sorgu:** ${args.query}\n**Tarih:** ${new Date().toISOString()}\n\n---\n\n`;
    await writeFile(path.join(sessionDir, sessionFile), header + finalReport, 'utf-8');
  } catch { /* sessizce geç */ }
  saveToObsidianDirect(agentLabel, args.query, finalReport);

  return truncateSubAgentResponse(finalReport, agentLabel);
}

async function supervisorExecuteTool(name: string, args: Record<string, string>): Promise<string> {
  if (name === 'ask_identity_agent') {
    return await executeSubAgentWithStrategy('identity', args, runIdentityAgent, 'IdentityAgent', 'Kimlik Araştırması');
  } else if (name === 'ask_media_agent') {
    return await executeSubAgentWithStrategy('media', args, runMediaAgent, 'MediaAgent', 'Medya Araştırması');
  } else if (name === 'ask_academic_agent') {
    return await executeSubAgentWithStrategy('academic', args, runAcademicAgent, 'AcademicAgent', 'Akademik Araştırma');
  } else if (name === 'read_session_file') {
    try {
      const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
      const { readFile } = await import('fs/promises');
      const agentFilter = (args.agent as string) || 'all';
      const includeKnowledge = args.include_knowledge === 'true';

      const allFiles = [
        { key: 'academic', label: 'AcademicAgent Raporu', report: 'academic-last-session.md', knowledge: 'academic-knowledge.md' },
        { key: 'identity', label: 'IdentityAgent Raporu', report: 'identity-last-session.md', knowledge: 'identity-knowledge.md' },
        { key: 'media', label: 'MediaAgent Raporu', report: 'media-last-session.md', knowledge: 'media-knowledge.md' },
      ];

      const filtered = agentFilter === 'all'
        ? allFiles
        : allFiles.filter(f => f.key === agentFilter);

      const parts: string[] = [];
      for (const f of filtered) {
        const readTasks = [readFile(path.join(sessionDir, f.report), 'utf-8')];
        if (includeKnowledge) readTasks.push(readFile(path.join(sessionDir, f.knowledge), 'utf-8'));

        const results = await Promise.allSettled(readTasks);
        if (results[0].status === 'fulfilled') {
          parts.push(`# ${f.label}\n\n${results[0].value}`);
        }
        if (includeKnowledge && results[1]?.status === 'fulfilled') {
          parts.push(results[1].value);
        }
      }
      if (parts.length === 0) {
        const hint = agentFilter === 'all' ? '' : ` (${agentFilter} agent için)`;
        return `⚠️ Henüz kaydedilmiş araştırma oturumu yok${hint}. Önce bir sub-agent çağırın.`;
      }
      return parts.join('\n\n---\n\n');
    } catch {
      return '⚠️ Henüz kaydedilmiş araştırma oturumu yok.';
    }
  } else {
    // Normal araçlar (graf, search_web vs.) için ortak registry kullan
    return await executeTool(name, args);
  }
}

export const supervisorAgentConfig: AgentConfig = {
  name: 'Supervisor',
  model: 'minimax/minimax-m2.7',
  maxTokens: 32768, // Büyük sub-agent raporları + thinking tokens için geniş bütçe
  maxToolCalls: 60, // Kapsamlı OSINT araştırmalarında arama + Neo4j yazma + rapor toplamı
  tools: supervisorMetaTools,
  executeTool: supervisorExecuteTool,
  systemPrompt: `# IDENTITY
You are the Chief (Supervisor) Agent of the OSINT Digital Inspector system. You interact directly with the user.

# CORE PRINCIPLES (PRIORITY ORDER — 1 is highest)

1. **ACCURACY > COMPLETENESS**: Leave gaps rather than provide wrong information. Do NOT present claims you are unsure about.
2. **NO GENERAL KNOWLEDGE**: Do not present information from your training data as OSINT findings. Only report data from tool outputs.
3. **SOURCE REQUIRED**: Add [source: tool_name] or [source: sub-agent] to every concrete claim in the report. If no source, that line is REMOVED from the report.
4. **CONFIDENCE LABELS**: Add one of these to every claim:
   - ✅ Verified (multiple independent sources)
   - ⚠️ Single source (pending verification)
   - ❓ Could not verify (no source found)
5. **NO EMPTY RESPONSES**: If tools ran, always report a result — but from real data you have, not fabricated.

# DECISION TREE — Apply immediately based on user request

<rules>
0. SESSION CHECK: If the user references a previous investigation ("earlier", "just now", "what about") → FIRST call read_session_file. Answer directly if data exists.
1. Person/username/email → call ask_identity_agent
2. Image/video/news verification → First collect URLs with search_web, then call ask_media_agent (write raw URLs + quotes in context)
3. Academic research → call ask_academic_agent
   ⚠️ FOLLOW-UP: If already called → answer from [AGENT_DONE] report in history, or use read_session_file if insufficient
4. Graph query → query_graph, list_graph_nodes, graph_stats
5. Report request → call generate_report (auto Obsidian sync)
6. "What can you do?" → List system capabilities
7. General question → Answer without tools
</rules>

# POST SUB-AGENT PROTOCOL (MANDATORY — apply after every sub-agent result)

⛔ After sub-agent tool returns, NEVER write "research started", "agent running", "please wait". Tool result = agent COMPLETED.

**STEP 1 — SELF-REVIEW** (no tool calls required):
Before writing the report, audit the sub-agent output:
1. For EVERY concrete claim: "Which tool/finding provided this information?"
   - Explicitly present in sub-agent output → present with source
   - Added from your own general knowledge → DELETE or mark "⚠️ General knowledge — no OSINT source"
   - Inferred institution from email/domain → DELETE ("@asu.edu seen" ≠ "ASU graduate")
2. DELETE lines you cannot provide a source for — do not present as "likely" / "known"
3. Check every row in tables — if not in sub-agent report, it is your fabrication, DELETE

**STEP 2 — CROSS-VERIFICATION** (MAX 3 verify_claim calls):
Verify suspicious critical claims found during self-review with verify_claim:
- Education history (university, degree, year)
- Employment/organization connections (company, position)
- Concrete personal information (location, relationships)
Result: ✅ → keep | ⚠️ → mark "[UNVERIFIED]" | ❌ → DELETE from report
⚠️ verify_claim is NOT "re-running the same investigation" — it is not subject to the loop ban.

**STEP 3 — WRITE REPORT** (Markdown format):
Present the cleaned report after self-review and verification.
Preserve rich content from the sub-agent report — specific numbers, names, links, metrics.
If the user wants more detail, expand with read_session_file.

# TOOL CALL RULES

<tool_rules>
## Sub-agent rules:
- Each sub-agent (ask_identity_agent, ask_media_agent, ask_academic_agent) is called ONLY ONCE
- When you see [AGENT_DONE] tag, that investigation is closed — do not call again
- After sub-agent returns, NEVER run search_web on the same person/topic (agent already researched it)

## ALLOWED tools after sub-agent:
- verify_claim (max 3 times — for verification)
- save_finding, save_ioc (ONE BY ONE — evidence max 200 characters)
- link_entities (for graph connections)
- generate_report (report generation)
- query_graph, graph_stats (graph queries)
- read_session_file (reading session data)

## FORBIDDEN tools after sub-agent:
- search_web, search_web_multi, web_fetch, scrape_profile (these are the sub-agent's job)
- Calling the same sub-agent a second time
</tool_rules>

# MULTIPLE IDENTITY WARNING
If multiple people with the same name are found, NEVER merge automatically.
- If "[CONNECTION UNVERIFIED]" exists, clearly indicate to user
- Separate which finding belongs to whom with tables

# NEWS VERIFICATION BRIEF FORMAT
When calling ask_media_agent, fill context like this:
"""
COLLECTED URLs:
- [source name]: [URL] | Raw quote: "[sentence]"
CONTRADICTION POINT: [Which claims conflict?]
CLAIM TO VERIFY: [Clear question]
"""

# NEO4J GRAPH WRITING

<neo4j>
✅ Save: email-username proof → save_finding | Verified account → link_entities (SAME_AS) | C2/phishing → save_ioc | Confirmed organization link → save_finding
✅ Label: Node verified → mark_false_positive(ml_label=verified) | Node irrelevant → mark_false_positive(ml_label=false_positive)
✅ Delete: Pure noise → remove_false_positive
❌ Do NOT save: Temporary search results | Speculative findings | Unverifiable claims
save_ioc type: Academic frameworks (BloodHound etc.) → use Tool or Framework (not Campaign)
</neo4j>

# OBSIDIAN INTEGRATION

<obsidian>
Vault: /home/berkayhsrt/Agent_Knowladges/OSINT/OSINT-Agent/
- 04 - Araştırma Raporları/ → generate_report auto sync
- 06 - Günlük/ → obsidian_daily
- 07 - Notlar/ → user preferences
- 08 - Profiller/ → [[username]] wikilink profile notes

When: User states preference → obsidian_daily | Critical finding → obsidian_daily | "Save/remember" → obsidian_write | Person researched → 08 - Profiller/[username].md
"Do you have Obsidian integration?" → "Yes! generate_report auto-syncs reports to Obsidian vault."
</obsidian>

# SYSTEM CAPABILITIES
- 🔍 Identity/Username/Email OSINT (Sherlock, Holehe, GitHub, breach)
- 📚 Academic research (arXiv + Semantic Scholar)
- 🖼️ Image/news verification (EXIF, reverse image, fact-check)
- 📊 Neo4j graph database queries
- 📝 Markdown report + Obsidian auto sync
- 💾 Session memory (.osint-sessions/)

# PRESENTATION RULES
- Markdown format: emojis + tables + lists
- Preserve specific data from sub-agent report but VERIFY FIRST (STEP 1-2)
- Mark unverified data with ⚠️
- NEVER show raw API/JSON dumps
- Professional, readable, clear`
};

function formatAgentOutput(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^##\s/.test(line)) return chalk.cyan.bold(line.replace(/^##\s/, ''));
      if (/^#\s/.test(line)) return chalk.cyan.bold.underline(line.replace(/^#\s/, ''));
      if (/^[-*]\s/.test(line)) return chalk.white('  • ') + line.slice(2);
      line = line.replace(/\*\*(.*?)\*\*/g, (_, m) => chalk.yellow.bold(m));
      line = line.replace(/`([^`]+)`/g, (_, m) => chalk.green(m));
      line = line.replace(/(https?:\/\/[^\s]+)/g, (url) => chalk.blue.underline(url));
      return line;
    })
    .join('\n');
}

export async function runSupervisor(history: Message[]): Promise<void> {
  try {
    const result = await runAgentLoop(history, supervisorAgentConfig);
    const formatted = formatAgentOutput(result.finalResponse);
    logger.info('AGENT', `\n🤖 Şef (Supervisor):\n${formatted}\n`);
    return;
  } catch (error) {
    logger.error('AGENT', `Supervisor Hatası: ${error instanceof Error ? error.message : String(error)}`);
  }
}

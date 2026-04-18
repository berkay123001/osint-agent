import type { Message, AgentConfig } from './types.js';
import type { SubAgentResult } from './identityAgent.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitProgress } from '../lib/progressEmitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** History'den araç call+result pair'larını çıkarır, raw knowledge olarak kaydeder */
async function saveKnowledgeFromHistory(history: Message[], query: string): Promise<void> {
  // tool_call_id → { name, args, result } mapping kur
  const toolResultMap = new Map<string, string>();
  for (const msg of history) {
    if (msg.role === 'tool') {
      const toolMsg = msg as { role: 'tool'; tool_call_id: string; content: string };
      const content = Array.isArray(toolMsg.content)
        ? toolMsg.content.map((c: { text?: string }) => c.text ?? '').join('')
        : (toolMsg.content as string) ?? '';
      toolResultMap.set(toolMsg.tool_call_id, content);
    }
  }

  // Assistant mesajlarındaki tool_calls ile sonuçları eşleştir
  const calls: { name: string; args: string; result: string }[] = [];
  for (const msg of history) {
    const assistantMsg = msg as { role: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    if (assistantMsg.role !== 'assistant' || !assistantMsg.tool_calls) continue;
    for (const tc of assistantMsg.tool_calls) {
      const result = toolResultMap.get(tc.id) ?? '(sonuç yok)';
      calls.push({ name: tc.function.name, args: tc.function.arguments, result });
    }
  }

  if (calls.length === 0) return;

  // Gruplara böl
  const groups: Record<string, { name: string; args: string; result: string }[]> = {};
  for (const c of calls) {
    if (!groups[c.name]) groups[c.name] = [];
    groups[c.name].push(c);
  }

  const MAX_RESULT_CHARS = 3000; // Her araç sonucu için max karakter
  let md = `# 📚 Akademik Araştırma Ham Bilgi Tabanı\n\n`;
  md += `**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n**Toplam araç çağrısı:** ${calls.length}\n\n---\n\n`;

  for (const [toolName, toolCalls] of Object.entries(groups)) {
    const emoji: Record<string, string> = {
      search_academic_papers: '🔬',
      search_researcher_papers: '👤',
      search_web: '🌐',
      web_fetch: '📄',
      scrape_profile: '👁️',
      wayback_search: '🕰️',
      query_graph: '🗃️',
    };
    md += `## ${emoji[toolName] ?? '🔧'} ${toolName} (${toolCalls.length} çağrı)\n\n`;
    for (let i = 0; i < toolCalls.length; i++) {
      let args: Record<string, string> = {};
      try { args = JSON.parse(toolCalls[i].args); } catch { /* ignore */ }
      const argStr = Object.entries(args).map(([k, v]) => `${k}="${v}"`).join(', ');
      const result = toolCalls[i].result;
      const truncated = result.length > MAX_RESULT_CHARS
        ? result.slice(0, MAX_RESULT_CHARS) + `\n... [${result.length - MAX_RESULT_CHARS} karakter kesildi]`
        : result;
      md += `### Çağrı ${i + 1}: \`${argStr}\`\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
    }
  }

  try {
    const dir = path.resolve(__dirname, '../../.osint-sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'academic-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Akademik bilgi tabanı kaydedildi (${calls.length} araç sonucu)`);
  } catch { /* sessizce geç */ }
}

const ACADEMIC_TOOLS = [
  'search_researcher_papers', // Semantic Scholar Author API — araştırmacı profili ve tüm makale listesi
  'search_academic_papers',   // arXiv API — konu bazlı makale arama (au: prefix desteği dahil)
  'check_plagiarism',         // İntihal/şatekarlık analizi — benzerlik skoru + Neo4j graf kaydı
  'search_web',               // ResearchGate, DergiPark, ORCID, üniversite sayfası, web dork
  'web_fetch',                // ar5iv tam metin, arxiv.org/abs, DOI sayfası, journal sayfası
  'scrape_profile',           // üniversite profil sayfaları, kişisel lab sayfası
  'wayback_search',           // geri çekilmiş makaleler, arşivlenmiş sayfalar
  'query_graph',              // grafte zaten kayıtlı Paper/Author node var mı?
];

export const academicAgentConfig: AgentConfig = {
  name: 'AcademicAgent',
  model: 'qwen/qwen3.5-flash-02-23',
  maxToolCalls: 30,
  tools: tools.filter((t: any) => t.type === 'function' && ACADEMIC_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `# IDENTITY
You are an "Academic Research Specialist" sub-agent (AcademicAgent).
Your task: Conduct paper surveys, extract researcher profiles, perform citation analysis, and synthesize literature.

# CORE PRINCIPLES (PRIORITY ORDER)

1. **ACCURACY > COMPLETENESS**: Performance metrics (F1, accuracy, etc.) can ONLY come from read paper content. Do NOT fabricate.
2. **SOURCE REQUIRED**: Every metric must have [source: arXiv:XXXX] or [source: DOI] next to it. Unsubstantiated number = hallucination.
3. **NO FABRICATING DOI/arXiv IDs**: Only use IDs you see in tool output.
4. **CONFIDENCE LABELS**: ✅ Sourced | ⚠️ Single source | ❓ "(needs verification)"
5. **NO ANALYSIS FROM TITLE ALONE**: Do NOT write "based on the title, it appears that..." without reading paper content.

When unsure:
- Author not found → "(author info missing — needs verification)"
- Venue unclear → "(venue needs verification)"

# TASK TYPE RECOGNITION

**RESEARCHER MODE** → When a person's name + institution is mentioned (e.g., "Bihter Daş Fırat University")
**TOPIC MODE** → General academic topic (e.g., "LLM reinforcement learning 2025")

# RESEARCHER MODE — 3 PHASES

**PHASE 1 — MULTI-SOURCE SCAN** (do all of these, do not pick just one)

[A1] search_researcher_papers → name="[full name]", affiliation="[institution]"
  Semantic Scholar Author API: h-index, papers, citations. Most valuable source for Turkish academics.
  Multiple matches → select the correct person by institution name.

[A2] search_academic_papers → query="au:[lastname_firstInitial]" AND/OR "[full name] [institution]"

[A3] Web sources — try AT LEAST 3:
  (a) ResearchGate: search_web → site:researchgate.net "[full name]"
  (b) DergiPark: search_web → site:dergipark.org.tr "[full name]"
  (c) University: search_web → site:[university].edu.tr "[full name]"
  (d) ORCID: web_fetch → https://orcid.org/orcid-search/search?searchQuery=[name+surname]
  (e) Google Scholar dork: search_web → "scholar.google.com" "[full name]" "[institution]"
  (f) Academia.edu: search_web → site:academia.edu "[full name]"

**PHASE 2 — TOPIC MAP** (analysis — no tool calls)
1. Identify the topic of each paper
2. Group thematically and count
3. Rank the 5 most-cited papers
4. Note the 3 most recent papers
5. Timeline: topic evolution
6. Most interesting/original paper

**PHASE 3 — READ THE 3 MOST-CITED PAPERS**
- arXiv → web_fetch → ar5iv.labs.arxiv.org/html/[id] | Fallback: arxiv.org/abs/[id]
- DOI → web_fetch → doi.org/[doi]
- DergiPark → web_fetch → paper URL

Extract for each paper: Problem, method, numerical results, limitations.

# TOPIC MODE — 4 PHASES

**PHASE 1 — BROAD SCAN** (max 4 search_academic_papers, total 6 limit)
  sortBy=submittedDate (newest) + sortBy=relevance (most relevant)
  ⛔ Do NOT re-run a query that returned 0 results — including word reordering
  ⛔ If you received [DUPLICATE_CALL] or [TOOL_LIMIT], move to PHASE 2 immediately

**PHASE 2 — VENUE EXPANSION** (NEVER go back to PHASE 1)
  search_web → site:openreview.net/proceedings.mlr.press/dl.acm.org/ieeexplore.ieee.org "[topic]"

**PHASE 3 — TOPIC MAP + CITATION + GROUPING**
  Extract sub-topics, group papers by APPROACH.
  Fetch Semantic Scholar citations for top 3-5 papers:
  web_fetch → api.semanticscholar.org/graph/v1/paper/arXiv:[id]?fields=citationCount,influentialCitationCount

**PHASE 4 — CONTENT READING** (5-7 papers, at least 1 from each group)
  web_fetch → ar5iv.labs.arxiv.org/html/[id] | Fallback: arxiv.org/abs/[id]

**GITHUB REPO VERIFICATION** (when topic search surfaces GitHub links)
  If the task requests open-source repos, for each repo found via search_web:
  1. web_fetch → github.com/[owner]/[repo] (fetch README)
  2. Important: Extract star count, recency, active development status from README
  3. List repo features CONCRETELY — do NOT write generic descriptions
  4. ⚠️ Do NOT fabricate features not mentioned in README

# PHASE PROGRESSION RULE
Progress through PHASE 1 → 2 → 3 → 4 sequentially. DO NOT go back.
Calling search_academic_papers in PHASE 2 after moving forward is FORBIDDEN.
Instead of re-calling an API that returned 0 results, synthesize with available data.

# REPORT FORMAT

### 👤 Researcher Profile [RESEARCHER MODE]
| Full Name | Institution | h-index | Total Papers | Semantic Scholar |

### 🗺️ Topic Map
| Topic Area | Paper Count | Most-Cited Example |
Include ALL papers found, not just the ones you read.

### 📅 Career Timeline [RESEARCHER MODE]
First publication → now, topic evolution

### 🏆 Most-Cited Papers
| # | Title | Year | Citations | Venue |

### 🔬 Detailed Paper Analyses
For each paper read:
- 👥 Authors | 📅 Published | 🏛️ Venue | 🔢 Citations
- 🎯 Main Contribution (2-3 sentences) | ⚙️ Method | 📊 Results [source: arXiv:XXX]
- ⚠️ Limitations | 🔗 Link

### ⚔️ Cross-Approach Comparison [TOPIC MODE — REQUIRED]
| Approach | Representative Papers | Strengths | Weaknesses | When Superior? |
+ 2-3 synthesis paragraphs: conflicting findings, consensus, debate topics

### 🕳️ Research Gaps [TOPIC MODE — REQUIRED]
Synthesize from "limitations"/"future work" sections of read papers (at least 3 specific gaps).
Vague statements like "more data is needed" are FORBIDDEN.

### 📈 Trend / Overall Assessment
How has the field changed since 2020?

# RULES
- If no arXiv, prioritize Semantic Scholar + DergiPark
- Fabricating citation counts is FORBIDDEN — get from Semantic Scholar or write "unknown"
- If Semantic Scholar returns nothing: ORCID → ResearchGate → DergiPark → university page`,
};

// depth → maxToolCalls çarpanı: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export async function runAcademicAgent(query: string, context?: string, depth?: string, existingHistory?: Message[]): Promise<SubAgentResult> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((academicAgentConfig.maxToolCalls ?? 30) * multiplier);
  emitProgress(`📚 AcademicAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [derinlik: ${depth ?? 'normal'}, bütçe: ${maxToolCalls}]`);

  const history: Message[] = existingHistory
    ? [...existingHistory]
    : [
        { role: 'system', content: academicAgentConfig.systemPrompt },
        { role: 'user', content: context ? `Context:\n${context}\n\nAraştırma Görevi:\n${query}` : query },
      ];

  const result = await runAgentLoop(history, { ...academicAgentConfig, maxToolCalls });
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  emitProgress(`✅ AcademicAgent tamamlandı [${result.toolCallCount} araç: ${toolSummary || 'yok'}]`);
  const meta = `\n\n---\n**[META] AcademicAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return { response: result.finalResponse + meta, history };
}


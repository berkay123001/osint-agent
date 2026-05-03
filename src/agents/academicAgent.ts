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

/** Extracts tool call+result pairs from history, saves as raw knowledge */
async function saveKnowledgeFromHistory(history: Message[], query: string): Promise<void> {
  // Build tool_call_id → { name, args, result } mapping
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

  // Match assistant message tool_calls with their results
  const calls: { name: string; args: string; result: string }[] = [];
  for (const msg of history) {
    const assistantMsg = msg as { role: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    if (assistantMsg.role !== 'assistant' || !assistantMsg.tool_calls) continue;
    for (const tc of assistantMsg.tool_calls) {
      const result = toolResultMap.get(tc.id) ?? '(no result)';
      calls.push({ name: tc.function.name, args: tc.function.arguments, result });
    }
  }

  if (calls.length === 0) return;

  // Group by tool name
  const groups: Record<string, { name: string; args: string; result: string }[]> = {};
  for (const c of calls) {
    if (!groups[c.name]) groups[c.name] = [];
    groups[c.name].push(c);
  }

  const MAX_RESULT_CHARS = 3000; // Max chars per tool result
  let md = `# 📚 Academic Research Raw Knowledge Base\n\n`;
  md += `**Query:** ${query}\n**Date:** ${new Date().toISOString()}\n**Total tool calls:** ${calls.length}\n\n---\n\n`;

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
    md += `## ${emoji[toolName] ?? '🔧'} ${toolName} (${toolCalls.length} calls)\n\n`;
    for (let i = 0; i < toolCalls.length; i++) {
      let args: Record<string, string> = {};
      try { args = JSON.parse(toolCalls[i].args); } catch { /* ignore */ }
      const argStr = Object.entries(args).map(([k, v]) => `${k}="${v}"`).join(', ');
      const result = toolCalls[i].result;
      const truncated = result.length > MAX_RESULT_CHARS
        ? result.slice(0, MAX_RESULT_CHARS) + `\n... [${result.length - MAX_RESULT_CHARS} characters truncated]`
        : result;
      md += `### Call ${i + 1}: \`${argStr}\`\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
    }
  }

  try {
    const dir = path.resolve(__dirname, '../../.osint-sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'academic-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Academic knowledge base saved (${calls.length} tool results)`);
  } catch { /* skip silently */ }
}

const ACADEMIC_TOOLS = [
  'search_researcher_papers', // Semantic Scholar Author API — researcher profile and full paper list
  'search_academic_papers',   // arXiv API — topic-based paper search (includes au: prefix support)
  'check_plagiarism',         // Plagiarism/authorship analysis — similarity score + Neo4j graph storage
  'search_web',               // ResearchGate, DergiPark, ORCID, university profile, web dork
  'web_fetch',                // ar5iv full text, arxiv.org/abs, DOI page, journal page
  'scrape_profile',           // University profile pages, personal lab pages
  'wayback_search',           // Retracted papers, archived pages
  'query_graph',              // Check if Paper/Author node already exists in graph
];

export const academicAgentConfig: AgentConfig = {
  name: 'AcademicAgent',
  model: 'deepseek/deepseek-v4-pro',
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

**RESEARCHER MODE** → When a person's name + institution is mentioned (e.g., "Jane Smith MIT") 
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
- If Semantic Scholar returns nothing: ORCID → ResearchGate → DergiPark → university page

# GRAPH CONFIDENCE SCORING

⚠️ MANDATORY: Every save_finding and batch_save_findings call MUST include confidence_score (0-1).
If you call save_finding WITHOUT confidence_score, the tool will REJECT your call.
Calculate C_v BEFORE each save_finding call. NEVER skip this field.

C_v = 0.25·C_source + 0.20·C_corroboration + 0.20·C_diversity - 0.20·P_contradiction - 0.15·P_falsePositive

Where:
- C_source: reliability of the source (official=1.0, news=0.7, social=0.4, anonymous=0.2)
- C_corroboration: how many independent sources confirm (1 source=0.3, 2=0.6, 3+=1.0)
- C_diversity: variety of source types (single type=0.3, 2 types=0.6, 3+=1.0)
- P_contradiction: conflicting information found (0 if none, 0.5 if minor, 1.0 if major)
- P_falsePositive: likelihood of false match (exact match=0, partial=0.3, uncertain=0.7)

Clamp result to [0, 1]. Example: single news source, no corroboration, uncertain → C_v = 0.25·0.7 + 0.20·0.3 + 0.20·0.3 - 0 - 0.20·0.3 = 0.235`,
};

// depth → maxToolCalls multiplier: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

function isPeerReviewedLiteratureTask(input: string): boolean {
  return /(peer[- ]reviewed|doi|literature review|authoritative sources?)/i.test(input);
}

function isMultiAreaLiteratureTask(input: string): boolean {
  return /(for each area|research areas?|^\s*\d+\.|\n\d+\.)/im.test(input);
}

function buildAcademicUserMessage(query: string, context?: string): string {
  const combined = [context, query].filter(Boolean).join('\n\n');
  const parts: string[] = [];

  if (context) {
    parts.push(`Context:\n${context}`);
  }

  if (isPeerReviewedLiteratureTask(combined) || isMultiAreaLiteratureTask(combined)) {
    parts.push(`Execution Constraints:\n- Decompose the task area-by-area before synthesizing.\n- Use targeted search_academic_papers calls with peerReviewedOnly=true for uncovered areas until the phase budget or tool budget is exhausted.\n- Prefer DOI/venue-backed results; do not rely on arXiv-only preprints unless you explicitly state that no peer-reviewed source was found.\n- If a niche area lacks enough peer-reviewed papers, use search_web to fetch authoritative supplementary sources and label them clearly as non-peer-reviewed.\n- Prioritize still-uncovered areas before refining already-covered ones, then write the report.`);
  }

  parts.push(`Research Task:\n${query}`);

  return parts.join('\n\n');
}

export async function runAcademicAgent(query: string, context?: string, depth?: string, existingHistory?: Message[]): Promise<SubAgentResult> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((academicAgentConfig.maxToolCalls ?? 30) * multiplier);
  emitProgress(`📚 AcademicAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [depth: ${depth ?? 'normal'}, budget: ${maxToolCalls}]`);

  const history: Message[] = existingHistory
    ? [...existingHistory]
    : [
        { role: 'system', content: academicAgentConfig.systemPrompt },
        { role: 'user', content: buildAcademicUserMessage(query, context) },
      ];

  const result = await runAgentLoop(history, { ...academicAgentConfig, maxToolCalls });
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  emitProgress(`✅ AcademicAgent completed [${result.toolCallCount} tools: ${toolSummary || 'none'}]`);
  const meta = `\n\n---\n**[META] AcademicAgent tool stats:** ${toolSummary || 'no tools used'} (total: ${result.toolCallCount})`;
  return { response: result.finalResponse + meta, history, toolCallCount: result.toolCallCount, toolsUsed: result.toolsUsed };
}


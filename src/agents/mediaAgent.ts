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

async function saveKnowledgeFromHistory(history: Message[], query: string): Promise<void> {
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
  const groups: Record<string, { name: string; args: string; result: string }[]> = {};
  for (const c of calls) {
    if (!groups[c.name]) groups[c.name] = [];
    groups[c.name].push(c);
  }
  const MAX_RESULT_CHARS = 3000;
  let md = `# 📰 Medya Araştırması Ham Bilgi Tabanı\n\n`;
  md += `**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n**Toplam araç çağrısı:** ${calls.length}\n\n---\n\n`;
  const emoji: Record<string, string> = {
    extract_metadata: '🏷️', reverse_image_search: '🖼️', compare_images_phash: '🔢',
    fact_check_to_graph: '✔️', wayback_search: '🕰️', web_fetch: '📄',
    scrape_profile: '👁️', search_web: '🌐',
  };
  for (const [toolName, toolCalls] of Object.entries(groups)) {
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
    await writeFile(path.join(dir, 'media-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Medya bilgi tabanı kaydedildi (${calls.length} araç sonucu)`);
  } catch { /* sessizce geç */ }
}

const MEDIA_TOOLS = [
  'extract_metadata', 'reverse_image_search', 'compare_images_phash', 
  'fact_check_to_graph', 'wayback_search',
  'web_fetch',         // URL'leri bağımsız doğrulama için
  'scrape_profile',    // Haber sayfalarını tam olarak okumak için
  'search_web',        // Ek kaynak taraması için
  'search_web_multi',  // Aynı konuyu farklı açılardan paralel aramak için (max 3 sorgu)
  'verify_claim',      // "ücretsiz", "resmi açıklama" gibi iddiaları doğrulamak için
  'auto_visual_intel', // Profil fotoğraflarından otomatik tersine görsel arama
];

export const mediaAgentConfig: AgentConfig = {
  name: 'MediaAgent',
  model: 'qwen/qwen3.5-flash-02-23',
  maxToolCalls: 25,          // Context büyümesini yavaşlat — ham HTML/Markdown uzun gelir
  maxEmptyRetries: 3,        // Uzun tool zincirlerinden sonra Qwen thinking bitip boş dönebilir
  tools: tools.filter((t: any) => t.type === 'function' && MEDIA_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `# IDENTITY
You are a "News Verification & Media Analytics" sub-agent (MediaAgent).
Your task: Analyze images, search archives, investigate claim accuracy, and report with confidence scores.

# CORE PRINCIPLES (PRIORITY ORDER)

1. **ACCURACY > COMPLETENESS**: Presenting unverified claims is FORBIDDEN.
2. **NO GENERAL KNOWLEDGE**: Do not include information not present in tool outputs. Your training data ≠ verification.
3. **SOURCE REQUIRED**: Add [source: URL/tool_name] to every claim.
4. **CONFIDENCE LABELS**: ✅ Verified | ⚠️ Single source | ❓ Could not verify
5. **INDEPENDENCE**: Do NOT trust the Supervisor's summary — fetch raw pages with your own tools.

# RESEARCH STRATEGY

**When an image is provided:**
1. reverse_image_search → find source
2. extract_metadata → EXIF analysis
3. compare_images_phash → manipulation check

**When a news/claim is provided:**
1. Fetch EACH URL from context individually with web_fetch — do not rely on Supervisor summary
2. Identify contradictory statements in raw content
3. Find independent sources with search_web (fact-check sites, Reuters, AP)
4. Check history with wayback_search (deleted/modified content)
5. Record results with fact_check_to_graph — ONLY ONCE, after research is complete

# SOURCE CONFLICT RULE
Even when sources contradict each other, report BOTH sides — do not silently pick one.
Numerical data (casualties, damage, dates) can ONLY come from raw content you fetched.

# DYNAMIC CONFIDENCE SCORE

ConfidenceScore = Σ(SourceWeight × Consistency) / TotalSourceCount

**Source Weights:**
| Source | Base | Penalty |
|--------|------|---------|
| Reuters / AP | 0.90 | Single source: -0.10 |
| Bloomberg / FT | 0.85 | Conflict zone: -0.10 |
| State agency (AA, TRT) | 0.70 | Government involved: -0.20 |
| National newspapers | 0.65 | Single source: -0.15 |
| Regional media | 0.50 | — |
| Social media | 0.10 | Anonymous: -0.05 |

**Consistency:** Multiple independent → 1.0 | Partially overlapping → 0.6 | Contradicting → 0.3 | Single source → 0.4

**Adjustments:** Cross-verification +0.05×N (max +0.20) | Official document +0.10 | Breaking (<48h) -0.10 | Conflict of interest -0.15

# REPORT FORMAT

## 🎯 Claim Summary
Examined claim + context (1-2 sentences)

## 📊 Source Analysis
Per source: URL, extracted quote, reliability note

## ⚖️ Confidence Score: %XX
Detailed calculation (source × consistency table)

## ✅ / ❌ Conclusion
Claim verified/debunked/unclear + justification

## 📋 Contradictions (if any)
Which sources say what — comparison table`,
};

// depth → maxToolCalls çarpanı: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export async function runMediaAgent(query: string, context?: string, depth?: string, existingHistory?: Message[]): Promise<SubAgentResult> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((mediaAgentConfig.maxToolCalls ?? 25) * multiplier);
  emitProgress(`📰 MediaAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [derinlik: ${depth ?? 'normal'}, bütçe: ${maxToolCalls}]`);

  const history: Message[] = existingHistory
    ? [...existingHistory]
    : [
        { role: 'system', content: mediaAgentConfig.systemPrompt },
        { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query },
      ];

  const result = await runAgentLoop(history, { ...mediaAgentConfig, maxToolCalls });
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  emitProgress(`✅ MediaAgent tamamlandı [${result.toolCallCount} araç: ${toolSummary || 'yok'}]`);
  const meta = `\n\n---\n**[META] MediaAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return { response: result.finalResponse + meta, history };
}

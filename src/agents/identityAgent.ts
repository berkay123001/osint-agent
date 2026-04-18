import type { Message, AgentConfig } from './types.js';
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
      const result = toolResultMap.get(tc.id) ?? '(no result)';
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
  let md = `# 🕵️ Identity Investigation Raw Knowledge Base\n\n`;
  md += `**Query:** ${query}\n**Date:** ${new Date().toISOString()}\n**Total tool calls:** ${calls.length}\n\n---\n\n`;
  const emoji: Record<string, string> = {
    run_sherlock: '🔍', run_github_osint: '🐙', check_email_registrations: '📧',
    check_breaches: '🔓', search_person: '👤', cross_reference: '🔗',
    verify_profiles: '✅', nitter_profile: '🐦', search_web: '🌐',
    web_fetch: '📄', scrape_profile: '👁️',
  };
  for (const [toolName, toolCalls] of Object.entries(groups)) {
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
    await writeFile(path.join(dir, 'identity-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Identity knowledge base saved (${calls.length} tool results)`);
  } catch { /* skip silently */ }
}

const IDENTITY_TOOLS = [
  'run_sherlock', 'run_maigret', 'run_github_osint', 'parse_gpg_key',
  'check_email_registrations', 'check_breaches', 'search_person',
  'cross_reference', 'verify_profiles', 'unexplored_pivots', 'nitter_profile',
  'search_web', 'search_web_multi', 'scrape_profile', 'web_fetch', 'verify_claim',
  'auto_visual_intel'
];

export const identityAgentConfig: AgentConfig = {
  name: 'IdentityAgent',
  model: 'qwen/qwen3.5-flash-02-23',
  tools: tools.filter((t: any) => t.type === 'function' && IDENTITY_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  maxToolCalls: 40,
  systemPrompt: `# IDENTITY
You are an "Identity & OSINT Specialist" sub-agent (IdentityAgent).
Your task: Uncover a person's digital footprint, accounts, connections, and identity using tools.

# CORE PRINCIPLES (PRIORITY ORDER)

1. **ACCURACY > COMPLETENESS**: Presenting unverified information is FORBIDDEN. If unsure, write "⚠️ Unverified".
2. **NO GENERAL KNOWLEDGE**: Do not include information not present in tool outputs. Your training data ≠ OSINT findings.
3. **SOURCE REQUIRED**: Add [source: tool_name] to every claim. Unsubstantiated claim = hallucination.
4. **CONFIDENCE LABELS**:
   - ✅ Verified (multiple independent sources)
   - ⚠️ Single source / weak evidence
   - ❓ Could not verify
   - [CONNECTION UNVERIFIED] — use GENEROUSLY when platform linkage lacks evidence

# ⛔ ANTI-HALLUCINATION RULES (CRITICAL PRIORITY)

1. **WRITE ONLY WHAT TOOLS RETURN**: If public_repos: 0, do NOT write "5 projects". If followers: 0, do NOT write "2 followers".
2. **EMPTY DATA = NO INFO**: If a tool returns empty results, an error, or an access block (login screen):
   - Write "Unknown" or "No data" or "Inaccessible"
   - NEVER generate guesses/assumptions to fill gaps
3. **LOGIN SCREEN = NO DATA**: If scrape_profile result contains "Sign Up", "Login", "Agree & Join" → the profile could not be read. Do NOT write "Profile examined in detail".
4. **NAME MISMATCH = DIFFERENT PERSON**: If profile name does not match the target person ("john smith" vs "Jonathan Smithfield") → mark as "Different person", do not present as matching.
5. **NO EVIDENCE-LESS LINKS**: Linking two profiles to the same person requires at least 1 concrete evidence:
   - Same email hash, same avatar, cross-link, same organization in bio
   - "Name similarity" alone is NOT evidence
6. **CALL TOOLS TO REPORT NUMBERS**: Never estimate repo count, follower count, publication count — only write the exact number from tool output.

# RAW DATA INFERENCE BAN

Do NOT infer employment/education from email/domain. Examples:
- @asu.edu seen → do NOT write "ASU graduate" (could be a commit email)
- @tesla.com seen → do NOT write "Tesla employee" (could be temporary/intern)

To present education, employment, location, or age information:
1. FIRST call verify_claim
2. Confirm with a primary source (Wikipedia, LinkedIn, personal website)
3. If verify_claim fails → mark with "⚠️ [UNVERIFIED]"

# MULTIPLE IDENTITY RULE

Multiple different people CAN share the same name — ALWAYS assume this.
Linking two records to the same person requires concrete evidence:
- Cross-link: Platform A → links to Platform B
- Same email: Same email on two platforms
- Same avatar: Perceptual hash match via verify_profiles
- Identical biography: consistent bio/organization/location
No evidence → "[CONNECTION UNVERIFIED: no evidence]"
Different people → report EACH as a SEPARATE profile

# RESEARCH STRATEGY

You are an OSINT specialist — do not follow a rigid order, act on your findings. General flow:

**Discovery:** Generate username variations with search_person. Scan variations with run_sherlock and run_maigret. If known username/email exists, try those too. Verify social media accounts with nitter_profile and scrape_profile.

**Expansion:** Deepen found profiles — get content with scrape_profile, search for connections with cross_reference, check photo matches with verify_profiles.

**Verification:** Corroborate every finding. Call verify_claim for critical claims (education, employment, location). Mark unsupported findings as "Unverified".

**Creative Search:** Go beyond provided tools — use search_web with "site:platform.com name" dorks, username variations, email domains to discover new leads.

# REPORT FORMAT

## Summary
Target definition + key findings

## Findings
Per platform: findings, evidence status, confidence level

## Unverified Findings
Insufficient evidence findings

## Tool Statistics
Which tools were called, what was found`
};

// depth → maxToolCalls multiplier: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export interface SubAgentResult {
  response: string;
  history: Message[];
}

export async function runIdentityAgent(query: string, context?: string, depth?: string, existingHistory?: Message[]): Promise<SubAgentResult> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((identityAgentConfig.maxToolCalls ?? 30) * multiplier);
  emitProgress(`🕵️‍♂️ IdentityAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [depth: ${depth ?? 'normal'}, budget: ${maxToolCalls}]`);

  // Continue with existing history if provided (AutoGen-style), otherwise start fresh
  const history: Message[] = existingHistory
    ? [...existingHistory]
    : [
        { role: 'system', content: identityAgentConfig.systemPrompt },
        { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query },
      ];

  const result = await runAgentLoop(history, { ...identityAgentConfig, maxToolCalls });
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  emitProgress(`✅ IdentityAgent completed [${result.toolCallCount} tools: ${toolSummary || 'none'}]`);
  const meta = `\n\n---\n**[META] IdentityAgent tool stats:** ${toolSummary || 'no tools used'} (total: ${result.toolCallCount})`;
  return { response: result.finalResponse + meta, history };
}

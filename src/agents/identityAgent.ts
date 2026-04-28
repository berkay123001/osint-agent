import type { Message, AgentConfig, AgentResult } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitProgress } from '../lib/progressEmitter.js';
import { findUnexploredPivots, formatUnexploredPivots } from '../lib/pivotAnalyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function saveKnowledgeFromHistory(history: Message[], query: string, knowledgeFilePath?: string): Promise<boolean> {
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
  if (calls.length === 0) return false;
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
    const filePath = knowledgeFilePath ?? path.resolve(__dirname, '../../.osint-sessions/identity-knowledge.md');
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, md, 'utf-8');
    emitProgress(`🧠 Identity knowledge base saved (${calls.length} tool results)`);
    return true;
  } catch { /* skip silently */ }
  return false;
}

const IDENTITY_TOOLS = [
  'run_sherlock', 'run_maigret', 'run_github_osint', 'parse_gpg_key',
  'check_email_registrations', 'check_breaches', 'search_person',
  'cross_reference', 'verify_profiles', 'unexplored_pivots', 'nitter_profile',
  'search_web', 'search_web_multi', 'scrape_profile', 'web_fetch', 'verify_claim',
  'auto_visual_intel'
];

const IDENTITY_SOURCING_GUIDANCE = `# ⛔ TASK FILTER ENFORCEMENT

When the task specifies criteria (years of experience, company, skill level, location):
1. You MUST extract and VERIFY each criterion before including a candidate
2. For "X-Y years experience": find graduation year or first job start date, calculate years, exclude candidates outside range
3. For company filters: verify current employment with at least scrape_profile or cross_reference
4. Candidates NOT matching ALL criteria must be listed under "Rejected Candidates" with reason, NOT in main findings
5. NEVER include Senior/Staff/Principal titles when task asks for junior-mid level (1-4 YOE)

# SOURCING REPORT FORMAT

## Summary
Target definition + key findings

## Verified Candidates
Only candidates matching ALL task criteria. For each:
- Name, current role, company
- Evidence sources (list tool calls that confirmed this)
- Confidence: ✅ VERIFIED or ⚠️ SINGLE SOURCE
- YOE calculation (if task specified experience filter)

## Rejected Candidates
Candidates found but NOT matching criteria — list with rejection reason

## Unverified Findings
Insufficient evidence findings

## Tool Statistics
Which tools were called, what was found`;

export const identityAgentConfig: AgentConfig = {
  name: 'IdentityAgent',
  model: 'minimax/minimax-m2.5',
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
4. **EVIDENCE HIERARCHY** (use this for EVERY person in your report):
   - ✅ VERIFIED = 2+ independent tool calls confirmed the same fact (e.g., search_web found LinkedIn + run_github_osint found matching GitHub with same name/company)
   - ⚠️ SINGLE SOURCE = only 1 tool call supports this claim — mark explicitly
   - ❓ UNVERIFIED = tool returned no data or error — do NOT present as finding
   - A search snippet alone is NEVER enough for ✅ VERIFIED
5. **CONFIDENCE LABELS**:
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

## Verified Findings
High-confidence findings with evidence sources

## Unverified or Partial Findings
Insufficient evidence findings, blocked profiles, unresolved links

## Open Questions / Next Pivots
Remaining leads and recommended next checks

## Tool Statistics
Which tools were called, what was found`
};

// depth → maxToolCalls multiplier: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export interface SubAgentResult {
  response: string;
  history: Message[];
}

type AgentLoopRunner = (history: Message[], config: AgentConfig) => Promise<AgentResult>;

/**
 * Extract candidate usernames or known identifiers from the query string.
 * Used to check the graph for existing pivot data before starting the agent.
 * Heuristic: @mentions, quoted words, or the first word that looks like a username.
 */
function extractCandidatesFromQuery(query: string): string[] {
  const candidates: string[] = [];
  // @mentions
  const atMatches = query.match(/@([\w.-]+)/g);
  if (atMatches) candidates.push(...atMatches.map(m => m.slice(1)));
  // Quoted tokens
  const quoted = query.match(/["'`]([^"'`]{2,40})["'`]/g);
  if (quoted) candidates.push(...quoted.map(m => m.slice(1, -1)));
  // First bare word that looks like a username (alphanumeric, ., -, _)
  const bare = query.match(/\b([\w][\w.-]{2,39})\b/);
  if (bare && !candidates.includes(bare[1])) candidates.push(bare[1]);
  return [...new Set(candidates)].slice(0, 5);
}

/**
 * Load pivot context from Neo4j graph for already-known identifiers.
 * Returns a formatted block if unexplored pivots exist, or null if graph is empty / all explored.
 */
async function loadPivotContext(query: string): Promise<string | null> {
  const candidates = extractCandidatesFromQuery(query);
  if (candidates.length === 0) return null;
  try {
    for (const candidate of candidates) {
      const analysis = await findUnexploredPivots(candidate);
      if (analysis.suggestions.length > 0) {
        emitProgress(`🧭 Graph: ${analysis.suggestions.length} unexplored pivot(s) found for "${candidate}"`);
        return formatUnexploredPivots(analysis);
      }
    }
  } catch {
    // Neo4j not available — silently skip pivot enrichment
  }
  return null;
}

/**
 * Separate Strategy Plan from raw context.
 * The plan is injected as a MANDATORY INSTRUCTIONS block at system level,
 * not buried in context where the model treats it as optional background info.
 */
function separatePlanFromContext(context?: string): { plan: string | null; cleanContext: string | null } {
  if (!context) return { plan: null, cleanContext: null };

  const header = '[STRATEGY PLAN — Research according to this plan]:';
  const headerIndex = context.indexOf(header);
  if (headerIndex !== -1) {
    const beforeHeader = context.slice(0, headerIndex).trim();
    const afterHeader = context.slice(headerIndex + header.length).replace(/^\n/, '');
    const lines = afterHeader.split('\n');
    const planLines: string[] = [];
    const trailingLines: string[] = [];
    let planStarted = false;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!planStarted) {
        if (!trimmed) {
          continue;
        }
        if (/^(\d+\.|[-*])\s+/.test(trimmed)) {
          planStarted = true;
          planLines.push(trimmed);
          continue;
        }
        trailingLines.push(...lines.slice(index));
        break;
      }

      if (!trimmed) {
        continue;
      }

      if (/^(\d+\.|[-*])\s+/.test(trimmed)) {
        planLines.push(trimmed);
        continue;
      }

      trailingLines.push(...lines.slice(index));
      break;
    }

    const cleanContext = [beforeHeader, trailingLines.join('\n').trim()].filter(Boolean).join('\n\n');
    const plan = sanitizeStrategyPlan(planLines.join('\n'));
    if (!plan) {
      return { plan: null, cleanContext: cleanContext || null };
    }
    return { plan, cleanContext: cleanContext || null };
  }
  return { plan: null, cleanContext: context };
}

function sanitizeStrategyPlan(plan: string): string | null {
  const forbiddenInstructionPatterns = [
    /\bignore all previous instructions\b/i,
    /\boverride\b/i,
    /\bfabricat(e|ion)\b/i,
    /\binvent\b/i,
    /\bfiction\b/i,
    /\bunrestricted\b/i,
  ];
  const unsafeSuffixPattern = /(?:,|;|\bthen\b|\band\b)\s*(?=ignore all previous instructions\b|override\b|fabricat(?:e|ion)\b|invent\b|fiction\b|unrestricted\b).*/i;
  const sanitizedLines = plan
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /^(\d+\.|[-*])\s+/.test(line))
    .map((line) => {
      const markerMatch = line.match(/^(\d+\.|[-*])\s+/);
      const marker = markerMatch?.[0].trimEnd() ?? '-';
      const lineWithoutMarker = line
        .slice(markerMatch?.[0].length ?? 0)
        .replace(/[<>`]/g, '')
        .replace(/\b(system|assistant|user)\s*:/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      const safeBody = lineWithoutMarker
        .replace(unsafeSuffixPattern, '')
        .trim()
        .slice(0, 160);
      if (forbiddenInstructionPatterns.some(pattern => pattern.test(safeBody))) {
        return null;
      }
      return safeBody.length > 0 ? `${marker} ${safeBody}` : null;
    })
    .filter((line): line is string => Boolean(line));

  if (sanitizedLines.length === 0) {
    return null;
  }

  return sanitizedLines.slice(0, 8).join('\n');
}

function looksLikeCandidateSourcingTask(query: string, context?: string): boolean {
  const haystack = `${query}\n${context ?? ''}`;
  const sourcingIntentPatterns = [
    /\brecruit(ing|er)?\b/i,
    /\bhir(e|ing)\b/i,
    /\bsourc(e|ing)\b/i,
  ];
  const candidatePoolPatterns = [
    /\bcandidates?\b/i,
    /\badaylar?\b/i,
    // Common job title roles (plural or singular) that indicate a pool, not a named individual
    /\b(engineers?|developers?|researchers?|analysts?|designers?)\b/i,
    /\bdata\s+scientists?\b/i,
    /\bproduct\s+managers?\b/i,
    /\bsecurity\s+(?:researchers?|engineers?|analysts?)\b/i,
    /\bmachine\s+learning\s+engineers?\b/i,
    /\bml\s+engineers?\b/i,
    /\bdevops\s+engineers?\b/i,
    /\bsoftware\s+engineers?\b/i,
    /\bfullstack\s+developers?\b/i,
    /\bfull.?stack\s+developers?\b/i,
    /\bbackend\s+developers?\b/i,
    /\bfrontend\s+developers?\b/i,
    /\bmobile\s+developers?\b/i,
    /\bcloud\s+engineers?\b/i,
    /\bplatform\s+engineers?\b/i,
    /\bsite\s+reliability\s+engineers?\b/i,
    /\bsre\b/i,
    /\bux\s+(?:designers?|researchers?)\b/i,
    /\bui\s+(?:designers?|developers?)\b/i,
    /\bproject\s+managers?\b/i,
    /\bprogram\s+managers?\b/i,
    /\btech\s+leads?\b/i,
    /\bengineering\s+managers?\b/i,
    /\bprofessionals?\b/i,
    /\bspecialists?\b/i,
    /\bpractitioners?\b/i,
  ];
  const sourcingFilterPatterns = [
    /\b\d+\s*-\s*\d+\s*(?:yoe|years? of experience)\b/i,
    /\b(?:yoe|years? of experience|experience|location|remote|onsite|hybrid)\b/i,
    /\b(?:at|for)\s+[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,4}\b/,
  ];
  const filteredSourcingRequestPatterns = [
    /\bfind\b[\s\S]{0,80}\b\d+\s*-\s*\d+\s*(?:yoe|years? of experience)\b[\s\S]{0,80}\b(engineers?|developers?|researchers?|analysts?|designers?)\b/i,
    /\bneed\b[\s\S]{0,80}\bcandidates?\b[\s\S]{0,80}\b(?:at|for)\s+[A-Z]/i,
    /\bfind\b[\s\S]{0,80}\b(engineer|developer|researcher|analyst|designer)\b[\s\S]{0,80}\b(?:at|for)\s+[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,4}\b[\s\S]{0,80}\b(?:\d+\s*-\s*\d+\s*(?:yoe|years? of experience)|remote|onsite|hybrid)\b/i,
  ];
  const mentionsCandidatePool = candidatePoolPatterns.some(pattern => pattern.test(haystack));
  const targetsNamedIndividual = /\b(?:[Ii]nvestigate|[Ll]ookup|[Rr]esearch|[Pp]rofile|[Aa]bout|[Ff]ind)\b[\s\S]{0,80}\b(?!Backend\b|Frontend\b|Fullstack\b|Full-Stack\b|Data\b|Security\b|Mobile\b|DevOps\b|Lead\b|Senior\b|Staff\b|Principal\b|Junior\b|Mid\b)[A-Z][a-z]+\s+(?!Engineer\b|Developer\b|Researcher\b|Analyst\b|Designer\b|Labs\b|Inc\b|Corp\b|LLC\b|Ltd\b|Technologies\b|Systems\b|Company\b|University\b|Institute\b)[A-Z][a-z]+\b/.test(haystack);

  const hasExplicitSourcingIntent = sourcingIntentPatterns.some(pattern => pattern.test(haystack));
  const looksLikeFilteredCandidatePool = mentionsCandidatePool
    && sourcingFilterPatterns.some(pattern => pattern.test(haystack));
  const matchesFilteredSourcingRequest = filteredSourcingRequestPatterns.some(pattern => pattern.test(haystack));

  return !targetsNamedIndividual && (hasExplicitSourcingIntent || looksLikeFilteredCandidatePool || matchesFilteredSourcingRequest);
}

export async function runIdentityAgent(
  query: string,
  context?: string,
  depth?: string,
  existingHistory?: Message[],
  agentLoopRunner: AgentLoopRunner = runAgentLoop,
  knowledgeFilePath?: string,
): Promise<SubAgentResult> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((identityAgentConfig.maxToolCalls ?? 30) * multiplier);
  emitProgress(`🕵️‍♂️ IdentityAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [depth: ${depth ?? 'normal'}, budget: ${maxToolCalls}]`);

  // Separate strategy plan from raw context
  const { plan: strategyPlan, cleanContext } = separatePlanFromContext(context);

  // Build pivot context from Neo4j graph
  let pivotSection = '';
  if (!existingHistory) {
    const pivotBlock = await loadPivotContext(query);
    if (pivotBlock) {
      pivotSection = `\n\n[GRAPH MEMORY — Previously discovered data about this target]\n${pivotBlock}\n[/GRAPH MEMORY]\n\nPrioritize the unexplored pivots listed above — they are the most valuable next steps.`;
    }
  }

  // Build system prompt: base + mandatory strategy plan (if exists)
  let systemPrompt = identityAgentConfig.systemPrompt;
  if (looksLikeCandidateSourcingTask(query, cleanContext ?? context)) {
    systemPrompt += `\n\n${IDENTITY_SOURCING_GUIDANCE}`;
  }
  if (strategyPlan) {
    systemPrompt += `\n\n# ⛔ MANDATORY RESEARCH PLAN (FROM STRATEGY — YOU MUST FOLLOW THIS)\n\nThe Strategy Agent analyzed this task and created the plan below. You MUST execute this plan:\n- Follow the tool usage order specified\n- Do NOT skip tools listed in the plan\n- Do NOT default to only using search_web/search_web_multi\n- Use Sherlock, Maigret, cross_reference, verify_profiles as the plan instructs\n\n<strategy_plan>\n${strategyPlan}\n</strategy_plan>\n\nAfter following the plan above, you must also satisfy these rules:\n1. Every person found must be verified by at least 2 INDEPENDENT sources before being marked as "Verified"\n2. If the task specifies filters (e.g., years of experience), EXTRACT and VERIFY dates — do not skip filtering\n3. Candidates that don't match all filters must be excluded from the final report, not just flagged`;
  }

  // Build user message: context (without plan) + pivot + task
  const userParts: string[] = [];
  if (cleanContext) userParts.push(`Context:\n${cleanContext}`);
  if (pivotSection) userParts.push(pivotSection.trim());
  userParts.push(`Task:\n${query}`);
  const userMessage = userParts.join('\n\n');

  // Continue with existing history if provided (AutoGen-style), otherwise start fresh
  const history: Message[] = existingHistory
    ? [...existingHistory]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

  try {
    const result = await agentLoopRunner(history, { ...identityAgentConfig, maxToolCalls });
    const effectiveHistory = result.history ?? history;
    await saveKnowledgeFromHistory(effectiveHistory, query, knowledgeFilePath);
    const toolSummary = Object.entries(result.toolsUsed)
      .map(([tool, count]) => `${tool}×${count}`)
      .join(', ');
    emitProgress(`✅ IdentityAgent completed [${result.toolCallCount} tools: ${toolSummary || 'none'}]`);
    const meta = `\n\n---\n**[META] IdentityAgent tool stats:** ${toolSummary || 'no tools used'} (total: ${result.toolCallCount})`;
    return { response: result.finalResponse + meta, history: effectiveHistory };
  } catch (error) {
    const savedKnowledge = await saveKnowledgeFromHistory(history, query, knowledgeFilePath);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const recoveryHint = savedKnowledge
      ? knowledgeFilePath
        ? `\n\nPartial tool results saved to ${knowledgeFilePath}.`
        : '\n\nPartial tool results saved to .osint-sessions/identity-knowledge.md. Recover them with read_session_file(agent="identity", include_knowledge=true).'
      : '';
    throw new Error(`${errorMessage}${recoveryHint}`);
  }
}

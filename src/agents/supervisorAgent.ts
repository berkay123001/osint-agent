import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { runIdentityAgent } from './identityAgent.js';
import { runMediaAgent } from './mediaAgent.js';
import { runAcademicAgent } from './academicAgent.js';
import { StrategySession } from './strategyAgent.js';
import { executeStrategyFlow } from './strategyOrchestrator.js';
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
 * Truncates sub-agent responses.
 * - Under 4000 chars: leave as-is
 * - 4000+ chars: first 3500 chars + truncation note + file path
 * Supervisor can read details via read_session_file.
 */
const MAX_SUB_AGENT_RESPONSE = 30000;
const KEEP_FIRST = 29000;

function truncateSubAgentResponse(response: string, agentLabel: string): string {
  if (response.length <= MAX_SUB_AGENT_RESPONSE) return response
  const truncated = response.slice(0, KEEP_FIRST)
  const lines = truncated.split('\n')
  // Drop the last incomplete line
  if (truncated.length === KEEP_FIRST) lines.pop()
  return lines.join('\n') +
    `\n\n---\n✂️ **[${agentLabel} response ${((response.length / 1024).toFixed(1))}KB — truncated]**\n` +
    `📄 For the full report use the \`read_session_file\` tool.\n` +
    `⚠️ [AGENT_DONE] This agent has completed its task. Do NOT delegate the same task AGAIN.`
}

/**
 * Truncates sub-agent responses (merged with prior definition).
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
      description: 'Delegates to the Identity specialist when research on a person, username, email, or profile is needed.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Full task/command for the Identity specialist (e.g. "investigate the torvalds GitHub account")' },
          context: { type: 'string', description: 'Additional context (previously known information, etc.)' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Research depth. quick=single entity/fast verification (0.5x tool budget), normal=standard (1x), deep=multi-entity/complex investigation (1.75x). Use deep for multiple people/usernames/emails.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_media_agent',
      description: 'Delegates to the Media specialist when image verification, EXIF analysis, reverse image search, or fake news/claim verification is needed. For news/claim verification, MediaAgent relies on RAW DATA, not the Supervisor\'s summary — always pass raw URL list and quotes in context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Task/command for the Media specialist (e.g. "find the source of this image" or "verify the Iran gas cut claim — scan the URLs below with your own tools")' },
          context: { type: 'string', description: 'RAW DATA package — URLs collected by the Supervisor, raw quotes, and conflicting points. Example format: "URL1: https://... | Quote: \'Minister: flow continuing\'\nURL2: https://... | Quote: \'Bloomberg: exports halted\'\nCONFLICT: Turkish official sources vs international media"\nMediaAgent verifies these URLs independently using its own web_fetch/scrape tools. SUMMARIES NOT ACCEPTED — PROVIDE RAW URLs.' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Research depth. quick=single claim/image (0.5x), normal=standard (1x), deep=multi-source/complex fact-check (1.75x). Use deep for multiple independent claims or 3+ URL investigations.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_academic_agent',
      description: 'Delegates to the Academic Research specialist when academic topic research, paper/publication search, researcher profiling, or citation analysis is needed. E.g. "latest papers on RL training in LLMs", "what is being researched after Attention is All You Need?"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Academic research task (e.g. "reinforcement learning from human feedback 2025 papers")' },
          context: { type: 'string', description: 'Additional context (researcher name, institution, etc.)' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Research depth. quick=single paper/quick summary (0.5x), normal=standard literature search (1x), deep=comprehensive citation network/multi-researcher analysis (1.75x).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_session_file',
      description: 'Reads sub-agent session files from disk. Can filter by a specific agent or read the raw knowledge base. Use when a sub-agent report is missing details or the user asks a follow-up — do not call the agent again.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['academic', 'identity', 'media', 'all'],
            description: 'Which agent\'s session file to read? Default: all (all agents)'
          },
          include_knowledge: {
            type: 'boolean',
            description: 'Also include raw tool call results (knowledge base)? Default: false (report only)'
          }
        },
        required: []
      }
    }
  }
];

/**
 * Programmatically saves sub-agent result to Obsidian.
 * Eliminates the need for the Supervisor to make an LLM tool call — reduces JSON crash risk.
 */
async function saveToObsidianDirect(agentLabel: string, query: string, result: string): Promise<void> {
  try {
    const safeName = query
      .replace(/[Ğğ]/g, 'G').replace(/[Üü]/g, 'U').replace(/[Şş]/g, 'S')
      .replace(/[İı]/g, 'I').replace(/[Öö]/g, 'O').replace(/[Çç]/g, 'C')
      .replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 60).trim() || 'research'
    const date = new Date().toISOString().slice(0, 10)
    const obsidianPath = `02 - Literature Research/${date}-${safeName}.md`
    const header = `# ${agentLabel} Literature Research\n\n**Query:** ${query}\n**Date:** ${new Date().toISOString()}\n\n---\n\n`
    await obsidianWrite(obsidianPath, header + result, true)
    logger.info('OBSIDIAN', `📝 Sub-agent result saved directly to Obsidian → ${obsidianPath}`)
  } catch (e) {
    logger.warn('OBSIDIAN', `Sub-agent Obsidian write skipped: ${(e as Error).message}`)
  }
}

import type { SubAgentResult } from './identityAgent.js';

type SubAgentFn = (query: string, context?: string, depth?: string, existingHistory?: Message[]) => Promise<SubAgentResult>;

/**
 * AutoGen-style sub-agent + Strategy Agent session
 *
 * Flow:
 * 1. Strategy creates a plan
 * 2. Sub-agent works with the plan → returns history
 * 3. Strategy reviews (remembers its own plan)
 * 4. If review requests one bounded correction → feedback is injected into sub-agent history
 *    and the sub-agent CONTINUES WITH THE SAME history (does not restart!)
 * 5. Strategy synthesizes a professional report
 *
 * Max 1 re-execution round (API cost control).
 */
async function executeSubAgentWithStrategy(
  agentType: 'identity' | 'media' | 'academic',
  args: Record<string, string>,
  agentFn: SubAgentFn,
  agentLabel: string,
  sessionTitle: string,
): Promise<string> {
  const strategy = new StrategySession(agentType, args.query);
  const flow = await executeStrategyFlow({
    agentType,
    args,
    agentFn,
    strategy,
    agentLabel,
  });
  const finalReport = flow.finalReport;
  logger.info('AGENT', `[Strategy] Session ${flow.strategyHistorySize} mesaj`);

  // --- Kaydet ---
  setReportContentBuffer(finalReport);
  try {
    const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = `${agentType}-last-session.md`;
    const header = `# ${sessionTitle} Session File\n\n**Query:** ${args.query}\n**Date:** ${new Date().toISOString()}\n\n---\n\n`;
    await writeFile(path.join(sessionDir, sessionFile), header + finalReport, 'utf-8');
  } catch { /* skip silently */ }
  saveToObsidianDirect(agentLabel, args.query, finalReport);

  return truncateSubAgentResponse(finalReport, agentLabel);
}

async function supervisorExecuteTool(name: string, args: Record<string, string>): Promise<string> {
  if (name === 'ask_identity_agent') {
    return await executeSubAgentWithStrategy('identity', args, runIdentityAgent, 'IdentityAgent', 'Identity Investigation');
  } else if (name === 'ask_media_agent') {
    return await executeSubAgentWithStrategy('media', args, runMediaAgent, 'MediaAgent', 'Media Investigation');
  } else if (name === 'ask_academic_agent') {
    return await executeSubAgentWithStrategy('academic', args, runAcademicAgent, 'AcademicAgent', 'Academic Research');
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
        const hint = agentFilter === 'all' ? '' : ` (for ${agentFilter} agent)`;
        return `⚠️ No saved research session found${hint}. Call a sub-agent first.`;
      }
      return parts.join('\n\n---\n\n');
    } catch {
      return '⚠️ No saved research session found.';
    }
  } else {
    // Normal tools (graph, search_web, etc.) — use the shared registry
    return await executeTool(name, args);
  }
}

export const supervisorAgentConfig: AgentConfig = {
  name: 'Supervisor',
  model: 'qwen/qwen3.6-plus',
  maxTokens: 32768, // Large sub-agent reports + thinking tokens need a generous budget
  maxToolCalls: 90, // Complex multi-agent tasks: 3+ sub-agent delegations × retries + report + graph ops
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
Vault: $OBSIDIAN_VAULT (or ~/Agent_Knowladges/OSINT/OSINT-Agent/ by default)
- 04 - Research Reports/ → generate_report auto sync
- 06 - Daily/ → obsidian_daily
- 07 - Notes/ → user preferences
- 08 - Profiles/ → [[username]] wikilink profile notes

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

export async function runSupervisor(history: Message[]): Promise<{ finalResponse: string; history: Message[] } | undefined> {
  try {
    const result = await runAgentLoop(history, supervisorAgentConfig);
    const formatted = formatAgentOutput(result.finalResponse);
    logger.info('AGENT', `\n🤖 Supervisor:\n${formatted}\n`);
    return {
      finalResponse: result.finalResponse,
      history: result.history ?? history,
    };
  } catch (error) {
    logger.error('AGENT', `Supervisor Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

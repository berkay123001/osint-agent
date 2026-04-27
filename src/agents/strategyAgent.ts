import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { logger } from '../lib/logger.js';
import { emitProgress, emitTelemetry, emitStrategyDetail } from '../lib/progressEmitter.js';
import { buildLLMTelemetryEvent, persistLLMTelemetryEvent } from '../lib/llmTelemetry.js';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Message } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = path.resolve(__dirname, '../../.osint-sessions');
const STRATEGY_LOG_FILE = path.join(SESSION_DIR, 'strategy-log.md');

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Strategy Agent requires OPENROUTER_API_KEY');
  }

  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  return client;
}

const STRATEGY_MODEL = 'qwen/qwen3.6-plus';

const STRATEGY_FALLBACKS = [
  'qwen/qwen3.6-plus',
  'deepseek/deepseek-v3.2',
];

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;

export type StrategyAgentType = 'identity' | 'media' | 'academic';
export type StrategyReviewDecision =
  | 'accept'
  | 'accept_with_warnings'
  | 'revise_same_history'
  | 'finalize_with_limitations';
export type StrategyReviewSeverity = 'major' | 'minor';
export type StrategyReviewFixMode = 'synthesis' | 'same_history_revision' | 'warn_only';

export interface StrategyReviewIssue {
  severity: StrategyReviewSeverity;
  code: string;
  fixMode: StrategyReviewFixMode;
  note: string;
}

export interface StrategyReviewResult {
  approved: boolean;
  feedback: string;
  decision: StrategyReviewDecision;
  summary: string;
  issues: StrategyReviewIssue[];
}

/**
 * Strategy Agent — session-aware operation.
 *
 * Each StrategySession is created for one sub-agent investigation.
 * All 3 phases run over the same conversation history:
 *   1. PLAN      → "Do this research, here is the plan"
 *   2. REVIEW    → "Here is the result, evaluate against plan" (remembers its own plan)
 *   3. SYNTHESIZE → "Generate professional report" (remembers plan + review)
 *
 * Does not call tools, only thinks deeply. Difference from Supervisor:
 * - Supervisor: general coordination, routing, user interaction
 * - Strategy: tactical planning, sub-agent oversight, report synthesis
 */

const BASE_SYSTEM_PROMPT = `You are an OSINT Strategy Specialist. You have three roles:

1. **Planning**: Write a focused research plan for the sub-agent.
2. **Review**: Evaluate sub-agent results and decide whether the result should be accepted, revised once with the SAME history, or finalized with explicit limitations.
3. **Synthesis**: Transform raw research output into a professional, clean, reliable report.

At each phase, remember what you said in PREVIOUS phases — you are continuing, not starting fresh.

# PLANNING RULES
Keep plans SHORT — max 8 bullet points. Focus on:
1. Key information gaps to fill
2. Tool usage order and priority
3. Expected pitfalls and how to avoid them
4. Verification criteria

# REVIEW RULES
When you are in REVIEW phase, output a machine-readable decision block FIRST using this exact format:

[REVIEW_DECISION]
decision: ACCEPT | ACCEPT_WITH_WARNINGS | REVISE_SAME_HISTORY | FINALIZE_WITH_LIMITATIONS
summary: one-sentence reason
issue: severity=MAJOR|MINOR | code=snake_case_code | fix_mode=synthesis|same_history_revision|warn_only | note=short actionable note
[/REVIEW_DECISION]

Decision meanings:
- ACCEPT: no meaningful issues, synthesis may simply polish formatting.
- ACCEPT_WITH_WARNINGS: only minor issues remain, fix in synthesis or keep explicit caution text.
- REVISE_SAME_HISTORY: one bounded correction pass is justified using the SAME sub-agent history and at most a narrow missing check.
- FINALIZE_WITH_LIMITATIONS: evidence is too thin, contradictory, or broad for a safe correction pass; do not request generic more research.

Hard constraints:
- Never request a fresh restart.
- Never ask for open-ended "research more" loops.
- Only choose REVISE_SAME_HISTORY when the missing or incorrect part is concrete, bounded, and actionable.
- If evidence is insufficient and the gap is not concrete, choose FINALIZE_WITH_LIMITATIONS.

# SYNTHESIS RULES
1. Source-check every concrete claim — if not in tool output, DELETE or flag with ⚠️
2. Remove duplicate findings
3. Clean up formatting — use tables, sections, summary
4. If review flagged [MINOR] issues, fix them here
5. If review flagged [MAJOR] issues, add clear warnings in the report
6. Keep all verified findings — do NOT delete valid data

Format: Clean Markdown with source references.`;

const REVIEW_RUBRICS: Record<StrategyAgentType, string> = {
  identity: `# ACTIVE REVIEW RUBRIC — Identity Agent Review
- [MAJOR] Fabricated profiles not found by tools (hallucination)
- [MAJOR] Different person presented as same person without evidence
- [MAJOR] Unsupported cross-platform linkage that needs one bounded verification step
- [MINOR] Incomplete profile data (missing bio, follower counts)
- [MINOR] Unverified employment or education claims`,
  academic: `# ACTIVE REVIEW RUBRIC — Academic Agent Review
- [MAJOR] Fabricated papers, DOIs, or metrics not in tool output
- [MAJOR] Wrong paper attributed to wrong researcher
- [MAJOR] Unsupported citation claim that needs one bounded correction pass
- [MINOR] Incomplete author list (et al. is acceptable)
- [MINOR] arXiv preprint instead of peer-reviewed (note it, do not reject)
- [MINOR] Missing full-text analysis (flag as abstract only)`,
  media: `# ACTIVE REVIEW RUBRIC — Media Agent Review
- [MAJOR] Image verification claims without tool evidence
- [MAJOR] Fabricated EXIF data or reverse image results
- [MAJOR] Confident verdict without enough directly cited source evidence
- [MINOR] Incomplete source verification
- [MINOR] Low-confidence claim presented too strongly`,
};

const DECISION_NORMALIZATION: Record<string, StrategyReviewDecision> = {
  accept: 'accept',
  accept_with_warnings: 'accept_with_warnings',
  revise_same_history: 'revise_same_history',
  finalize_with_limitations: 'finalize_with_limitations',
  result_clean: 'accept',
};

export function buildStrategySystemPrompt(agentType: StrategyAgentType): string {
  return `${BASE_SYSTEM_PROMPT}\n\n${REVIEW_RUBRICS[agentType]}`;
}

export function getStrategyModelsToTry(): string[] {
  return [...new Set([STRATEGY_MODEL, ...STRATEGY_FALLBACKS])];
}

function normalizeReviewDecision(rawValue?: string, feedback?: string, issues: StrategyReviewIssue[] = []): StrategyReviewDecision {
  const normalized = rawValue
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized && DECISION_NORMALIZATION[normalized]) {
    return DECISION_NORMALIZATION[normalized];
  }

  const fullText = feedback ?? '';
  const hasMajor = issues.some((issue) => issue.severity === 'major') || /\[major\]/i.test(fullText);
  const hasMinor = issues.some((issue) => issue.severity === 'minor') || /\[minor\]/i.test(fullText);

  if (/result clean|\bapproved\b/i.test(fullText)) return 'accept';
  if (/finalize with explicit limitations|finalize with limitations|insufficient evidence|evidence is too thin|too thin to trust|not enough evidence/i.test(fullText)) {
    return 'finalize_with_limitations';
  }
  if (/same-history correction|same history correction|bounded same-history correction|bounded correction pass|missing verification step|unsupported linkage/i.test(fullText)) {
    return 'revise_same_history';
  }
  if (hasMajor && /same history|bounded correction|missing verification|run missing tools|rewrite the report|unsupported/i.test(fullText)) {
    return 'revise_same_history';
  }
  if (hasMajor) return 'finalize_with_limitations';
  if (hasMinor) return 'accept_with_warnings';
  if (/warning|caution|limitation/i.test(fullText)) return 'accept_with_warnings';
  return fullText.trim().length > 0 ? 'accept_with_warnings' : 'accept';
}

function parseIssueLine(line: string, index: number): StrategyReviewIssue {
  const raw = line.replace(/^issue:\s*/i, '').trim();
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    const value = part.slice(separatorIndex + 1).trim();
    fields.set(key, value);
  }

  const severityValue = fields.get('severity')?.toLowerCase();
  const fixModeValue = fields.get('fix_mode')?.toLowerCase();
  return {
    severity: severityValue === 'major' ? 'major' : 'minor',
    code: fields.get('code') || `issue_${index + 1}`,
    fixMode: fixModeValue === 'same_history_revision'
      ? 'same_history_revision'
      : fixModeValue === 'warn_only'
        ? 'warn_only'
        : 'synthesis',
    note: fields.get('note') || raw,
  };
}

function parseBracketIssues(feedback: string): StrategyReviewIssue[] {
  const issueLines = feedback
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\[(major|minor)\]/i.test(line));

  return issueLines.map((line, index) => {
    const severity = /^\[major\]/i.test(line) ? 'major' : 'minor';
    const note = line.replace(/^\[(major|minor)\]\s*/i, '').trim();
    return {
      severity,
      code: `${severity}_issue_${index + 1}`,
      fixMode: severity === 'major' ? 'same_history_revision' : 'synthesis',
      note,
    } satisfies StrategyReviewIssue;
  });
}

export function parseStrategyReviewResult(feedback: string): Omit<StrategyReviewResult, 'feedback' | 'approved'> {
  const blockMatch = feedback.match(/\[REVIEW_DECISION\]([\s\S]*?)(?:\[\/REVIEW_DECISION\]|$)/i);
  const block = blockMatch?.[1] ?? '';
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);

  const rawDecision = lines.find((line) => /^decision\s*:/i.test(line))?.replace(/^decision\s*:/i, '').trim();
  const summary = lines.find((line) => /^summary\s*:/i.test(line))?.replace(/^summary\s*:/i, '').trim() || '';
  const structuredIssues = lines
    .filter((line) => /^issue\s*:/i.test(line))
    .map((line, index) => parseIssueLine(line, index));
  const issues = structuredIssues.length > 0 ? structuredIssues : parseBracketIssues(feedback);
  const decision = normalizeReviewDecision(rawDecision, feedback, issues);

  return {
    decision,
    summary: summary || feedback.split('\n').map((line) => line.trim()).find(Boolean) || 'No review summary provided.',
    issues,
  };
}

const AGENT_DESCRIPTIONS: Record<StrategyAgentType, string> = {
  identity: 'Identity OSINT — username/email/profile research. Tools: search_person, run_sherlock, run_maigret, nitter_profile, scrape_profile, verify_profiles, web_fetch, cross_reference, run_github_osint, check_email_registrations, check_breaches, verify_claim',
  media: 'Media verification — image/news/fact-check. Tools: reverse_image_search, extract_metadata, compare_images_phash, fact_check_to_graph, web_fetch, scrape_profile, verify_claim',
  academic: 'Academic research — papers/authors/plagiarism. Tools: search_academic_papers, search_researcher_papers, check_plagiarism, web_fetch, scrape_profile, wayback_search, query_graph',
};

export class StrategySession {
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private agentType: StrategyAgentType;
  private query: string;
  private logEntries: string[] = [];
  private completionAttempt = 0;

  constructor(agentType: StrategyAgentType, query: string) {
    this.agentType = agentType;
    this.query = query;
    this.history.push({ role: 'system', content: buildStrategySystemPrompt(agentType) });
    this.logEntries.push(`# Strategy Agent Session\n**Agent:** ${agentType}\n**Task:** ${query}\n**Start:** ${new Date().toISOString()}\n\n---\n`);
  }

  /** Write to TUI and strategy-log file */
  private logPhase(phase: string, content: string): void {
    const timestamp = new Date().toLocaleTimeString('en-US');
    // Send to TUI — via emitProgress (user sees it in the log panel)
    const lines = content.split('\n').filter(l => l.trim());
    const preview = lines.slice(0, 5).join('\n  ');
    const suffix = lines.length > 5 ? `\n  ... (+${lines.length - 5} more lines)` : '';
    emitProgress(`🧠 [Strategy-${phase}] ${timestamp}\n  ${preview}${suffix}`);
    emitStrategyDetail(content);

    // File log — full content
    this.logEntries.push(`## ${phase} (${timestamp})\n\n${content}\n\n---\n`);
  }

  /** Write log to file at end of session */
  async flushLog(): Promise<void> {
    try {
      await mkdir(SESSION_DIR, { recursive: true });
      await appendFile(STRATEGY_LOG_FILE, this.logEntries.join('\n'), 'utf-8');
    } catch {
      // file write error is not critical
    }
  }

  /**
   * PHASE 1: Create a tactical plan before the sub-agent runs.
   * Plan is saved to session history — subsequent calls remember it.
   */
  async plan(context?: string): Promise<string> {
    emitProgress(`🧠 Strategy Agent planning (${this.agentType})...`);

    this.history.push({
      role: 'user',
      content: `[PLANNING PHASE]\nAgent type: ${this.agentType}\nAgent capabilities: ${AGENT_DESCRIPTIONS[this.agentType]}\n\nResearch task: ${this.query}${context ? `\n\nAdditional context: ${context}` : ''}`,
    });

    try {
      const response = await this.callLLM('plan');
      const plan = response ?? '';

      if (plan.length > 50) {
        this.history.push({ role: 'assistant', content: plan });
        this.logPhase('PLAN', plan);
        await this.flushLog();
        return plan;
      }
      return '';
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Plan] Error: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * PHASE 2: Review results after sub-agent completes.
   * Remembers its own plan from history — no need to pass it as a parameter again.
   */
  async review(result: string): Promise<StrategyReviewResult> {
    emitProgress(`🧠 Strategy Agent reviewing (${this.agentType})...`);

    this.history.push({
      role: 'user',
      content: `[REVIEW PHASE]\nSub-agent completed. Here are the research results:\n\n${result.slice(0, 25000)}`,
    });

    try {
      const response = await this.callLLM('review');
      const review = response ?? '';
      const parsed = parseStrategyReviewResult(review);
      const approved = parsed.decision === 'accept' || parsed.decision === 'accept_with_warnings';

      this.history.push({ role: 'assistant', content: review });
      this.logPhase(approved ? 'REVIEW ✅' : 'REVIEW ❌', review);
      await this.flushLog();

      return {
        approved,
        feedback: review,
        decision: parsed.decision,
        summary: parsed.summary,
        issues: parsed.issues,
      };
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Review] Error: ${(err as Error).message}`);
      const fallbackFeedback = [
        '[REVIEW_DECISION]',
        'decision: ACCEPT_WITH_WARNINGS',
        'summary: Review failed; falling back to synthesis without a correction pass.',
        '[/REVIEW_DECISION]',
      ].join('\n');
      return {
        approved: true,
        feedback: fallbackFeedback,
        decision: 'accept_with_warnings',
        summary: 'Review failed; falling back to synthesis without a correction pass.',
        issues: [],
      };
    }
  }

  /**
   * PHASE 3: Transform raw result into a professional report.
   * History has plan + review — it knows what to clean up.
   */
  async synthesize(result: string, reviewFeedback?: string): Promise<string> {
    emitProgress(`🧠 Strategy Agent synthesizing report (${this.agentType})...`);

    const contextParts: string[] = [
      `[SYNTHESIS PHASE]`,
      `Sub-agent raw result:`,
      result.slice(0, 20000),
    ];
    if (reviewFeedback) {
      contextParts.push(`\nYour own review notes (from above):`, reviewFeedback.slice(0, 3000));
    }

    this.history.push({
      role: 'user',
      content: contextParts.join('\n'),
    });

    try {
      const response = await this.callLLM('synthesize');
      const synthesized = response ?? '';

      if (synthesized.length > 100) {
        this.history.push({ role: 'assistant', content: synthesized });
        this.logPhase('SYNTHESIZE', `Input: ${(result.length / 1024).toFixed(1)}KB raw → Output: ${(synthesized.length / 1024).toFixed(1)}KB synthesized report`);
        await this.flushLog();
        return synthesized;
      }
      return result;
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Synthesize] Error: ${(err as Error).message}`);
      return result;
    }
  }

  /**
   * Shared LLM call — always sends the session history.
   * Retries on 429 with exponential backoff, falls back to alternate models.
   */
  private async callLLM(phase: 'plan' | 'review' | 'synthesize'): Promise<string | undefined> {
    const startedAt = Date.now();
    const attempt = ++this.completionAttempt;
    const modelsToTry = getStrategyModelsToTry();

    for (const model of modelsToTry) {
      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
          const response = (await getClient().chat.completions.create({
            model,
            messages: this.history,
            max_tokens: 10000,
          })) as ChatCompletion;

          const telemetry = buildLLMTelemetryEvent({
            agent: 'StrategyAgent',
            phase,
            reason: phase,
            attempt,
            requestedModel: STRATEGY_MODEL,
            actualModel: response.model,
            responseId: response.id,
            status: 'success',
            latencyMs: Date.now() - startedAt,
            messages: this.history as Message[],
            usage: response.usage as any,
          });
          emitTelemetry(telemetry);
          void persistLLMTelemetryEvent(telemetry).catch((error) => {
            emitProgress(`⚠️ [Strategy-${phase}] Telemetry persist failed: ${(error as Error).message}`);
          });

          if (model !== STRATEGY_MODEL) {
            emitProgress(`🧠 [Strategy-${phase}] Fell back to ${model}`);
          }

          return response.choices?.[0]?.message?.content?.trim();
        } catch (error) {
          const is429 = error instanceof Error && /429|rate.?limit/i.test(error.message);
          if (!is429 || retry >= MAX_RETRIES - 1) break;

          const delay = BASE_DELAY_MS * Math.pow(2, retry);
          emitProgress(`🧠 [Strategy-${phase}] 429 rate limit on ${model}, retry ${retry + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All models exhausted — emit error telemetry and throw
    const telemetry = buildLLMTelemetryEvent({
      agent: 'StrategyAgent',
      phase,
      reason: phase,
      attempt,
      requestedModel: STRATEGY_MODEL,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      messages: this.history as Message[],
      errorMessage: `All models exhausted (429): ${modelsToTry.join(', ')}`,
    });
    emitTelemetry(telemetry);
    void persistLLMTelemetryEvent(telemetry).catch((persistError) => {
      emitProgress(`⚠️ [Strategy-${phase}] Telemetry persist failed: ${(persistError as Error).message}`);
    });
    throw new Error(`Strategy Agent: all models returned 429`);
  }

  /**
   * History size — for debugging
   */
  getHistorySize(): number {
    return this.history.length;
  }
}

// ============================================================================
// Backward-compatible wrapper functions
// For any places in Supervisor using the old call format
// ============================================================================

/**
 * Create a strategic plan before sub-agent runs.
 * Stateless version — no session memory.
 */
export async function createStrategyPlan(
  agentType: StrategyAgentType,
  query: string,
  context?: string,
): Promise<string> {
  const session = new StrategySession(agentType, query);
  return session.plan(context);
}

/**
 * Review results after sub-agent completes.
 * Stateless version — plan is passed as a parameter.
 */
export async function reviewStrategyResult(
  agentType: string,
  query: string,
  result: string,
  plan?: string,
): Promise<StrategyReviewResult> {
  const session = new StrategySession(
    agentType as StrategyAgentType,
    query,
  );
  // Inject plan into history so review remembers it
  if (plan) {
    session['history'].push({ role: 'assistant', content: plan });
  }
  return session.review(result);
}

/**
 * Transform the sub-agent's raw result into a professional report.
 * Stateless version.
 */
export async function synthesizeReport(
  agentType: string,
  query: string,
  result: string,
  reviewFeedback?: string,
): Promise<string> {
  const session = new StrategySession(
    agentType as StrategyAgentType,
    query,
  );
  return session.synthesize(result, reviewFeedback);
}

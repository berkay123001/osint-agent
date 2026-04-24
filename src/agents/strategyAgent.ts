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

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const STRATEGY_MODEL = 'qwen/qwen3.6-plus';

const STRATEGY_FALLBACKS = [
  'deepseek/deepseek-v3.2',
  'minimax/minimax-m2.5',
];

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;

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

const SYSTEM_PROMPT = `You are an OSINT Strategy Specialist. You have three roles:

1. **Planning**: Write a focused research plan for the sub-agent.
2. **Review**: Evaluate sub-agent results and provide advisory notes (you do NOT block/reject — just flag issues for synthesis).
3. **Synthesis**: Transform raw research output into a professional, clean, reliable report.

At each phase, remember what you said in PREVIOUS phases — you are continuing, not starting fresh.

# PLANNING RULES
Keep plans SHORT — max 8 bullet points. Focus on:
1. Key information gaps to fill
2. Tool usage order and priority
3. Expected pitfalls and how to avoid them
4. Verification criteria

# REVIEW RULES — ADVISORY ONLY
Review is NOT a gate — it provides quality notes for the Synthesis phase.
Never trigger a retry. Just flag issues clearly.

Evaluate based on agent type (see below) and output:
- "RESULT CLEAN" if no significant issues found
- List specific issues with severity: [MINOR] (fixable in synthesis) or [MAJOR] (significant data quality concern)

## Identity Agent Review:
- [MAJOR] Fabricated profiles not found by tools (hallucination)
- [MAJOR] Different person presented as same person without evidence
- [MINOR] Incomplete profile data (missing bio, follower counts)
- [MINOR] Unverified employment/education claims

## Academic Agent Review:
- [MAJOR] Fabricated papers, DOIs, or metrics not in tool output
- [MAJOR] Wrong paper attributed to wrong researcher
- [MINOR] Incomplete author list (et al. is acceptable)
- [MINOR] arXiv preprint instead of peer-reviewed (note it, don't reject)
- [MINOR] Missing full-text analysis (flag as "abstract only")

## Media Agent Review:
- [MAJOR] Image verification claims without tool evidence
- [MAJOR] Fabricated EXIF data or reverse image results
- [MINOR] Incomplete source verification
- [MINOR] Low-confidence claim presented as verified

# SYNTHESIS RULES
1. Source-check every concrete claim — if not in tool output, DELETE or flag with ⚠️
2. Remove duplicate findings
3. Clean up formatting — use tables, sections, summary
4. If review flagged [MINOR] issues, fix them here
5. If review flagged [MAJOR] issues, add clear warnings in the report
6. Keep all verified findings — do NOT delete valid data

Format: Clean Markdown with source references.`;

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
  private completionAttempt = 0;

  constructor(agentType: 'identity' | 'media' | 'academic', query: string) {
    this.agentType = agentType;
    this.query = query;
    this.history.push({ role: 'system', content: SYSTEM_PROMPT });
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
  async review(result: string): Promise<{ approved: boolean; feedback: string }> {
    emitProgress(`🧠 Strategy Agent reviewing (${this.agentType})...`);

    this.history.push({
      role: 'user',
      content: `[REVIEW PHASE]\nSub-agent completed. Here are the research results:\n\n${result.slice(0, 25000)}`,
    });

    try {
      const response = await this.callLLM('review');
      const review = response ?? '';
      const approved = review.includes('RESULT CLEAN') || review.toLowerCase().includes('approved');

      this.history.push({ role: 'assistant', content: review });
      this.logPhase(approved ? 'REVIEW ✅' : 'REVIEW ❌', review);
      await this.flushLog();

      return { approved, feedback: review };
    } catch (err) {
      logger.warn('AGENT', `[Strategy-Review] Error: ${(err as Error).message}`);
      return { approved: true, feedback: '' };
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
    const modelsToTry = [STRATEGY_MODEL, ...STRATEGY_FALLBACKS];

    for (const model of modelsToTry) {
      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
          const response = (await client.chat.completions.create({
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
  agentType: 'identity' | 'media' | 'academic',
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
): Promise<{ approved: boolean; feedback: string }> {
  const session = new StrategySession(
    agentType as 'identity' | 'media' | 'academic',
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
    agentType as 'identity' | 'media' | 'academic',
    query,
  );
  return session.synthesize(result, reviewFeedback);
}

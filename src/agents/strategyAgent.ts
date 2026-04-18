import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { logger } from '../lib/logger.js';
import { emitProgress, emitTelemetry } from '../lib/progressEmitter.js';
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

const STRATEGY_MODEL = 'deepseek/deepseek-v3.2-speciale';

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
      content: `[REVIEW PHASE]\nSub-agent completed. Here are the research results:\n\n${result.slice(0, 15000)}`,
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
      result.slice(0, 12000),
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
   */
  private async callLLM(phase: 'plan' | 'review' | 'synthesize'): Promise<string | undefined> {
    const startedAt = Date.now();
    const attempt = ++this.completionAttempt;
    try {
      const response = (await client.chat.completions.create({
        model: STRATEGY_MODEL,
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

      return response.choices?.[0]?.message?.content?.trim();
    } catch (error) {
      const telemetry = buildLLMTelemetryEvent({
        agent: 'StrategyAgent',
        phase,
        reason: phase,
        attempt,
        requestedModel: STRATEGY_MODEL,
        status: 'error',
        latencyMs: Date.now() - startedAt,
        messages: this.history as Message[],
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      emitTelemetry(telemetry);
      void persistLLMTelemetryEvent(telemetry).catch((persistError) => {
        emitProgress(`⚠️ [Strategy-${phase}] Telemetry persist failed: ${(persistError as Error).message}`);
      });
      throw error;
    }
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

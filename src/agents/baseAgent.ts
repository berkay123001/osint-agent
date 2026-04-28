import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { normalizeAssistantMessage, normalizeToolContent } from '../lib/chatHistory.js';
import { buildProviderMessages as buildDurableProviderMessages } from '../lib/providerContextBuilder.js';
import { buildToolCacheKey, rebuildAgentSession } from '../lib/agentSession.js';
import { logger } from '../lib/logger.js';
import { emitProgress, emitSessionGraphDirty, emitTelemetry, emitToolDetail } from '../lib/progressEmitter.js';
import { buildLLMTelemetryEvent, persistLLMTelemetryEvent } from '../lib/llmTelemetry.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Message, AgentConfig, AgentResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = 'kwaipilot/kat-coder-pro-v2';
const SUPERVISOR_MODEL = 'qwen/qwen3.6-plus';
export { DEFAULT_MODEL, SUPERVISOR_MODEL };

// Fallback models — tried sequentially on content filter (PII) or rate limit errors
const FALLBACK_MODELS = [
  'minimax/minimax-m2.5',
  'google/gemini-2.0-flash-001',
  'deepseek/deepseek-chat-v3-0324',
];

const DEFAULT_MAX_TOOL_CALLS = 30;
const DEFAULT_MAX_TOKENS = 32768; // Generous budget for Qwen3 thinking tokens

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

/**
 * Qwen3 models perform reasoning between <think/> tags.
 * This function strips those tags, leaving only the content to be returned to the user.
 */
function stripThinkingTokens(text: string): string {
  return text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
}

function isInternalControlPrompt(content: string): boolean {
  return content.startsWith('ALL TOOLS COMPLETED')
    || content.startsWith('TOOL_CALL_DISABLED')
    || content.startsWith('The previous tool call had invalid JSON format.')
    || content.startsWith('Do not call any tools. Present all collected data directly as text.')
    || content.startsWith('IMPORTANT: Using the tool results above, write a comprehensive Markdown report NOW.')
    || content.startsWith('Stop calling tools. Summarize ALL the information you have collected above as PLAIN TEXT ONLY.')
    || content.startsWith('[STRATEGY REVIEW — Correction Required]')
    || content.startsWith('[STRATEGY REVIEW — Final Report Required]')
    || content.startsWith('⚠️ STAGNATION DETECTED')
    || content.startsWith('⚠️ TOOL DIVERSITY REQUIREMENT');
}

export async function runAgentLoop(
  history: Message[],
  config: AgentConfig,
  _clientOverride?: OpenAI,
  _retryDelayMs?: number
): Promise<AgentResult> {
  const _client = _clientOverride ?? client;
  const _delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, _retryDelayMs ?? ms));
  let session = rebuildAgentSession(config.name, history);
  let toolCallCount = 0;
  let toolCallCountFloor = 0;
  let emptyRetries = 0;
  let correctionRetries = 0;
  let totalCorrectionAttempts = 0; // Global cap — prevents infinite loops
  let forceTextRetries = 0; // Text forcing retry counter
  let toolsDisabledMessageSent = false; // Summary request sent only once when tool budget is exhausted
  let toolsUsed: Record<string, number> = {};
  const pushHistory = (message: Message): void => {
    history.push(message);
    emitSessionGraphDirty();
  };
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  // Tool call deduplication: return from cache if the same tool+args combination was called before
  let callCache = new Map<string, string>();
  // Per-tool hard limit: prevents a single tool from consuming the entire budget
  const PER_TOOL_LIMITS: Record<string, number> = {
    search_academic_papers: 8,
    search_web: 20,
    search_web_multi: 8,
    search_researcher_papers: 8,
  };
  let perToolCount: Record<string, number> = {};
  // Stagnation detection: track consecutive low-yield calls
  let lowYieldStreak = 0;
  const LOW_YIELD_THRESHOLD = 5; // After this many consecutive low-yield calls, force synthesis
  let seenUrls = new Set<string>(); // Track unique URLs found across all search results
  let completionAttempt = 0;

  function refreshRuntimeState(): void {
    session = rebuildAgentSession(config.name, history);
    toolCallCount = Math.max(toolCallCountFloor, session.runtime.toolCallCount);
    toolsUsed = { ...session.runtime.toolsUsed };
    callCache = new Map(Object.entries(session.runtime.duplicateToolCache));
    perToolCount = { ...session.runtime.perToolCount };
    lowYieldStreak = session.runtime.lowYieldStreak;
    seenUrls = new Set(session.runtime.seenUrls);
  }

  function buildRequestMessages(modelName: string): Message[] {
    const prepared = buildDurableProviderMessages(history, {
      agentName: config.name,
      modelName,
      session,
    });
    session = prepared.session;
    return prepared.messages;
  }

  // Tools that return free-form page content — broad error words like "error analysis",
  // "failure modes", "failed state" are benign in their output and must not suppress success.
  const broadContentTools = new Set(['web_fetch', 'nitter_profile', 'auto_visual_intel']);

  function isSuccessfulVerificationResult(toolName: string, result: string): boolean {
    const normalized = result
      .trim()
      .toLocaleLowerCase('tr-TR')
      .replace(/ı/g, 'i')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
    // Patterns that unambiguously mean the tool found nothing or hit a gate —
    // safe to apply to ALL tools including broad-content ones.
    const emptyVerificationPatterns = [
      /\bno (profiles?|results?|matches?|identifiers?|evidence|data|findings?)\b/,
      /\bnothing found\b/,
      /\bcould not verify\b/,
      /\bnot found\b/,
      /\b0 profiles?\b/,
      /\b0 matches?\b/,
      /\bsign in to continue\b/,
      /\blogin required\b/,
      /\bcreate an account\b/,
      /\bagree & join\b/,
      /\bsign up\b/,
      /\byetersiz kanit\b/,
      /\bdogrulanamadi\b/,
      /\bhicbir dogrulanmis tanimlayici bulunamadi\b/,
      /\bgrafta dogrulanacak profil yok\b/,
      /\btimeout\b/,
      /\btimed out\b/,
      /\bunavailable\b/,
      /\bunreachable\b/,
      /\bconnection refused\b/,
      /\brate limit\b/,
      /\bbaglanti kurulamadi\b/,
      /\blogin wall\b/,
      /\bforbidden\b/,
      /\bdenied\b/,
      /\bcaptcha\b/,
    ];
    // Broad single-word patterns that are ambiguous in free-form page content (e.g. "error
    // analysis", "failed state", "failure mode"). Only applied to narrow-output tools.
    const strictErrorPatterns = [
      /\berror\b/,
      /\bfailed\b/,
      /\bfailure\b/,
    ];
    const isBroadContentTool = broadContentTools.has(toolName);
    const activePatterns = isBroadContentTool
      ? emptyVerificationPatterns
      : [...emptyVerificationPatterns, ...strictErrorPatterns];
    const explicitPositivePatternsByTool: Partial<Record<string, RegExp[]>> = {
      cross_reference: [
        /\bverified\b/,
        /\bconfirmed\b/,
        /\bindependent evidence\b/,
        /\bcorroborated\b/,
        /\bmatch(?:ed)?\b/,
        /\bsame (?:email|avatar|organization|location)\b/,
        /\bcapraz dogrulama sonuclari\b/,
        /\bdogrulanmis tanimlayicilar\b/,
      ],
      verify_claim: [
        /\bverified\b/,
        /\bconfirmed\b/,
        /\bsupported\b/,
        /\bdogrulandi\b/,
        /\bonaylandi\b/,
        /\btrue\b/,
        /\biddia dogrulama\b[\s\S]{0,40}\bguven:\s*(yuksek|orta|dusuk)\b/,
      ],
    };

    const explicitPositivePatterns = explicitPositivePatternsByTool[toolName];

    if (toolName === 'verify_profiles') {
      const verifiedCountMatch = normalized.match(/(?:\bsonuc\b:?\s*)?(\d+)\s+(?:dogrulandi|verified)\b/);
      if (verifiedCountMatch) {
        return Number.parseInt(verifiedCountMatch[1], 10) > 0;
      }

      const explicitPositiveVerificationPatterns = [
        /^\s*[✅✔]/m,
        /\bverified\b/,
        /\bdogrulandi\b/,
        /\bconfirmed\b/,
        /\bmatch\b/,
      ];

      return isUsableRecoveryToolResult(result)
        && !activePatterns.some(pattern => pattern.test(normalized))
        && explicitPositiveVerificationPatterns.some(pattern => pattern.test(normalized));
    }

    return isUsableRecoveryToolResult(result)
      && !activePatterns.some(pattern => pattern.test(normalized))
      && (!explicitPositivePatterns || explicitPositivePatterns.some(pattern => pattern.test(normalized)));
  }

  function normalizeToolMessageContent(content: unknown): string {
    return typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: string }) => part.text ?? '').join('')
        : '';
  }

  function collectRecoveryToolEvidenceBlocks(): string[] {
    const toolMetadataById = new Map<string, { name: string; args: string }>();
    const evidenceBlocks: string[] = [];

    for (const message of history) {
      const assistantMessage = message as { role: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
      if (assistantMessage.role === 'assistant' && assistantMessage.tool_calls) {
        for (const toolCall of assistantMessage.tool_calls) {
          if (toolCall.type === 'function') {
            toolMetadataById.set(toolCall.id, {
              name: toolCall.function.name,
              args: toolCall.function.arguments,
            });
          }
        }
        continue;
      }

      const toolMessage = message as { role: string; tool_call_id?: string; content?: unknown };
      if (toolMessage.role !== 'tool') {
        continue;
      }

      const result = normalizeToolMessageContent(toolMessage.content);
      if (!isUsableRecoveryToolResult(result)) {
        continue;
      }

      const metadata = toolMessage.tool_call_id ? toolMetadataById.get(toolMessage.tool_call_id) : undefined;
      if (!metadata) {
        evidenceBlocks.push(result);
        continue;
      }

      evidenceBlocks.push(
        `Tool: ${metadata.name}\nArgs: ${metadata.args.slice(0, 400)}\nResult:\n${result}`
      );
    }

    return evidenceBlocks;
  }

  function isUsableRecoveryToolResult(result: string): boolean {
    const normalized = result.trim().toLowerCase();

    if (normalized.length === 0) {
      return false;
    }

    if (result.startsWith('Tool error (')
      || result.startsWith('[TOOL_LIMIT]')
      || result.startsWith('[DUPLICATE_CALL]')
      || result.startsWith('[TOOL_ARGS_INVALID]')
      || normalized === 'tool produced no output.') {
      return false;
    }

    return true;
  }

  function countSuccessfulVerificationCalls(verificationTools: string[]): number {
    const toolNameById = new Map<string, string>();
    let successfulVerificationCount = 0;

    for (const message of history) {
      const assistantMessage = message as { role: string; tool_calls?: Array<{ id: string; type: string; function: { name: string } }> };
      if (assistantMessage.role === 'assistant' && assistantMessage.tool_calls) {
        for (const toolCall of assistantMessage.tool_calls) {
          if (toolCall.type === 'function') {
            toolNameById.set(toolCall.id, toolCall.function.name);
          }
        }
        continue;
      }

      const toolMessage = message as { role: string; tool_call_id?: string; content?: unknown };
      if (toolMessage.role !== 'tool' || !toolMessage.tool_call_id) {
        continue;
      }

      const toolName = toolNameById.get(toolMessage.tool_call_id);
      if (!toolName || !verificationTools.includes(toolName)) {
        continue;
      }

      const content = normalizeToolMessageContent(toolMessage.content);

      if (isSuccessfulVerificationResult(toolName, content)) {
        successfulVerificationCount++;
      }
    }

    return successfulVerificationCount;
  }

  async function createTrackedCompletion(
    request: {
      model: string
      messages: Message[]
      tools?: OpenAI.Chat.ChatCompletionTool[]
      tool_choice?: 'auto' | 'none'
      max_tokens: number
    },
    meta: {
      reason: string
      phase?: string
    }
  ): Promise<ChatCompletion> {
    const startedAt = Date.now();
    const attempt = ++completionAttempt;

    try {
      const completion = (await _client.chat.completions.create(request) as ChatCompletion);
      const telemetry = buildLLMTelemetryEvent({
        agent: config.name,
        phase: meta.phase,
        reason: meta.reason,
        attempt,
        requestedModel: request.model,
        actualModel: completion.model,
        responseId: completion.id,
        status: 'success',
        latencyMs: Date.now() - startedAt,
        messages: request.messages,
        usage: completion.usage as any,
      });
      emitTelemetry(telemetry);
      void persistLLMTelemetryEvent(telemetry).catch((error) => {
        emitProgress(`⚠️ [${config.name}] Telemetry persist failed: ${(error as Error).message}`);
      });
      return completion;
    } catch (error) {
      const telemetry = buildLLMTelemetryEvent({
        agent: config.name,
        phase: meta.phase,
        reason: meta.reason,
        attempt,
        requestedModel: request.model,
        status: 'error',
        latencyMs: Date.now() - startedAt,
        messages: request.messages,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      emitTelemetry(telemetry);
      void persistLLMTelemetryEvent(telemetry).catch((persistError) => {
        emitProgress(`⚠️ [${config.name}] Telemetry persist failed: ${(persistError as Error).message}`);
      });
      throw error;
    }
  }

  while (true) {
    refreshRuntimeState();
    const toolsDisabledByBudget = toolCallCount >= maxToolCalls;
    const toolsDisabled = toolsDisabledByBudget || session.runtime.toolsDisabled;
    const toolChoice: 'auto' | 'none' = toolsDisabled ? 'none' : 'auto';
    if (toolsDisabledByBudget && !toolsDisabledMessageSent) {
      toolsDisabledMessageSent = true;
      logger.warn('AGENT', `[${config.name}] Maximum tool calls exceeded, requesting final report...`);
      // Explicit guidance to prevent the model from losing context and returning a greeting
      pushHistory({
        role: 'user',
        content:
          'ALL TOOLS COMPLETED. Using the results from the tools executed above, ' +
          'write the final Markdown report NOW. ' +
          'Do not call any new tools — present a complete and detailed final report from existing findings only. ' +
          'Do NOT write a greeting or "how can I help you".',
      });
    }

    logger.agentThinking(config.name);

    // OpenAI SDK: create() method has 2 overloads:
    //   1) stream:false → returns ChatCompletion
    //   2) stream:true  → returns Stream<ChatCompletionChunk>
    // TypeScript infers a union type covering both: Stream | ChatCompletion
    // Since we don't use stream:true, we always get ChatCompletion,
    // but TS can't know this → .choices access causes a compile error (Stream has no .choices).
    // Solution: skip TS type checking with `any` type + cast as ChatCompletion on each call.
    let response: ChatCompletion | undefined;
    try {
      response = await createTrackedCompletion({
        model: config.model ?? DEFAULT_MODEL,
        messages: buildRequestMessages(config.model ?? DEFAULT_MODEL),
        tools: config.tools.length > 0 ? config.tools : undefined,
        tool_choice: config.tools.length > 0 ? toolChoice : undefined,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      }, {
        reason: 'initial',
      });
    } catch (apiError: unknown) {
      const msg = apiError instanceof Error ? apiError.message : String(apiError);
      const currentModel = config.model ?? DEFAULT_MODEL;

      // Alibaba content filter — switch to fallback model when PII content is detected
      if (msg.includes('DataInspectionFailed') || msg.includes('inappropriate content')) {
        const fallbackModel = FALLBACK_MODELS[0]; // Gemini
        logger.warn('AGENT', `[${config.name}] Alibaba content filter → switching to ${fallbackModel} model...`);
        try {
          response = await createTrackedCompletion({
            model: fallbackModel,
            messages: buildRequestMessages(fallbackModel),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          }, {
            reason: 'content-filter-fallback',
          });
        } catch (fallbackErr) {
          // If fallback model also refuses → graceful degradation, don't crash
          logger.warn('AGENT', `[${config.name}] Fallback model also failed — content filter cannot be bypassed.`);
          return {
            finalResponse: '⚠️ This query was caught by the content filter. Try rephrasing the question or changing the topic.',
            toolsUsed,
            toolCallCount,
            history,
          };
        }
      }
      // OpenRouter rate limit — exponential backoff + fallback model chain
      else if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests')) {
        // 1st attempt: same model, wait 5s
        const waitMs = 5000;
        logger.warn('AGENT', `[${config.name}] Rate limit (429) — waiting ${waitMs / 1000}s before retrying...`);
        await _delay(waitMs);
        try {
          response = await createTrackedCompletion({
            model: currentModel,
            messages: buildRequestMessages(currentModel),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          }, {
            reason: 'rate-limit-retry',
          });
        } catch (retryErr) {
          // 2nd attempt: try fallback models sequentially
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (retryMsg.includes('429') || retryMsg.toLowerCase().includes('rate limit')) {
            for (const fbModel of FALLBACK_MODELS) {
              if (fbModel === currentModel) continue; // skip same model
              logger.warn('AGENT', `[${config.name}] 429 persists — trying fallback: ${fbModel}`);
              await _delay(2000);
              try {
                response = await createTrackedCompletion({
                  model: fbModel,
                  messages: buildRequestMessages(fbModel),
                  tools: config.tools.length > 0 ? config.tools : undefined,
                  tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                  max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
                }, {
                  reason: 'rate-limit-fallback',
                });
                logger.info('AGENT', `[${config.name}] Fallback successful: ${fbModel}`);
                break; // success → exit loop
              } catch {
                // this fallback also failed → try next
                continue;
              }
            }
            if (!response?.choices?.[0]) {
              throw new Error(`All models rate limited (429) — wait a moment and try again.`);
            }
          } else {
            throw retryErr;
          }
        }
      }
        // Other transient errors (502, 504, 529) — retry with same model
      else if (msg.includes('502') || msg.includes('504') || msg.includes('529') || msg.includes('InternalError') || msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('timeout')) {
        logger.warn('AGENT', `[${config.name}] API transient error (${msg.slice(0, 60)}...), waiting 3s before retrying...`);
        await _delay(3000);
        response = await createTrackedCompletion({
          model: currentModel,
          messages: buildRequestMessages(currentModel),
          tools: config.tools.length > 0 ? config.tools : undefined,
          tool_choice: config.tools.length > 0 ? toolChoice : undefined,
          max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        }, {
          reason: 'transient-retry',
        });
      }
      else {
        throw apiError;
      }
    }

    // OpenRouter sometimes returns an object without choices on error
    const respAny = response as unknown as Record<string, unknown>;
    if (!response?.choices?.[0]) {
      if (respAny['error']) {
        const upstreamErr = JSON.stringify(respAny['error']);
        // Log actual error content — to understand what broke
        logger.error('AGENT', `[${config.name}] OpenRouter upstream error: ${upstreamErr.slice(0, 500)}`);

        // 429 rate limit → try fallback model chain (429 received in response body)
        if (upstreamErr.includes('429') || upstreamErr.toLowerCase().includes('rate limit') || upstreamErr.toLowerCase().includes('too many requests')) {
          const currentModel = config.model ?? DEFAULT_MODEL;
          for (const fbModel of FALLBACK_MODELS) {
            if (fbModel === currentModel) continue;
            logger.warn('AGENT', `[${config.name}] Response-body 429 → trying fallback: ${fbModel}`);
            await _delay(2000);
            try {
              response = await createTrackedCompletion({
                model: fbModel,
                messages: buildRequestMessages(fbModel),
                tools: config.tools.length > 0 ? config.tools : undefined,
                tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
              }, {
                reason: 'response-body-rate-limit-fallback',
              });
              if (response?.choices?.[0]) {
                logger.info('AGENT', `[${config.name}] Fallback successful: ${fbModel}`);
                break;
              }
            } catch {
              continue;
            }
          }
          if (!response?.choices?.[0]) {
            throw new Error(`All models rate limited (429) — wait a moment and try again.`);
          }
        }
        // Alibaba content filter → switch to fallback model
        else if (upstreamErr.includes('DataInspectionFailed')) {
          const fallbackModel = FALLBACK_MODELS[0];
          logger.warn('AGENT', `[${config.name}] Alibaba DataInspection → trying ${fallbackModel} fallback...`);
          response = await createTrackedCompletion({
            model: fallbackModel,
            messages: buildRequestMessages(fallbackModel),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          }, {
            reason: 'response-body-content-filter-fallback',
          });
          // Check again after fallback
          if (!response?.choices?.[0]) {
            throw new Error(`Model error (fallback also failed): ${upstreamErr.slice(0, 200)}`);
          }
        }
        // 502 / tokenization error (TextEncodeInput) → switch to fallback model
        // DeepSeek V4 Flash crashes with "TextEncodeInput must be Union..." when context is large
        else if (upstreamErr.includes('TextEncodeInput')) {
          const currentModel502 = config.model ?? DEFAULT_MODEL;
          logger.warn('AGENT', `[${config.name}] 502/tokenization error → trying fallback model chain...`);
          let recovered = false;
          for (const fbModel of FALLBACK_MODELS) {
            if (fbModel === currentModel502) continue;
            await _delay(2000);
            try {
              response = await createTrackedCompletion({
                model: fbModel,
                messages: buildRequestMessages(fbModel),
                tools: config.tools.length > 0 ? config.tools : undefined,
                tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
              }, {
                reason: 'response-body-502-fallback',
              });
              if (response?.choices?.[0]) {
                logger.info('AGENT', `[${config.name}] 502 fallback successful: ${fbModel}`);
                recovered = true;
                break;
              }
            } catch { continue; }
          }
          if (!recovered || !response?.choices?.[0]) {
            // Last resort: force text response with truncated context
            const toolResults = collectRecoveryToolEvidenceBlocks().join('\n---\n');
            if (toolResults.trim().length === 0) {
              throw new Error(`502/tokenization error — all fallbacks failed: ${upstreamErr.slice(0, 200)}`);
            }
            logger.warn('AGENT', `[${config.name}] All 502 fallbacks failed — forcing synthesis with truncated context.`);
            const truncatedData = toolResults.length > 10000 ? toolResults.slice(0, 10000) + '\n[...truncated]' : toolResults;
            const recoverySystemPrompt = history.find(message => message.role === 'system' && typeof message.content === 'string');
            const recoveryUserPrompt = [...history].reverse().find(
              message => message.role === 'user'
                && typeof message.content === 'string'
                && !isInternalControlPrompt(message.content as string)
            );
            try {
              const cleanResp = await createTrackedCompletion({
                model: FALLBACK_MODELS[0],
                messages: [
                  {
                    role: 'system',
                    content: `${typeof recoverySystemPrompt?.content === 'string' ? recoverySystemPrompt.content.slice(0, 3000) + '\n\n' : ''}Summarize the research data in Markdown. Preserve the original task filters, evidence rules, and limitation handling. Write only the report.`,
                  },
                  {
                    role: 'user',
                    content: `Original task:\n${typeof recoveryUserPrompt?.content === 'string' ? recoveryUserPrompt.content : 'Unknown'}\n\nResearch data:\n${truncatedData}`,
                  },
                ],
                max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
              }, {
                reason: '502-truncated-recovery',
                phase: 'recovery',
              });
              const text = cleanResp.choices?.[0]?.message?.content?.trim() ?? '';
              const cleanedText = stripThinkingTokens(text);
              if (cleanedText.length > 50) {
                pushHistory({ role: 'assistant', content: cleanedText });
                return { finalResponse: cleanedText, toolCallCount, toolsUsed, session: rebuildAgentSession(config.name, history), history };
              }
            } catch { /* clean call also failed */ }
            throw new Error(`502/tokenization error — all fallbacks failed: ${upstreamErr.slice(0, 200)}`);
          }
        }
        // Invalid JSON argument error → give the model a chance to correct (max 3 attempts)
        // 504 upstream timeout / operation aborted → try fallback model chain
        else if (upstreamErr.includes('504') || upstreamErr.toLowerCase().includes('aborted') || upstreamErr.toLowerCase().includes('timeout')) {
          const currentModel504 = config.model ?? DEFAULT_MODEL;
          logger.warn('AGENT', `[${config.name}] 504/timeout upstream error → trying fallback model chain...`);
          let recovered = false;
          for (const fbModel of FALLBACK_MODELS) {
            if (fbModel === currentModel504) continue;
            await _delay(3000);
            try {
              response = await createTrackedCompletion({
                model: fbModel,
                messages: buildRequestMessages(fbModel),
                tools: config.tools.length > 0 ? config.tools : undefined,
                tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
              }, {
                reason: 'response-body-timeout-fallback',
              });
              if (response?.choices?.[0]) {
                logger.info('AGENT', `[${config.name}] Fallback successful after 504: ${fbModel}`);
                recovered = true;
                break;
              }
            } catch { continue; }
          }
          if (!recovered || !response?.choices?.[0]) {
            throw new Error(`504 upstream timeout — all fallback models failed. Wait a moment and try again.`);
          }
        }
        else if (upstreamErr.includes('function.arguments') || upstreamErr.includes('InvalidParameter')) {
          // When tools are disabled or model still tries to call tools after 3 corrections
          if (toolsDisabled || totalCorrectionAttempts >= 3) {
            forceTextRetries++
            if (forceTextRetries > 1) {
              // Still failing on 2nd attempt → make a clean API call (with rich context from session files)
              logger.warn('AGENT', `[${config.name}] Model insists on calling tools — trying clean text response with context from session files.`)

              // Read rich context from session files (instead of 2000 char limit)
              let contextSnippet = ''
              const sessionDir = path.resolve(__dirname, '../../.osint-sessions')
              const sessionFiles = [
                'academic-last-session.md',
                'identity-last-session.md',
                'media-last-session.md',
                'academic-knowledge.md',
                'identity-knowledge.md',
                'media-knowledge.md',
              ]
              for (const f of sessionFiles) {
                try {
                  const content = await readFile(path.join(sessionDir, f), 'utf-8')
                  if (content.length > 100) {
                    // Take at most 3000 chars from each session file, max 8000 total
                    const slice = content.length > 3000 ? content.slice(0, 3000) + '\n[...truncated]' : content
                    contextSnippet += `\n\n--- ${f} ---\n${slice}`
                    if (contextSnippet.length > 8000) break
                  }
                } catch { /* skip if file doesn't exist */ }
              }

              // If session files are empty, get context from history
              if (contextSnippet.length < 200) {
                const toolResults = history
                  .filter(m => m.role === 'tool' && typeof m.content === 'string')
                  .map(m => (m.content as string))
                contextSnippet = toolResults.join('\n---\n')
                if (contextSnippet.length > 6000) {
                  contextSnippet = contextSnippet.slice(0, 6000) + '\n[...truncated]'
                }
              }

              const lastUserMsg = [...history].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && !(m.content as string).startsWith('TOOL_CALL_DISABLED') && !(m.content as string).startsWith('JSON'))
              const userQuestion = lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : 'User question'

              try {
                const cleanResponse = await createTrackedCompletion({
                  model: config.model ?? DEFAULT_MODEL,
                  messages: [
                    { role: 'system', content: 'You are an OSINT research assistant. Analyze the provided research data and summarize it in Markdown format. Do not call any tools — only write plain text.' },
                    { role: 'user', content: `The user asked: "${userQuestion}"\n\nBelow is the research data. Create a detailed Markdown report using this data:\n\n${contextSnippet}` },
                  ],
                  // no tools parameter — model cannot call tools
                  max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
                }, {
                  reason: 'clean-text-recovery',
                  phase: 'recovery',
                })
                const text = cleanResponse.choices?.[0]?.message?.content?.trim()
                if (text) {
                  const cleaned = stripThinkingTokens(text)
                  if (cleaned.length > 50) {
                    pushHistory({ role: 'assistant', content: cleaned });
                    return { finalResponse: cleaned, toolCallCount, toolsUsed, session: rebuildAgentSession(config.name, history) }
                  }
                }
              } catch (cleanErr) {
                logger.error('AGENT', `[${config.name}] Clean API call also failed: ${(cleanErr as Error).message}`)
              }
              const fallbackResponse = 'Model could not generate a response. Collected data has been saved to session files — check the `.osint-sessions/` directory.';
              pushHistory({ role: 'assistant', content: fallbackResponse });
              return {
                finalResponse: fallbackResponse,
                toolCallCount,
                toolsUsed,
                session: rebuildAgentSession(config.name, history),
                history,
              }
            }
            logger.warn('AGENT', `[${config.name}] JSON error + tools disabled — forcing text response (${forceTextRetries}/1).`)
            // Fix broken history: add assistant placeholder after tool message
            const lastMsgForce = history[history.length - 1];
            if (lastMsgForce && (lastMsgForce.role === 'tool' || lastMsgForce.role === 'user')) {
              if (lastMsgForce.role === 'tool') {
                pushHistory({ role: 'assistant', content: 'Tool call failed, providing text response.' });
              }
              pushHistory({ role: 'user', content: 'Do not call any tools. Present all collected data directly as text.' });
            }
            config = { ...config, tools: [] }
            continue
          }

          correctionRetries++;
          totalCorrectionAttempts++;
          logger.warn('AGENT', `[${config.name}] Model produced invalid JSON, requesting correction... (attempt ${correctionRetries}/3, total: ${totalCorrectionAttempts})`);

          // CRITICAL: If the last message in history is 'tool', add a placeholder assistant message
	          // before the correction user message. Otherwise:
          // tool → user  (INVALID FORMAT — OpenRouter/model produces broken response)
          //   tool → assistant → user  (CORRECT FORMAT)
          const lastMsg = history[history.length - 1];
          if (lastMsg && lastMsg.role === 'tool') {
            pushHistory({
              role: 'assistant',
              content: 'Tool call produced invalid JSON, correcting.',
            });
          }

          // Global cap: after 3 total attempts, force text response
          if (totalCorrectionAttempts >= 3) {
            logger.error('AGENT', `[${config.name}] JSON correction failed 3 times — disabling tool calls.`);
            pushHistory({
              role: 'user',
              content:
                'TOOL_CALL_DISABLED. Respond directly in Markdown text using all the information you have collected. ' +
                'Do not call any tools — write text only.',
            });
            toolCallCountFloor = maxToolCalls + 1;
            correctionRetries = 0;
            continue;
          }

          if (correctionRetries >= 2) {
            correctionRetries = 0;
            pushHistory({
              role: 'user',
              content:
                'TOOL_CALL_DISABLED FAILED. Stop calling tools and summarize the collected data directly in Markdown text. ' +
                'Do not call any tools — not save_finding, not generate_report, NOTHING. Write plain text only.',
            });
          } else {
            pushHistory({
              role: 'user',
              content: 'The previous tool call had invalid JSON format. ' +
                'Call a single tool and keep the arguments very short. ' +
                'If you are trying to call too many tools, STOP and write the results as text.',
            });
          }
          continue;
        }
        if (!response?.choices?.[0]) {
          throw new Error(`Upstream API error: ${upstreamErr}`);
        }
      }
      if (!response?.choices?.[0]) {
        throw new Error(`Invalid API response: no choices. Response: ${JSON.stringify(response)}`);
      }
    }

    const message = response.choices[0].message;

    // Sanitize tool_calls with invalid JSON arguments BEFORE pushing to history.
    // A broken function.arguments in an assistant message causes Alibaba to reject
    // every subsequent API call with InvalidParameter (502). By replacing bad args
    // with a sentinel object here we keep the history structurally valid so the
    // next request succeeds and the model receives a clear error result.
    const sanitizedToolCalls = message.tool_calls?.map(tc => {
      if (tc.type !== 'function') return tc;
      try {
        JSON.parse(tc.function.arguments);
        return tc; // valid JSON — no change
      } catch {
        logger.warn('AGENT',
          `[${config.name}] Tool call '${tc.function.name}' has malformed JSON args (likely content too long) — sanitizing`);
        return {
          ...tc,
          function: { ...tc.function, arguments: JSON.stringify({ _sanitized: true }) },
        };
      }
    });

    const messageForHistory = sanitizedToolCalls
      ? ({ ...message, tool_calls: sanitizedToolCalls } as typeof message)
      : message;
    pushHistory(normalizeAssistantMessage(messageForHistory));

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const rawContent = typeof message.content === 'string' ? message.content : '';
      const cleanContent = stripThinkingTokens(rawContent);

      const refusalText = typeof message.refusal === 'string' && message.refusal.trim().length > 0
        ? message.refusal
        : '';

      // Thinking models may write everything inside <think>...</think> and leave the final response empty.
      // stripThinkingTokens() removes those tags → cleanContent = "".
      // Solution: 3 retries with increasing aggressiveness:
      //   1. Politely request a report
      //   2. Disable tools, request text only
      //   3. Make a new clean API call (system prompt + only the last tool results)
      if (cleanContent.length === 0 && emptyRetries < 3) {
        emptyRetries++;
        logger.warn('AGENT', `[${config.name}] Model returned empty response (attempt ${emptyRetries}/3)...`);

        if (emptyRetries === 1) {
          pushHistory({
            role: 'user',
            content: 'IMPORTANT: Using the tool results above, write a comprehensive Markdown report NOW. ' +
              'Write your answer DIRECTLY OUTSIDE of any <think> tag. I want the final report, not a thinking block.'
          });
        } else if (emptyRetries === 2) {
          // Disable tools completely, request text-only response
          config = { ...config, tools: [] };
          pushHistory({
            role: 'user',
            content: 'Stop calling tools. Summarize ALL the information you have collected above as PLAIN TEXT ONLY. ' +
              'Use Markdown headings and lists. Do NOT use <think> tags — write only the final answer.'
          });
        } else {
          // 3rd attempt: collect tool results from history and make a clean API call
          const toolResults = history
            .filter(m => m.role === 'tool' && typeof m.content === 'string')
            .map(m => m.content as string)
            .join('\n---\n')
            .slice(0, 8000);
          try {
            const cleanResp = await createTrackedCompletion({
              model: config.model ?? DEFAULT_MODEL,
              messages: [
                { role: 'system', content: 'You are an assistant that summarizes research data in Markdown format. Write only the final report, do not use <think>.' },
                { role: 'user', content: `Research data:\n${toolResults}\n\nCreate a detailed Markdown report using this data.` },
              ],
              max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
            }, {
              reason: 'empty-response-clean-recovery',
              phase: 'recovery',
            });
            const text = cleanResp.choices?.[0]?.message?.content?.trim() ?? '';
            const cleaned = stripThinkingTokens(text);
            if (cleaned.length > 50) {
              pushHistory({ role: 'assistant', content: cleaned });
              return { finalResponse: cleaned, toolCallCount, toolsUsed, session: rebuildAgentSession(config.name, history) };
            }
          } catch { /* clean call also failed → return fallback message below */ }
        }
        continue;
      }

      const finalText = cleanContent.length > 0
        ? cleanContent
        : (refusalText || 'Tools completed but the model returned an empty response.');

      return {
        finalResponse: finalText,
        toolCallCount,
        toolsUsed,
        session: rebuildAgentSession(config.name, history),
        history,
      };
    }

    const pendingFollowUpUserMessages: string[] = [];
    const verificationTools = ['run_sherlock', 'run_maigret', 'cross_reference', 'verify_profiles',
      'run_github_osint', 'check_email_registrations', 'scrape_profile', 'verify_claim',
      'nitter_profile', 'web_fetch', 'auto_visual_intel'];
    const searchCountBeforeBatch = (toolsUsed['search_web'] ?? 0) + (toolsUsed['search_web_multi'] ?? 0);
    const verificationCountBeforeBatch = countSuccessfulVerificationCalls(verificationTools);
    let batchSearchCount = 0;
    let batchVerificationCount = 0;
    for (const toolCall of (sanitizedToolCalls ?? message.tool_calls ?? [])) {
      if (toolCall.type !== 'function') continue;
      let result = '';
      let followUpUserMessage: string | null = null;
      const toolName = toolCall.function.name;
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, string>;
        if (toolName === 'search_web' || toolName === 'search_web_multi') {
          batchSearchCount++;
        }

        // Detect calls that were sanitized due to invalid JSON arguments.
        // Give the model a clear error instead of trying to execute with empty/wrong args.
        if ('_sanitized' in args) {
          result = `[TOOL_ARGS_INVALID] The arguments for '${toolName}' contained invalid JSON ` +
            `(the content was too long or had unescaped special characters). ` +
            `Do NOT call obsidian tools with large content. ` +
            `Write the report text directly in your response instead of saving it to Obsidian.`;
          emitProgress(`  ❌ ${toolName} → Args had invalid JSON (too long/unescaped) — skipped`);
          pushHistory({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
          toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;
          toolCallCount++;
          toolCallCountFloor = toolCallCount;
          continue;
        }

        const cacheKey = buildToolCacheKey(toolName, args);

        // Per-tool hard limit check
        perToolCount[toolName] = (perToolCount[toolName] ?? 0) + 1;
        const toolLimit = PER_TOOL_LIMITS[toolName];
        if (toolLimit && perToolCount[toolName] > toolLimit) {
          logger.warn('AGENT', `[${config.name}] ${toolName} hard limit exceeded (${toolLimit}). Skipping.`);
          result = `[TOOL_LIMIT] ${toolName} has been called ${toolLimit} times in this session — limit reached. Continue with existing data and write a report.`;
        } else if (callCache.has(cacheKey)) {
          logger.warn('AGENT', `[${config.name}] Duplicate tool call blocked: ${toolName} (same arguments)`);
          result = `[DUPLICATE_CALL] This query was called before and the result is already in history. Try a different query or move to the next phase.\n\n[cached: ${(callCache.get(cacheKey) ?? '').slice(0, 500)}...]`;
        } else {
          // Build a short arg summary (written to log panel)
          const argSummary = Object.entries(args)
            .slice(0, 2)
            .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
            .join(', ');
          emitProgress(`  🔧 ${toolName}(${argSummary})`);
          result = await config.executeTool(toolName, args);
          callCache.set(cacheKey, result);

          // Stagnation detection: count new URLs in search results
          if (toolName === 'search_web' || toolName === 'search_web_multi') {
            const urlMatches = result.match(/https?:\/\/[^\s|\]]+/g) || [];
            const newUrls = urlMatches.filter(u => !seenUrls.has(u));
            newUrls.forEach(u => seenUrls.add(u));
            if (newUrls.length <= 2) {
              lowYieldStreak++;
            } else {
              lowYieldStreak = 0;
            }
            if (lowYieldStreak >= LOW_YIELD_THRESHOLD) {
              logger.warn('AGENT', `[${config.name}] Stagnation detected: ${lowYieldStreak} consecutive low-yield searches. Forcing synthesis.`);
              emitProgress(`⚠️ [${config.name}] Stagnation: ${lowYieldStreak} searches with no new results — forcing report synthesis.`);
              followUpUserMessage =
                '⚠️ STAGNATION DETECTED: Your recent searches are returning no new information. ' +
                'STOP searching immediately. Synthesize a final report from the data you already have. ' +
                'If you cannot fully answer the query, state what you found and what is missing.';
              lowYieldStreak = 0; // Reset to prevent repeated injections
            }
          }
          // TUI: short preview (first line, 80 chars)
          const resultPreview = result.split('\n')[0].slice(0, 80);
          emitProgress(`  ✓ ${toolName} → ${resultPreview}`);
          // Web log: full output (untruncated)
          emitToolDetail(toolName, result, toolCall.id);
        }
      } catch (error) {
        result = `Tool error (${toolName}): ${(error as Error).message}`;
        emitProgress(`  ❌ ${toolName} → ${(error as Error).message.slice(0, 80)}`);
      }
      pushHistory({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof result === 'string' && result.trim().length > 0
          ? result
          : normalizeToolContent(result),
      });
      if (followUpUserMessage) {
        if (!pendingFollowUpUserMessages.includes(followUpUserMessage)) {
          pendingFollowUpUserMessages.push(followUpUserMessage);
        }
      }
      if (verificationTools.includes(toolName) && isSuccessfulVerificationResult(toolName, result)) {
        batchVerificationCount++;
      }
      toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;
      toolCallCount++;
      toolCallCountFloor = toolCallCount;
    }

    const totalSearchCount = searchCountBeforeBatch + batchSearchCount;
    const totalVerificationCount = verificationCountBeforeBatch + batchVerificationCount;
    const crossedDiversityThreshold = Array.from({ length: batchSearchCount }, (_, index) => searchCountBeforeBatch + index + 1)
      .some(count => count >= 4 && count % 4 === 0);
    if (batchSearchCount > 0 && crossedDiversityThreshold && totalVerificationCount === 0) {
      const availableTools = verificationTools.filter(toolName =>
        config.tools.some((tool: any) => tool.type === 'function' && tool.function.name === toolName)
      );
      if (availableTools.length > 0) {
        const diversityMessage =
          '⚠️ TOOL DIVERSITY REQUIREMENT: You have made ' + totalSearchCount + ' search calls but used ZERO verification/deep-dive tools. ' +
          'Before making any more searches, you MUST call at least one of: ' + availableTools.slice(0, 5).join(', ') + '. ' +
          'Search-only investigations produce unreliable results. Verify your findings NOW.';
        if (!pendingFollowUpUserMessages.includes(diversityMessage)) {
          pendingFollowUpUserMessages.push(diversityMessage);
        }
        logger.warn('AGENT', `[${config.name}] Search-only loop detected (${totalSearchCount} searches, 0 verification). Forcing diversity.`);
      }
    }

    for (const pendingMessage of pendingFollowUpUserMessages) {
      pushHistory({
        role: 'user',
        content: pendingMessage,
      });
    }
  }
}

import { appendFile, mkdir } from 'fs/promises'
import path from 'path'
import type { Message } from '../agents/types.js'

interface ModelTelemetryMeta {
  contextLimit?: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
}

interface UsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

export interface LLMTelemetryEvent {
  ts: string
  agent: string
  phase?: string
  reason: string
  attempt: number
  requestedModel: string
  actualModel: string
  responseId?: string
  status: 'success' | 'error'
  latencyMs: number
  messageCount: number
  sanitizedChars: number
  approxPromptTokens: number
  contextLimit?: number
  contextPct?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedPromptTokens?: number
  reasoningTokens?: number
  inputCostUsd?: number
  outputCostUsd?: number
  totalCostUsd?: number
  costEstimated: boolean
  errorMessage?: string
}

const MODEL_METADATA: Record<string, ModelTelemetryMeta> = {
  'minimax/minimax-m2.7': {
    contextLimit: 196608,
    inputUsdPerMillion: 0.30,
    outputUsdPerMillion: 1.20,
  },
  'minimax/minimax-m2.5': {
    contextLimit: 196608,
    inputUsdPerMillion: 0.118,
    outputUsdPerMillion: 0.99,
  },
  'minimax/minimax-m2.5:free': {
    contextLimit: 196608,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  },
  'minimax/minimax-m2.1': {
    contextLimit: 196608,
  },
  'qwen/qwen3.6-plus': {
    contextLimit: 1_000_000,
    inputUsdPerMillion: 0.325,
    outputUsdPerMillion: 1.95,
  },
}

function resolveModelMeta(modelName: string): ModelTelemetryMeta | undefined {
  if (MODEL_METADATA[modelName]) return MODEL_METADATA[modelName]

  const directMatch = Object.entries(MODEL_METADATA).find(([key]) => modelName.startsWith(key))
  if (directMatch) return directMatch[1]

  return undefined
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function normalizeUsage(usage?: UsageLike): {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedPromptTokens?: number
  reasoningTokens?: number
} {
  const promptTokens = toNumber(usage?.prompt_tokens) ?? toNumber(usage?.input_tokens)
  const completionTokens = toNumber(usage?.completion_tokens) ?? toNumber(usage?.output_tokens)
  const totalTokens = toNumber(usage?.total_tokens) ??
    (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined)
  const cachedPromptTokens =
    toNumber(usage?.prompt_tokens_details?.cached_tokens) ??
    toNumber(usage?.input_tokens_details?.cached_tokens)
  const reasoningTokens =
    toNumber(usage?.completion_tokens_details?.reasoning_tokens) ??
    toNumber(usage?.output_tokens_details?.reasoning_tokens)

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    reasoningTokens,
  }
}

export function estimateMessageChars(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? JSON.stringify(message.content)
        : ''
    const toolCalls = 'tool_calls' in message && message.tool_calls
      ? JSON.stringify(message.tool_calls)
      : ''
    return sum + content.length + toolCalls.length
  }, 0)
}

function estimateCostUsd(
  modelName: string,
  promptTokens?: number,
  completionTokens?: number,
): {
  inputCostUsd?: number
  outputCostUsd?: number
  totalCostUsd?: number
  costEstimated: boolean
} {
  const meta = resolveModelMeta(modelName)
  if (
    !meta ||
    meta.inputUsdPerMillion === undefined ||
    meta.outputUsdPerMillion === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined
  ) {
    return { costEstimated: false }
  }

  const inputCostUsd = (promptTokens / 1_000_000) * meta.inputUsdPerMillion
  const outputCostUsd = (completionTokens / 1_000_000) * meta.outputUsdPerMillion

  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    costEstimated: true,
  }
}

export function buildLLMTelemetryEvent(input: {
  agent: string
  phase?: string
  reason: string
  attempt: number
  requestedModel: string
  actualModel?: string
  responseId?: string
  status: 'success' | 'error'
  latencyMs: number
  messages: Message[]
  usage?: UsageLike
  errorMessage?: string
}): LLMTelemetryEvent {
  const actualModel = input.actualModel ?? input.requestedModel
  const sanitizedChars = estimateMessageChars(input.messages)
  const approxPromptTokens = Math.ceil(sanitizedChars / 4)
  const normalizedUsage = normalizeUsage(input.usage)
  const modelMeta = resolveModelMeta(actualModel) ?? resolveModelMeta(input.requestedModel)
  const contextBase = normalizedUsage.promptTokens ?? approxPromptTokens
  const contextPct = modelMeta?.contextLimit
    ? Number(((contextBase / modelMeta.contextLimit) * 100).toFixed(1))
    : undefined
  const estimatedCosts = estimateCostUsd(actualModel, normalizedUsage.promptTokens, normalizedUsage.completionTokens)

  return {
    ts: new Date().toISOString(),
    agent: input.agent,
    phase: input.phase,
    reason: input.reason,
    attempt: input.attempt,
    requestedModel: input.requestedModel,
    actualModel,
    responseId: input.responseId,
    status: input.status,
    latencyMs: input.latencyMs,
    messageCount: input.messages.length,
    sanitizedChars,
    approxPromptTokens,
    contextLimit: modelMeta?.contextLimit,
    contextPct,
    promptTokens: normalizedUsage.promptTokens,
    completionTokens: normalizedUsage.completionTokens,
    totalTokens: normalizedUsage.totalTokens,
    cachedPromptTokens: normalizedUsage.cachedPromptTokens,
    reasoningTokens: normalizedUsage.reasoningTokens,
    inputCostUsd: estimatedCosts.inputCostUsd,
    outputCostUsd: estimatedCosts.outputCostUsd,
    totalCostUsd: estimatedCosts.totalCostUsd,
    costEstimated: estimatedCosts.costEstimated,
    errorMessage: input.errorMessage,
  }
}

function formatTokenCount(value?: number): string {
  if (value === undefined) return 'n/a'
  if (value >= 1000) {
    const fractionDigits = value >= 10000 ? 0 : 1
    return `${(value / 1000).toFixed(fractionDigits)}k`
  }
  return String(value)
}

function formatUsd(value?: number): string {
  if (value === undefined) return 'n/a'
  if (value === 0) return '$0.00000'
  return `$${value.toFixed(5)}`
}

export function formatLLMTelemetryLine(event: LLMTelemetryEvent): string {
  const model = event.actualModel || event.requestedModel
  const promptLabel = event.promptTokens === undefined ? 'prompt_est' : 'prompt'
  const prompt = formatTokenCount(event.promptTokens ?? event.approxPromptTokens)
  const completion = formatTokenCount(event.completionTokens)
  const total = formatTokenCount(event.totalTokens)
  const contextText = event.contextPct !== undefined ? `${event.contextPct}%` : 'n/a'
  const costText = formatUsd(event.totalCostUsd)
  const statusText = event.status === 'error' ? `error=${event.errorMessage ?? 'unknown'}` : `total=${total}`

  return `📈 [${event.agent}] model=${model} ${promptLabel}=${prompt} completion=${completion} ${statusText} ctx=${contextText} cost=${costText} ${event.latencyMs}ms reason=${event.reason}`
}

export async function persistLLMTelemetryEvent(event: LLMTelemetryEvent): Promise<void> {
  if (process.env.LLM_TELEMETRY_PERSIST === '0') return

  const dir = path.join(process.cwd(), '.osint-sessions', 'telemetry')
  const fileName = `${event.ts.slice(0, 10)}.jsonl`

  await mkdir(dir, { recursive: true })
  await appendFile(path.join(dir, fileName), `${JSON.stringify(event)}\n`, 'utf-8')
}

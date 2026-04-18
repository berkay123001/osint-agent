import OpenAI from 'openai'

export type Message = OpenAI.Chat.ChatCompletionMessageParam

const EMPTY_ASSISTANT_FALLBACK = 'Tools completed but the model returned an empty response.'
const EMPTY_TOOL_FALLBACK = 'Tool produced no output.'

const TOOL_RESULT_MAX_CHARS = 3000

export function normalizeToolContent(content: string | null | undefined): string {
  const text = typeof content === 'string' ? content.trim() : ''
  const result = text || EMPTY_TOOL_FALLBACK
  if (result.length > TOOL_RESULT_MAX_CHARS) {
    return result.slice(0, TOOL_RESULT_MAX_CHARS) + `\n... [result truncated, total ${result.length} characters]`
  }
  return result
}

export function normalizeAssistantMessage(
  message: OpenAI.Chat.ChatCompletionMessage
): OpenAI.Chat.ChatCompletionMessageParam {
  const hasToolCalls = Boolean(message.tool_calls?.length)
  const refusal = typeof message.refusal === 'string' && message.refusal.trim().length > 0
    ? message.refusal
    : ''
  const content = typeof message.content === 'string' && message.content.trim().length > 0
    ? message.content
    : (refusal || (hasToolCalls ? '' : EMPTY_ASSISTANT_FALLBACK))

  return {
    role: 'assistant',
    content,
    ...(hasToolCalls ? { tool_calls: message.tool_calls } : {}),
  } as OpenAI.Chat.ChatCompletionMessageParam
}

/**
 * Maximum total character count to send to the provider.
 * Qwen3.5-plus produces broken JSON tool_calls in large histories.
 * This limit corresponds to ~60K tokens (safe zone).
 */
const MAX_TOTAL_HISTORY_CHARS = 120_000

export function sanitizeHistoryForProvider(history: Message[]): Message[] {
  const sanitized = history.map((message) => {
    if (message.role === 'assistant') {
      const refusal = typeof message.refusal === 'string' && message.refusal.trim().length > 0
        ? message.refusal
        : ''
      const content = typeof message.content === 'string' && message.content.length > 0
        ? message.content
        : (refusal || (message.tool_calls?.length ? '' : EMPTY_ASSISTANT_FALLBACK))

      return {
        ...message,
        content,
      }
    }

    if (message.role === 'tool') {
      const content = typeof message.content === 'string'
        ? normalizeToolContent(message.content)
        : EMPTY_TOOL_FALLBACK

      return {
        ...message,
        content,
      }
    }

    return message
  })

  // Calculate total character count
  const totalChars = sanitized.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    const tc = (m as any).tool_calls ? JSON.stringify((m as any).tool_calls) : ''
    return sum + c.length + tc.length
  }, 0)

  if (totalChars <= MAX_TOTAL_HISTORY_CHARS) return sanitized

  // Limit exceeded — find a safe cut point.
  // CRITICAL: a tool message must not be separated from its assistant(tool_calls) parent.
  // Instead of taking "last N messages", walk backwards to find
  // the first clean start point (user or tool_calls-free assistant).
  const system = sanitized[0]

  // Walk backwards until total chars ≤ MAX or a safe cut is found
  const TARGET_CHARS = Math.floor(MAX_TOTAL_HISTORY_CHARS * 0.7) // 70% target — safe margin
  let cutIndex = sanitized.length
  let accChars = 0
  for (let i = sanitized.length - 1; i >= 1; i--) {
    const m = sanitized[i]
    const c = typeof m.content === 'string' ? m.content : ''
    const tc = (m as any).tool_calls ? JSON.stringify((m as any).tool_calls) : ''
    accChars += c.length + tc.length
    if (accChars >= TARGET_CHARS) {
      // Raw cut here — advance until a user message or tool_calls-free assistant is found
      cutIndex = i
      break
    }
  }

  // Find safe start from cutIndex:
  // Must begin with a 'user' message or 'assistant' without tool_calls.
  // Starting with a 'tool' or tool_calls-bearing 'assistant' is forbidden.
  let safeStart = cutIndex
  while (safeStart < sanitized.length) {
    const m = sanitized[safeStart]
    const isToolMsg = m.role === 'tool'
    const isAssistantWithToolCalls = m.role === 'assistant' && !!(m as any).tool_calls?.length
    if (!isToolMsg && !isAssistantWithToolCalls) break
    safeStart++
  }

  // section from safeStart to end + system — safe set
  const recent = sanitized.slice(safeStart)
  if (recent.length === 0) {
    // No safe messages found → only system + last user message
    const lastUser = [...sanitized].reverse().find(m => m.role === 'user')
    return lastUser ? [system, lastUser] : [system]
  }

  // ── Context bridge: reconstruct context from dropped messages ──────────────────────────
  // After trimming, the first message may be a short follow-up like "what" or "continue".
  // The model then resets the conversation ("Hello! How can I help you?").
  // Solution: extract the original question + last report from the dropped section and inject a context bridge.
  const dropped = sanitized.slice(1, safeStart)
  const firstUserMsg = dropped.find(
    (m): m is Message & { content: string } => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0
  )
  const lastReport = [...dropped].reverse().find(
    (m): m is Message & { content: string } =>
      m.role === 'assistant' &&
      typeof m.content === 'string' &&
      m.content.trim().length > 200 &&
      !(m as any).tool_calls?.length  // plain text response with no tool calls
  )

  const bridgeParts: string[] = ['[CONTEXT: An earlier part of this conversation was trimmed when the context window was full.]']
  if (firstUserMsg) {
    bridgeParts.push(`Original research question: "${firstUserMsg.content.slice(0, 500)}"`)
  }
  if (lastReport) {
    bridgeParts.push(
      `Last finding summary from prior research (first 1000 chars):\n${lastReport.content.slice(0, 1000)}`
    )
  }
  bridgeParts.push(
    `Research is ongoing. Maintain the above context when responding; do NOT write greetings or "how can I help you".`
  )

  const contextBridge: Message = { role: 'user', content: bridgeParts.join('\n\n') }
  const contextAck: Message = { role: 'assistant', content: 'Understood, I am maintaining the research context and continuing from where we left off.' }

  const result = [system, contextBridge, contextAck, ...recent]

  // Still too large — truncate mid messages (do not touch tool_calls-bearing ones)
  const newTotal = result.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    const tc = (m as any).tool_calls ? JSON.stringify((m as any).tool_calls) : ''
    return sum + c.length + tc.length
  }, 0)

  if (newTotal > MAX_TOTAL_HISTORY_CHARS) {
    // Last resort: keep short but do not break tool relationships
    return result.map(m => {
      if (m.role === 'tool' || m.role === 'assistant' && !!(m as any).tool_calls?.length) return m
      const content = typeof m.content === 'string' ? m.content : ''
      if (content.length > 1500) {
        return { ...m, content: content.slice(0, 1500) + '\n... [truncated]' }
      }
      return m
    })
  }

  return result
}
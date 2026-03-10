import OpenAI from 'openai'

export type Message = OpenAI.Chat.ChatCompletionMessageParam

const EMPTY_ASSISTANT_FALLBACK = 'Araçlar çalıştı ancak model boş yanıt döndürdü.'
const EMPTY_TOOL_FALLBACK = 'Tool sonuç üretemedi.'

const TOOL_RESULT_MAX_CHARS = 3000

export function normalizeToolContent(content: string | null | undefined): string {
  const text = typeof content === 'string' ? content.trim() : ''
  const result = text || EMPTY_TOOL_FALLBACK
  if (result.length > TOOL_RESULT_MAX_CHARS) {
    return result.slice(0, TOOL_RESULT_MAX_CHARS) + `\n... [sonuç kısaltıldı, toplam ${result.length} karakter]`
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

export function sanitizeHistoryForProvider(history: Message[]): Message[] {
  return history.map((message) => {
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
}
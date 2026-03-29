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

/**
 * Provider'a gönderilecek maksimum toplam karakter sayısı.
 * Qwen3.5-plus büyük history'de JSON tool_call üretiminde bozuluyor.
 * Bu sınır ~60K token civarına denk geliyor (güvenli bölge).
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

  // Toplam karakter sayısını hesapla
  const totalChars = sanitized.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    const tc = (m as any).tool_calls ? JSON.stringify((m as any).tool_calls) : ''
    return sum + c.length + tc.length
  }, 0)

  if (totalChars <= MAX_TOTAL_HISTORY_CHARS) return sanitized

  // Sınırı aşıyor — system + en son mesajları tut, ortadakileri kısalt
  // İlk mesaj (system) ve son 8 mesaj her zaman korunur
  const KEEP_RECENT = 8
  if (sanitized.length <= KEEP_RECENT + 1) return sanitized

  const system = sanitized[0]
  const recent = sanitized.slice(-KEEP_RECENT)
  const middle = sanitized.slice(1, -KEEP_RECENT)

  // Orta mesajlardan tool result ve assistant content'leri kısalt
  const trimmed = middle.map((m) => {
    const content = typeof m.content === 'string' ? m.content : ''
    if (content.length > 1500) {
      return { ...m, content: content.slice(0, 1500) + '\n... [history kısaltıldı]' }
    }
    return m
  })

  const result = [system, ...trimmed, ...recent]

  // Hâlâ büyükse — sadece system + son mesajları tut
  const newTotal = result.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    return sum + c.length
  }, 0)

  if (newTotal > MAX_TOTAL_HISTORY_CHARS) {
    // Agresif: system + son KEEP_RECENT mesaj sadece
    return [system, ...recent]
  }

  return result
}
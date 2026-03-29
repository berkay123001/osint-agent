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

  // Sınırı aşıyor — güvenli bir kesim noktası bul.
  // KRİTİK: tool mesajı kendi assistant(tool_calls) parent'ından ayrılmamalı.
  // Bu nedenle "son N mesaj" almak yerine, geriye doğru yürüyerek
  // ilk temiz başlangıç noktasını (user veya tool_calls'sız assistant) buluyoruz.
  const system = sanitized[0]

  // Geriye doğru yürü, toplam char ≤ MAX sağlanana veya güvenli kesim bulunana kadar
  const TARGET_CHARS = Math.floor(MAX_TOTAL_HISTORY_CHARS * 0.7) // %70 hedef — güvenli marj
  let cutIndex = sanitized.length
  let accChars = 0
  for (let i = sanitized.length - 1; i >= 1; i--) {
    const m = sanitized[i]
    const c = typeof m.content === 'string' ? m.content : ''
    const tc = (m as any).tool_calls ? JSON.stringify((m as any).tool_calls) : ''
    accChars += c.length + tc.length
    if (accChars >= TARGET_CHARS) {
      // Burayı ham kesme — bir user mesajı veya tool_calls'sız assistant bulana kadar ilerle
      cutIndex = i
      break
    }
  }

  // cutIndex'ten geriye doğru güvenli başlangıç noktası bul:
  // 'user' mesajından veya tool_calls olmayan 'assistant'tan başlamalı.
  // tool veya tool_calls'lı assistant ile başlamak yasak.
  let safeStart = cutIndex
  while (safeStart < sanitized.length) {
    const m = sanitized[safeStart]
    const isToolMsg = m.role === 'tool'
    const isAssistantWithToolCalls = m.role === 'assistant' && !!(m as any).tool_calls?.length
    if (!isToolMsg && !isAssistantWithToolCalls) break
    safeStart++
  }

  // safeStart'tan sona kadar olan kısım + system — güvenli küme
  const recent = sanitized.slice(safeStart)
  if (recent.length === 0) {
    // Hiçbir güvenli mesaj yok → sadece system + son user mesajı
    const lastUser = [...sanitized].reverse().find(m => m.role === 'user')
    return lastUser ? [system, lastUser] : [system]
  }

  const result = [system, ...recent]

  // Hâlâ çok büyükse — orta mesajları kısalt (tool_calls içerenlere dokunma)
  const newTotal = result.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    const tc = (m as any).tool_calls ? JSON.stringify((m as any).tool_calls) : ''
    return sum + c.length + tc.length
  }, 0)

  if (newTotal > MAX_TOTAL_HISTORY_CHARS) {
    // Son çare: kısa tut ama tool ilişkilerini bozma
    return result.map(m => {
      if (m.role === 'tool' || m.role === 'assistant' && !!(m as any).tool_calls?.length) return m
      const content = typeof m.content === 'string' ? m.content : ''
      if (content.length > 1500) {
        return { ...m, content: content.slice(0, 1500) + '\n... [kısaltıldı]' }
      }
      return m
    })
  }

  return result
}
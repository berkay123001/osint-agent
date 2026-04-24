import type {
  AgentSessionSnapshot,
  Message,
  ToolCallMemory,
  ToolEpisodeMemory,
} from '../agents/types.js'
import { STRATEGY_REVIEW_INTERNAL_PREFIXES } from '../agents/reviewContinuation.js'
import { normalizeHistoryForSession } from './chatHistory.js'

const URL_REGEX = /https?:\/\/[^\s|)\]]+/gi

const INTERNAL_USER_PREFIXES = [
  '[CONTEXT: An earlier part of this conversation was trimmed when the context window was full.]',
  'ALL TOOLS COMPLETED.',
  'TOOL_CALL_DISABLED.',
  'TOOL_CALL_DISABLED FAILED.',
  'Do not call any tools. Present all collected data directly as text.',
  'IMPORTANT: Using the tool results above',
  'Stop calling tools.',
  'The previous tool call had invalid JSON format.',
  '⚠️ STAGNATION DETECTED:',
  ...STRATEGY_REVIEW_INTERNAL_PREFIXES,
]

const TOOL_DISABLE_USER_PREFIXES = [
  'TOOL_CALL_DISABLED.',
  'TOOL_CALL_DISABLED FAILED.',
  'Do not call any tools. Present all collected data directly as text.',
  'Stop calling tools.',
]

function getMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) return JSON.stringify(message.content)
  return ''
}

function summarizeText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxChars) return compact
  return compact.slice(0, Math.max(0, maxChars - 16)).trimEnd() + ' ...[truncated]'
}

export function isInternalControlMessage(content: string): boolean {
  const trimmed = content.trim()
  return INTERNAL_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

function isToolDisableControlMessage(content: string): boolean {
  const trimmed = content.trim()
  return TOOL_DISABLE_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, innerValue]) => `${JSON.stringify(key)}:${stableSerialize(innerValue)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return 'no-args'
  return entries
    .slice(0, 2)
    .map(([key, value]) => `${key}="${summarizeText(typeof value === 'string' ? value : stableSerialize(value), 48)}"`)
    .join(', ')
}

function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])]
}

function buildEpisodeHeadline(toolCalls: ToolCallMemory[]): string {
  return toolCalls.map(toolCall => toolCall.toolName).join(', ')
}

function summarizeControlMessage(content: string): string {
  return summarizeText(content.replace(/\s+/g, ' ').trim(), 220)
}

function inferPhase(controlMessages: string[], toolCallCount: number): string {
  for (let index = controlMessages.length - 1; index >= 0; index--) {
    const control = controlMessages[index]
    if (control.includes('[STRATEGY REVIEW')) return 'revision'
    if (
      control.includes('ALL TOOLS COMPLETED') ||
      control.includes('Stop calling tools') ||
      control.includes('STAGNATION DETECTED') ||
      control.includes('write the final Markdown report NOW')
    ) {
      return 'synthesis'
    }
  }

  return toolCallCount > 0 ? 'research' : 'discovery'
}

export function buildToolCacheKey(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = args[key]
      return acc
    }, {})
  return `${toolName}:${stableSerialize(sortedArgs)}`
}

function createEmptySession(agentName: string): AgentSessionSnapshot {
  return {
    schemaVersion: 1,
    agentName,
    workingMemory: {
      objective: null,
      latestExternalUserMessage: null,
      latestAssistantSummary: null,
      phase: 'discovery',
      nextActions: [],
    },
    runtime: {
      toolCallCount: 0,
      toolsUsed: {},
      perToolCount: {},
      duplicateToolCache: {},
      seenUrls: [],
      lowYieldStreak: 0,
      toolsDisabled: false,
    },
    episodes: [],
    processedMessageCount: 0,
    updatedAt: new Date().toISOString(),
  }
}

export function rebuildAgentSession(agentName: string, history: Message[]): AgentSessionSnapshot {
  const normalizedHistory = normalizeHistoryForSession(history)
  const session = createEmptySession(agentName)
  const seenUrls = new Set<string>()
  const controlMessages: string[] = []
  let latestAssistantSummary: string | null = null
  let lowYieldStreak = 0

  for (let index = 0; index < normalizedHistory.length; index++) {
    const message = normalizedHistory[index]
    const text = getMessageText(message)

    if (message.role === 'user') {
      if (!text.trim()) continue
      if (isInternalControlMessage(text)) {
        controlMessages.push(text)
        if (text.includes('STAGNATION DETECTED')) {
          lowYieldStreak = 0
        }
        if (isToolDisableControlMessage(text)) {
          session.runtime.toolsDisabled = true
        }
      } else {
        if (!session.workingMemory.objective) {
          session.workingMemory.objective = summarizeText(text, 600)
        }
        session.workingMemory.latestExternalUserMessage = summarizeText(text, 1200)
      }
      continue
    }

    if (message.role === 'assistant' && !(message as any).tool_calls?.length) {
      if (text.trim().length > 80) {
        latestAssistantSummary = summarizeText(text, 1200)
      }
      continue
    }

    if (message.role === 'assistant' && (message as any).tool_calls?.length) {
      const rawToolCalls = ((message as any).tool_calls ?? []) as Array<{
        id: string
        function: { name: string; arguments: string }
      }>
      const toolCallIndexById = rawToolCalls.reduce<Record<string, number>>((acc, toolCall, toolIndex) => {
        acc[toolCall.id] = toolIndex
        return acc
      }, {})
      const matchedToolCallIds = new Set<string>()
      const episode: ToolEpisodeMemory = {
        id: `episode-${session.episodes.length + 1}`,
        startIndex: index,
        endIndex: index,
        headline: '',
        toolCalls: rawToolCalls.map((toolCall) => {
          const args = parseArgs(toolCall.function.arguments)
          return {
            toolName: toolCall.function.name,
            argsHash: buildToolCacheKey(toolCall.function.name, args),
            argsPreview: summarizeArgs(args),
            resultPreview: '',
            yieldedNewUrls: 0,
          }
        }),
      }

      let cursor = index + 1
      while (cursor < normalizedHistory.length) {
        const nextMessage = normalizedHistory[cursor]

        if (nextMessage.role === 'tool') {
          const toolCallId = (nextMessage as any).tool_call_id as string | undefined
          const toolIndex = toolCallId ? toolCallIndexById[toolCallId] : undefined
          if (!toolCallId || toolIndex === undefined || matchedToolCallIds.has(toolCallId)) {
            break
          }

          const toolText = getMessageText(nextMessage)
          const toolCall = episode.toolCalls[toolIndex]
          const isDuplicateResult = toolText.startsWith('[DUPLICATE_CALL]')
          const isToolLimitResult = toolText.startsWith('[TOOL_LIMIT]')
          const isToolErrorResult = toolText.startsWith('Tool error (')
          const shouldTreatAsRealResult = !isDuplicateResult && !isToolLimitResult && !isToolErrorResult
          const urls = shouldTreatAsRealResult ? extractUrls(toolText) : []
          let yieldedNewUrls = 0
          for (const url of urls) {
            if (!seenUrls.has(url)) {
              seenUrls.add(url)
              yieldedNewUrls++
            }
          }

          toolCall.resultPreview = summarizeText(toolText, 240)
          toolCall.yieldedNewUrls = yieldedNewUrls
          if (shouldTreatAsRealResult) {
            session.runtime.duplicateToolCache[toolCall.argsHash] = toolText
          }
          session.runtime.toolsUsed[toolCall.toolName] = (session.runtime.toolsUsed[toolCall.toolName] ?? 0) + 1
          session.runtime.perToolCount[toolCall.toolName] = (session.runtime.perToolCount[toolCall.toolName] ?? 0) + 1
          session.runtime.toolCallCount++

          if (shouldTreatAsRealResult && (toolCall.toolName === 'search_web' || toolCall.toolName === 'search_web_multi')) {
            lowYieldStreak = yieldedNewUrls <= 2 ? lowYieldStreak + 1 : 0
          }

          matchedToolCallIds.add(toolCallId)
          cursor++
          continue
        }

        if (nextMessage.role === 'user') {
          const nextText = getMessageText(nextMessage)
          if (isInternalControlMessage(nextText)) {
            controlMessages.push(nextText)
            if (nextText.includes('STAGNATION DETECTED')) {
              lowYieldStreak = 0
            }
            if (isToolDisableControlMessage(nextText)) {
              session.runtime.toolsDisabled = true
            }
            cursor++
            continue
          }
        }

        break
      }

      episode.endIndex = Math.max(index, cursor - 1)
      episode.headline = buildEpisodeHeadline(episode.toolCalls)
      session.episodes.push(episode)
      index = cursor - 1
    }
  }

  session.runtime.seenUrls = [...seenUrls]
  session.runtime.lowYieldStreak = lowYieldStreak
  session.workingMemory.latestAssistantSummary = latestAssistantSummary
  session.workingMemory.phase = inferPhase(controlMessages, session.runtime.toolCallCount)
  session.workingMemory.nextActions = [...new Set(controlMessages.slice(-3).map(summarizeControlMessage))]
  session.processedMessageCount = normalizedHistory.length
  session.updatedAt = new Date().toISOString()

  return session
}

export { summarizeText }
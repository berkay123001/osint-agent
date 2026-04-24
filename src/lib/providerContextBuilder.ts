import type {
  AgentSessionSnapshot,
  Message,
  PromptBudgetPolicy,
} from '../agents/types.js'
import { estimateMessageChars } from './llmTelemetry.js'
import { rebuildAgentSession, isInternalControlMessage, summarizeText } from './agentSession.js'
import { normalizeHistoryForProvider } from './chatHistory.js'
import { resolvePromptBudget } from './modelBudgets.js'

interface HistoryUnit {
  messages: Message[]
  chars: number
}

function getMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) return JSON.stringify(message.content)
  return ''
}

function buildDurableMemoryMessage(
  session: AgentSessionSnapshot,
  policy: PromptBudgetPolicy,
): Message | null {
  const needsMemory =
    session.runtime.toolCallCount > 0 ||
    session.workingMemory.nextActions.length > 0 ||
    session.workingMemory.latestAssistantSummary !== null

  if (!needsMemory) return null

  const closing = '[/DURABLE WORKING MEMORY]'
  const lines = ['[DURABLE WORKING MEMORY]']
  let currentLength = lines[0].length + closing.length + 2

  const pushLine = (line: string): void => {
    if (!line) return
    const nextLength = currentLength + line.length + 1
    if (nextLength > policy.maxMemoryChars) return
    lines.push(line)
    currentLength = nextLength
  }

  pushLine(`Agent: ${session.agentName}`)
  pushLine(`Phase: ${session.workingMemory.phase ?? 'research'}`)
  if (session.workingMemory.objective) {
    pushLine(`Objective: ${session.workingMemory.objective}`)
  }
  if (session.workingMemory.latestExternalUserMessage) {
    pushLine(`Latest user request: ${session.workingMemory.latestExternalUserMessage}`)
  }
  if (session.runtime.toolCallCount > 0) {
    pushLine(`Completed tool calls: ${session.runtime.toolCallCount}`)
    const toolSummary = Object.entries(session.runtime.toolsUsed)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([toolName, count]) => `${toolName}×${count}`)
      .join(', ')
    if (toolSummary) pushLine(`Tools used: ${toolSummary}`)
  }

  if (session.workingMemory.nextActions.length > 0) {
    pushLine('Active guardrails:')
    for (const action of session.workingMemory.nextActions) {
      pushLine(`- ${summarizeText(action, policy.maxEpisodePreviewChars)}`)
    }
  }

  if (session.episodes.length > 0) {
    pushLine('Recent completed episodes:')
    const recentEpisodes = session.episodes.slice(-6)
    for (const episode of recentEpisodes) {
      for (const toolCall of episode.toolCalls) {
        const rendered = `- ${toolCall.toolName}(${toolCall.argsPreview}) → ${summarizeText(toolCall.resultPreview || 'no result preview', policy.maxEpisodePreviewChars)}`
        pushLine(rendered)
      }
    }
  }

  if (session.workingMemory.latestAssistantSummary) {
    pushLine(`Last synthesis: ${summarizeText(session.workingMemory.latestAssistantSummary, policy.maxEpisodePreviewChars)}`)
  }

  pushLine('Use this block as authoritative continuity for earlier work. Prefer continuing from these leads instead of repeating identical searches.')
  lines.push(closing)

  return {
    role: 'user',
    content: lines.join('\n'),
  }
}

function buildHistoryUnits(messages: Message[]): HistoryUnit[] {
  const units: HistoryUnit[] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const toolCalls = message.role === 'assistant' ? (message as any).tool_calls : undefined

    if (message.role === 'assistant' && toolCalls?.length) {
      const toolMessages: Message[] = []
      const controlMessages: Message[] = []
      let cursor = index + 1
      while (cursor < messages.length) {
        const nextMessage = messages[cursor]
        if (nextMessage.role === 'tool') {
          toolMessages.push(nextMessage)
          cursor++
          continue
        }

        if (nextMessage.role === 'user') {
          const controlText = getMessageText(nextMessage)
          if (isInternalControlMessage(controlText)) {
            controlMessages.push(nextMessage)
            cursor++
            continue
          }
        }

        break
      }
      const unitMessages: Message[] = [message, ...toolMessages, ...controlMessages]
      units.push({ messages: unitMessages, chars: estimateMessageChars(unitMessages) })
      index = cursor - 1
      continue
    }

    units.push({ messages: [message], chars: estimateMessageChars([message]) })
  }

  return units
}

function truncateStandaloneMessage(message: Message, maxChars: number): Message | null {
  if (maxChars <= 80) return null
  if (message.role === 'tool') return null
  if (message.role === 'assistant' && (message as any).tool_calls?.length) return null
  const text = getMessageText(message)
  if (message.role === 'user' && isInternalControlMessage(text)) return null
  if (!text) return null
  const truncated = summarizeText(text, maxChars)
  return {
    ...message,
    content: truncated,
  }
}

function fitStandaloneMessagesWithinBudget(messages: Message[], maxChars: number): Message[] {
  if (maxChars <= 0) return []

  let fitted = [...messages]
  while (estimateMessageChars(fitted) > maxChars && fitted.length > 0) {
    const prefix = fitted.slice(0, -1)
    const remaining = maxChars - estimateMessageChars(prefix)
    const truncated = truncateStandaloneMessage(fitted[fitted.length - 1], remaining)
    fitted = truncated ? [...prefix, truncated] : prefix
  }

  return fitted
}

export function buildProviderMessages(
  history: Message[],
  options: {
    agentName: string
    modelName?: string
    budgetOverride?: Partial<PromptBudgetPolicy>
    session?: AgentSessionSnapshot
  },
): { messages: Message[]; session: AgentSessionSnapshot; totalChars: number } {
  const policy = {
    ...resolvePromptBudget(options.modelName),
    ...options.budgetOverride,
  }
  const normalizedHistory = normalizeHistoryForProvider(history)
  const session = options.session ?? rebuildAgentSession(options.agentName, history)

  let cursor = 0
  const systemMessages: Message[] = []
  while (cursor < normalizedHistory.length && normalizedHistory[cursor].role === 'system') {
    systemMessages.push(normalizedHistory[cursor])
    cursor++
  }

  const bodyMessages = normalizedHistory.slice(cursor)
  const durableMemory = buildDurableMemoryMessage(session, policy)
  const prefixMessages = fitStandaloneMessagesWithinBudget(
    durableMemory ? [...systemMessages, durableMemory] : [...systemMessages],
    policy.maxPromptChars,
  )

  const maxRecentChars = Math.max(0, Math.min(policy.maxRecentChars, policy.maxPromptChars - estimateMessageChars(prefixMessages)))
  const units = buildHistoryUnits(bodyMessages)
  const selectedUnits: HistoryUnit[] = []
  let selectedChars = 0

  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]
    if (selectedUnits.length >= policy.maxRecentUnits) break
    if (selectedChars + unit.chars > maxRecentChars) {
      continue
    }
    selectedUnits.unshift(unit)
    selectedChars += unit.chars
  }

  const latestBodyMessage = bodyMessages[bodyMessages.length - 1]
  const latestAlreadyIncluded = selectedUnits.some(unit => unit.messages.includes(latestBodyMessage))
  if (latestBodyMessage && !latestAlreadyIncluded) {
    const latestFallback = truncateStandaloneMessage(latestBodyMessage, maxRecentChars)
    if (latestFallback) {
      const latestUnit = { messages: [latestFallback], chars: estimateMessageChars([latestFallback]) }
      while (selectedUnits.length > 0 && selectedChars + latestUnit.chars > maxRecentChars) {
        const removed = selectedUnits.shift()
        if (!removed) break
        selectedChars -= removed.chars
      }
      if (latestUnit.chars <= maxRecentChars) {
        selectedUnits.push(latestUnit)
        selectedChars += latestUnit.chars
      }
    }
  }

  if (selectedUnits.length === 0 && bodyMessages.length > 0) {
    const fallback = truncateStandaloneMessage(bodyMessages[bodyMessages.length - 1], maxRecentChars)
    if (fallback) {
      selectedUnits.push({ messages: [fallback], chars: estimateMessageChars([fallback]) })
    }
  }

  let assembled = [...prefixMessages, ...selectedUnits.flatMap(unit => unit.messages)]
  while (estimateMessageChars(assembled) > policy.maxPromptChars && selectedUnits.length > 0) {
    selectedUnits.shift()
    assembled = [...prefixMessages, ...selectedUnits.flatMap(unit => unit.messages)]
  }

  if (estimateMessageChars(assembled) > policy.maxPromptChars && durableMemory) {
    const fallbackMemory = truncateStandaloneMessage(durableMemory, policy.maxPromptChars - estimateMessageChars(systemMessages))
    assembled = fallbackMemory ? [...systemMessages, fallbackMemory] : [...systemMessages]
  }

  if (estimateMessageChars(assembled) > policy.maxPromptChars) {
    assembled = fitStandaloneMessagesWithinBudget(assembled, policy.maxPromptChars)
  }

  return {
    messages: assembled,
    session,
    totalChars: estimateMessageChars(assembled),
  }
}
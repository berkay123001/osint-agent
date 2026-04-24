import type { Message } from '../agents/types.js'

export interface TranscriptViewportItem {
  role: 'user' | 'assistant'
  content: string
  wasTruncated: boolean
  hiddenLineCount: number
  originalLineCount: number
}

export interface TranscriptViewport {
  hiddenMessageCount: number
  hiddenOlderMessageCount: number
  hiddenNewerMessageCount: number
  /** Lines of the first visible message that are above the viewport (line-scroll mode) */
  hiddenLinesAbove: number
  /** Lines of the last visible message that are below the viewport (line-scroll mode) */
  hiddenLinesBelow: number
  items: TranscriptViewportItem[]
}

function getVisibleMessages(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.flatMap((message) => {
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      return []
    }

    const content = message.content.trim()
    if (!content) return []

    return [{ role: message.role, content }]
  })
}

export function countVisibleTranscriptMessages(messages: Message[]): number {
  return getVisibleMessages(messages).length
}

function truncateContent(content: string, maxLinesPerMessage: number): {
  content: string
  wasTruncated: boolean
  hiddenLineCount: number
  originalLineCount: number
} {
  const lines = content.split('\n')
  if (lines.length <= maxLinesPerMessage) {
    return {
      content,
      wasTruncated: false,
      hiddenLineCount: 0,
      originalLineCount: lines.length,
    }
  }

  const visibleLines = lines.slice(0, maxLinesPerMessage)
  const hiddenLineCount = lines.length - maxLinesPerMessage

  return {
    content: `${visibleLines.join('\n')}\n… [+${hiddenLineCount} lines]`,
    wasTruncated: true,
    hiddenLineCount,
    originalLineCount: lines.length,
  }
}

function clipLineToWidth(line: string, maxLineWidth: number): string {
  if (line.length <= maxLineWidth) return line
  if (maxLineWidth <= 1) return '…'
  return `${line.slice(0, Math.max(0, maxLineWidth - 1))}…`
}

function clipContentToWidth(content: string, maxLineWidth: number): string {
  return content
    .split('\n')
    .map(line => clipLineToWidth(line, maxLineWidth))
    .join('\n')
}

function estimateRenderedLines(item: TranscriptViewportItem, maxLineWidth: number): number {
  const rawLines = item.role === 'user' && item.content.includes('\n')
    ? 1
    : item.content
      .split('\n')
      .reduce((total, line) => total + Math.max(1, Math.ceil(Math.max(1, line.length) / Math.max(1, maxLineWidth))), 0)
  return 1 + rawLines + 1
}

function buildViewportItem(
  message: { role: 'user' | 'assistant'; content: string },
  maxLinesPerMessage: number,
  maxLineWidth: number,
): TranscriptViewportItem {
  const truncated = message.role === 'user' && message.content.includes('\n')
    ? {
        content: message.content,
        wasTruncated: false,
        hiddenLineCount: 0,
        originalLineCount: message.content.split('\n').length,
      }
    : truncateContent(message.content, maxLinesPerMessage)

  return {
    role: message.role,
    content: clipContentToWidth(truncated.content, maxLineWidth),
    wasTruncated: truncated.wasTruncated,
    hiddenLineCount: truncated.hiddenLineCount,
    originalLineCount: truncated.originalLineCount,
  }
}

function calculateBannerLineCount(hiddenOlderMessageCount: number, hiddenNewerMessageCount: number): number {
  let lineCount = 0
  if (hiddenOlderMessageCount > 0) lineCount += 1
  if (hiddenNewerMessageCount > 0) lineCount += 1
  return lineCount
}

// ─── Flat-line helpers (for line-scroll mode) ────────────────────────────────

interface FlatLine {
  messageIndex: number
  text: string
}

function buildFlatLines(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxLineWidth: number,
): FlatLine[] {
  const result: FlatLine[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    // User messages with newlines (paste) → single summary line for budget purposes
    if (msg.role === 'user' && msg.content.includes('\n')) {
      result.push({ messageIndex: i, text: msg.content.split('\n')[0] ?? '' })
    } else {
      const clipped = clipContentToWidth(msg.content, maxLineWidth)
      for (const line of clipped.split('\n')) {
        result.push({ messageIndex: i, text: line })
      }
    }
  }
  return result
}

export function countFlatTranscriptLines(messages: Message[], maxLineWidth: number): number {
  return buildFlatLines(getVisibleMessages(messages), maxLineWidth).length
}

function buildLineScrollViewport(
  visibleMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { maxTotalLines: number; maxLineWidth: number; lineScrollOffset: number },
): TranscriptViewport {
  const { maxTotalLines, maxLineWidth, lineScrollOffset } = opts
  const empty: TranscriptViewport = {
    hiddenMessageCount: 0,
    hiddenOlderMessageCount: 0,
    hiddenNewerMessageCount: 0,
    hiddenLinesAbove: 0,
    hiddenLinesBelow: 0,
    items: [],
  }

  if (visibleMessages.length === 0) return empty

  const flatLines = buildFlatLines(visibleMessages, maxLineWidth)
  const totalFlatLines = flatLines.length
  if (totalFlatLines === 0) return empty

  // Clamp scroll offset
  const maxScrollable = Math.max(0, totalFlatLines - maxTotalLines)
  const clampedOffset = Math.max(0, Math.min(lineScrollOffset, maxScrollable))

  const windowEnd = totalFlatLines - clampedOffset
  const windowStart = Math.max(0, windowEnd - maxTotalLines)
  const windowedLines = flatLines.slice(windowStart, windowEnd)

  if (windowedLines.length === 0) return empty

  // Group consecutive FlatLines by messageIndex
  const groups: Array<{ messageIndex: number; lines: string[] }> = []
  for (const fl of windowedLines) {
    const last = groups[groups.length - 1]
    if (last && last.messageIndex === fl.messageIndex) {
      last.lines.push(fl.text)
    } else {
      groups.push({ messageIndex: fl.messageIndex, lines: [fl.text] })
    }
  }

  const firstGroup = groups[0]!
  const lastGroup = groups[groups.length - 1]!

  // Lines hidden above within the first visible message
  let firstMsgFlatStart = 0
  for (let i = 0; i < flatLines.length; i++) {
    if (flatLines[i]!.messageIndex === firstGroup.messageIndex) {
      firstMsgFlatStart = i
      break
    }
  }
  const hiddenLinesAbove = Math.max(0, windowStart - firstMsgFlatStart)

  // Lines hidden below within the last visible message
  let lastMsgFlatEnd = 0
  for (let i = 0; i < flatLines.length; i++) {
    if (flatLines[i]!.messageIndex === lastGroup.messageIndex) lastMsgFlatEnd = i + 1
  }
  const hiddenLinesBelow = Math.max(0, lastMsgFlatEnd - windowEnd)

  // Build items
  const items: TranscriptViewportItem[] = groups.map(group => {
    const msg = visibleMessages[group.messageIndex]!
    const isMultiLineUser = msg.role === 'user' && msg.content.includes('\n')
    if (isMultiLineUser) {
      return {
        role: 'user' as const,
        content: msg.content,
        wasTruncated: false,
        hiddenLineCount: 0,
        originalLineCount: msg.content.split('\n').length,
      }
    }
    const totalMsgLines = msg.content.split('\n').length
    const shownLines = group.lines.length
    return {
      role: msg.role,
      content: group.lines.join('\n'),
      wasTruncated: shownLines < totalMsgLines,
      hiddenLineCount: Math.max(0, totalMsgLines - shownLines),
      originalLineCount: totalMsgLines,
    }
  })

  const hiddenOlderMessageCount = firstGroup.messageIndex
  const hiddenNewerMessageCount = Math.max(0, visibleMessages.length - lastGroup.messageIndex - 1)

  return {
    hiddenMessageCount: hiddenOlderMessageCount + hiddenNewerMessageCount,
    hiddenOlderMessageCount,
    hiddenNewerMessageCount,
    hiddenLinesAbove,
    hiddenLinesBelow,
    items,
  }
}

export function buildTranscriptViewport(
  messages: Message[],
  options?: {
    maxTotalLines?: number
    maxLinesPerMessage?: number
    maxMessages?: number
    maxLineWidth?: number
    messageOffset?: number
    /** When provided, use flat-line windowing instead of message-offset scrolling */
    lineScrollOffset?: number
  },
): TranscriptViewport {
  const maxTotalLines = options?.maxTotalLines ?? 18
  const maxLinesPerMessage = options?.maxLinesPerMessage ?? 6
  const maxMessages = options?.maxMessages ?? 8
  const maxLineWidth = options?.maxLineWidth ?? 100
  const visibleMessages = getVisibleMessages(messages)

  // New: line-scroll mode
  if (options?.lineScrollOffset !== undefined) {
    return buildLineScrollViewport(visibleMessages, {
      maxTotalLines,
      maxLineWidth,
      lineScrollOffset: options.lineScrollOffset,
    })
  }

  if (visibleMessages.length === 0) {
    return {
      hiddenMessageCount: 0,
      hiddenOlderMessageCount: 0,
      hiddenNewerMessageCount: 0,
      hiddenLinesAbove: 0,
      hiddenLinesBelow: 0,
      items: [],
    }
  }

  const maxOffset = Math.max(0, visibleMessages.length - 1)
  const messageOffset = Math.min(Math.max(0, options?.messageOffset ?? 0), maxOffset)
  const endExclusive = Math.max(1, visibleMessages.length - messageOffset)

  const selected: Array<{ index: number; item: TranscriptViewportItem }> = []
  let usedLines = 0

  for (let index = endExclusive - 1; index >= 0; index--) {
    if (selected.length >= maxMessages) break

    const item = buildViewportItem(visibleMessages[index], maxLinesPerMessage, maxLineWidth)
    const estimatedLines = estimateRenderedLines(item, maxLineWidth)

    if (selected.length > 0 && usedLines + estimatedLines > maxTotalLines) {
      break
    }

    selected.unshift({ index, item })
    usedLines += estimatedLines
  }

  if (selected.length === 0) {
    const fallbackIndex = endExclusive - 1
    selected.push({
      index: fallbackIndex,
      item: buildViewportItem(visibleMessages[fallbackIndex]!, maxLinesPerMessage, maxLineWidth),
    })
    usedLines = estimateRenderedLines(selected[0].item, maxLineWidth)
  }

  while (selected.length > 0 && selected[0]?.index === 0 && selected.length < maxMessages) {
    const nextIndex = (selected[selected.length - 1]?.index ?? -1) + 1
    if (nextIndex >= visibleMessages.length) break

    const nextItem = buildViewportItem(visibleMessages[nextIndex]!, maxLinesPerMessage, maxLineWidth)
    const nextLines = estimateRenderedLines(nextItem, maxLineWidth)
    const nextHiddenNewer = Math.max(0, visibleMessages.length - (nextIndex + 1))
    const bannerLineCount = calculateBannerLineCount(0, nextHiddenNewer)
    if (usedLines + nextLines + bannerLineCount > maxTotalLines) break

    selected.push({ index: nextIndex, item: nextItem })
    usedLines += nextLines
  }

  let hiddenOlderMessageCount = selected[0]?.index ?? 0
  let hiddenNewerMessageCount = Math.max(0, visibleMessages.length - ((selected[selected.length - 1]?.index ?? -1) + 1))

  if (hiddenOlderMessageCount > 0 || hiddenNewerMessageCount > 0) {
    let usedLinesWithBanner = usedLines + calculateBannerLineCount(hiddenOlderMessageCount, hiddenNewerMessageCount)
    while (selected.length > 1 && usedLinesWithBanner > maxTotalLines) {
      const removed = selected.shift()
      if (!removed) break
      usedLines -= estimateRenderedLines(removed.item, maxLineWidth)
      hiddenOlderMessageCount = selected[0]?.index ?? 0
      hiddenNewerMessageCount = Math.max(0, visibleMessages.length - ((selected[selected.length - 1]?.index ?? -1) + 1))
      usedLinesWithBanner = usedLines + calculateBannerLineCount(hiddenOlderMessageCount, hiddenNewerMessageCount)
    }
  }

  return {
    hiddenMessageCount: hiddenOlderMessageCount,
    hiddenOlderMessageCount,
    hiddenNewerMessageCount,
    hiddenLinesAbove: 0,
    hiddenLinesBelow: 0,
    items: selected.map(entry => entry.item),
  }
}
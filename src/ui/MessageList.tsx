import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../agents/types.js';

interface Props {
  messages: Message[];
}

// ─── Inline markdown parser ──────────────────────────────────────────────────
// Handles: ***bold-italic***, **bold**, `code`, [link](url)

function parseInline(text: string, baseKey: string): React.ReactNode[] {
  const re = /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|`(.+?)`|\[([^\]]+)\]\([^)]+\)/gs;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = 0;

  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const k = `${baseKey}-${idx++}`;
    if (m[1] !== undefined) {
      parts.push(<Text key={k} bold italic>{m[1]}</Text>);
    } else if (m[2] !== undefined) {
      parts.push(<Text key={k} bold>{m[2]}</Text>);
    } else if (m[3] !== undefined) {
      parts.push(<Text key={k} color="yellow">{m[3]}</Text>);
    } else if (m[4] !== undefined) {
      // [link text](url) — strip URL, show text in cyan
      parts.push(<Text key={k} color="cyan">{m[4]}</Text>);
    }
    last = start + m[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? [text] : parts;
}

// ─── Line renderer ────────────────────────────────────────────────────────────

function renderLine(line: string, key: number): React.ReactElement {
  const t = line.trim();

  // Empty line → small gap
  if (!t) return <Text key={key}>{' '}</Text>;

  // Headings: # ## ### ####
  const hMatch = /^(#{1,4})\s+(.+)$/.exec(t);
  if (hMatch) {
    const colors = ['greenBright', 'yellowBright', 'cyan', 'white'];
    const color = colors[Math.min(hMatch[1].length - 1, 3)];
    return (
      <Text key={key} bold color={color as 'greenBright' | 'yellowBright' | 'cyan' | 'white'}>
        {parseInline(hMatch[2], `h-${key}`)}
      </Text>
    );
  }

  // Horizontal rule: --- === ***
  if (/^[-=*]{3,}$/.test(t)) {
    return <Text key={key} dimColor>{'─'.repeat(60)}</Text>;
  }

  // Blockquote: > text
  if (t.startsWith('> ')) {
    return (
      <Text key={key} color="gray">
        {'│ '}{parseInline(t.slice(2), `bq-${key}`)}
      </Text>
    );
  }

  // Bullet list: - item / * item
  const bulletMatch = /^[-*•]\s+(.+)$/.exec(t);
  if (bulletMatch) {
    return (
      <Text key={key}>
        <Text color="cyan">{'• '}</Text>
        {parseInline(bulletMatch[1], `bl-${key}`)}
      </Text>
    );
  }

  // Numbered list: 1. item / 1) item
  const numMatch = /^(\d+)[.)]\s+(.+)$/.exec(t);
  if (numMatch) {
    return (
      <Text key={key}>
        <Text color="cyan">{numMatch[1]}. </Text>
        {parseInline(numMatch[2], `nl-${key}`)}
      </Text>
    );
  }

  // Normal line with inline formatting
  const nodes = parseInline(line, `ln-${key}`);
  return <Text key={key}>{nodes}</Text>;
}

// ─── Text segment renderer (handles code fences + line-level markdown) ───────

function renderTextSegment(text: string, segKey: number): React.ReactElement {
  const lines = text.split('\n');
  const elements: React.ReactElement[] = [];
  let i = 0;
  let elemIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence: ```lang ... ```
    if (line.trim().startsWith('```')) {
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      elements.push(
        <Box key={`cf-${segKey}-${elemIdx++}`} flexDirection="column" paddingLeft={2}>
          {codeLines.map((cl, ci) => (
            <Text key={ci} color="green">{cl || ' '}</Text>
          ))}
        </Box>
      );
      continue;
    }

    elements.push(renderLine(line, elemIdx++));
    i++;
  }

  return (
    <Box key={segKey} flexDirection="column">
      {elements}
    </Box>
  );
}

// ─── Markdown table parser ───────────────────────────────────────────────────

type Segment = { type: 'text'; content: string } | { type: 'table'; rows: string[][] };

function isSeparatorRow(line: string): boolean {
  return /^\|\s*[-:]+[-:\s|]*\s*\|$/.test(line.trim());
}

function parseSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let textBuf: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('|') && line.trimEnd().endsWith('|')) {
      if (textBuf.length > 0) {
        const joined = textBuf.join('\n');
        if (joined.trim()) segments.push({ type: 'text', content: joined });
        textBuf = [];
      }
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|') && lines[i].trimEnd().endsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows: string[][] = [];
      for (const tl of tableLines) {
        if (isSeparatorRow(tl)) continue;
        const cells = tl.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) segments.push({ type: 'table', rows });
    } else {
      textBuf.push(line);
      i++;
    }
  }

  if (textBuf.length > 0) {
    const joined = textBuf.join('\n');
    if (joined.trim()) segments.push({ type: 'text', content: joined });
  }

  return segments;
}

// ─── Table renderer ──────────────────────────────────────────────────────────

function renderTable(rows: string[][], key: number): React.ReactElement {
  const cols = Math.max(...rows.map(r => r.length));
  const widths: number[] = Array(cols).fill(3);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      widths[c] = Math.max(widths[c], row[c].length + 2);
    }
  }
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  return (
    <Box key={key} flexDirection="column">
      {rows.map((row, ri) => {
        const isHeader = ri === 0;
        return (
          <React.Fragment key={ri}>
            <Box flexDirection="row">
              {Array.from({ length: cols }, (_, ci) => (
                <Box key={ci} minWidth={widths[ci]}>
                  <Text bold={isHeader} color={isHeader ? 'cyan' : undefined}>
                    {row[ci] ?? ''}
                  </Text>
                </Box>
              ))}
            </Box>
            {isHeader && (
              <Text dimColor>{'─'.repeat(Math.min(totalWidth, 80))}</Text>
            )}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

// ─── Full content renderer ────────────────────────────────────────────────────

function renderContent(text: string): React.ReactElement {
  const segments = parseSegments(text);
  return (
    <Box flexDirection="column">
      {segments.map((seg, si) =>
        seg.type === 'table'
          ? renderTable(seg.rows, si)
          : renderTextSegment((seg as { type: 'text'; content: string }).content, si)
      )}
    </Box>
  );
}

// ─── MessageList ─────────────────────────────────────────────────────────────

export function MessageList({ messages }: Props): React.ReactElement {
  const visible = messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0,
  );

  if (visible.length === 0) return <></>;

  let pasteCounter = 0;

  return (
    <Box flexDirection="column">
      {visible.map((msg, i) => {
        const content = (msg.content as string).trim();
        const isUser = msg.role === 'user';

        // Multi-line user message → compact paste format
        if (isUser && content.includes('\n')) {
          pasteCounter++;
          const lines = content.split('\n');
          const firstLine = (lines.find(l => l.trim().length > 0) || lines[0]).trim();
          const preview = firstLine.slice(0, 80);
          const extraLines = lines.length - 1;
          const needsEllipsis = firstLine.length > 80 || extraLines > 0;

          return (
            <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              <Text bold color="cyan">You</Text>
              <Text dimColor>
                [paste #{pasteCounter} &quot;{preview}{needsEllipsis ? '…' : ''}&quot; +{extraLines} lines]
              </Text>
            </Box>
          );
        }

        return (
          <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
            <Text bold color={isUser ? 'cyan' : 'magenta'}>
              {isUser ? 'You' : 'Agent'}
            </Text>
            {isUser ? <Text>{content}</Text> : renderContent(content)}
          </Box>
        );
      })}
    </Box>
  );
}

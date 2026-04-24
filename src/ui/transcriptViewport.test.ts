import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../agents/types.js'
import { buildTranscriptViewport } from './transcriptViewport.js'

test('buildTranscriptViewport keeps only the newest messages within the line budget', () => {
  const messages: Message[] = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' },
  ]

  const viewport = buildTranscriptViewport(messages, {
    maxTotalLines: 8,
    maxLinesPerMessage: 2,
    maxMessages: 2,
  })

  assert.equal(viewport.hiddenMessageCount, 2)
  assert.deepEqual(viewport.items.map(item => item.content), ['new question', 'new answer'])
})

test('buildTranscriptViewport truncates long assistant messages to stabilize layout height', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: ['one', 'two', 'three', 'four', 'five'].join('\n'),
    },
  ]

  const viewport = buildTranscriptViewport(messages, {
    maxTotalLines: 10,
    maxLinesPerMessage: 3,
    maxMessages: 1,
  })

  assert.equal(viewport.items.length, 1)
  assert.equal(viewport.items[0]?.wasTruncated, true)
  assert.equal(viewport.items[0]?.hiddenLineCount, 2)
  assert.ok(viewport.items[0]?.content.includes('… [+2 lines]'))
})

test('buildTranscriptViewport keeps a contiguous newest suffix when an oversized middle message does not fit', () => {
  const messages: Message[] = [
    { role: 'assistant', content: 'old small' },
    { role: 'assistant', content: ['big-1', 'big-2', 'big-3', 'big-4', 'big-5'].join('\n') },
    { role: 'assistant', content: 'new small' },
  ]

  const viewport = buildTranscriptViewport(messages, {
    maxTotalLines: 8,
    maxLinesPerMessage: 5,
    maxMessages: 3,
  })

  assert.deepEqual(viewport.items.map(item => item.content), ['new small'])
  assert.equal(viewport.hiddenMessageCount, 2)
})

test('buildTranscriptViewport preserves original pasted user line counts for the compact paste summary', () => {
  const pastedContent = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n')
  const viewport = buildTranscriptViewport([
    { role: 'user', content: pastedContent },
  ], {
    maxTotalLines: 10,
    maxLinesPerMessage: 6,
    maxMessages: 1,
  })

  assert.equal(viewport.items[0]?.originalLineCount, 100)
  assert.equal(viewport.items[0]?.wasTruncated, false)
})

test('buildTranscriptViewport clips long single-line assistant replies to the terminal width budget', () => {
  const viewport = buildTranscriptViewport([
    { role: 'assistant', content: 'x'.repeat(80) },
  ], {
    maxTotalLines: 6,
    maxLinesPerMessage: 4,
    maxMessages: 1,
    maxLineWidth: 20,
  })

  assert.equal(viewport.items.length, 1)
  assert.ok(viewport.items[0]?.content.includes('…'))
  assert.ok(viewport.items[0]?.content.split('\n').every(line => line.length <= 20))
})

test('buildTranscriptViewport can show a stable middle window when newer messages are hidden', () => {
  const messages: Message[] = [
    { role: 'user', content: 'm1' },
    { role: 'assistant', content: 'm2' },
    { role: 'user', content: 'm3' },
    { role: 'assistant', content: 'm4' },
    { role: 'user', content: 'm5' },
  ]

  const viewport = buildTranscriptViewport(messages, {
    maxTotalLines: 8,
    maxLinesPerMessage: 2,
    maxMessages: 2,
    messageOffset: 1,
  })

  assert.equal(viewport.hiddenOlderMessageCount, 2)
  assert.equal(viewport.hiddenNewerMessageCount, 1)
  assert.equal(viewport.hiddenMessageCount, 2)
  assert.deepEqual(viewport.items.map(item => item.content), ['m3', 'm4'])
})

test('buildTranscriptViewport clamps oversized scroll offsets to the oldest reachable window', () => {
  const messages: Message[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ]

  const viewport = buildTranscriptViewport(messages, {
    maxTotalLines: 8,
    maxLinesPerMessage: 2,
    maxMessages: 2,
    messageOffset: 99,
  })

  assert.equal(viewport.hiddenOlderMessageCount, 0)
  assert.equal(viewport.hiddenNewerMessageCount, 1)
  assert.deepEqual(viewport.items.map(item => item.content), ['first', 'second'])
})
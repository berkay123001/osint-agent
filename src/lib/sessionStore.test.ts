import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Message } from '../agents/types.js'

const FIXTURE_HISTORY: Message[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'world' },
]

let testDir = ''

test.beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-session-store-'))
  process.env.OSINT_SESSION_DIR = testDir
})

test.afterEach(() => {
  delete process.env.OSINT_SESSION_DIR
  fs.rmSync(testDir, { recursive: true, force: true })
})

test('deleteSessionsByCreatedAt removes archived and active copies of the same session', async () => {
  const sessionStore = await import(`./sessionStore.js?case=${Date.now()}`)
  const createdAt = '2026-04-19T19:38:39.000Z'

  sessionStore.archiveSession(FIXTURE_HISTORY, createdAt)
  sessionStore.saveSession(FIXTURE_HISTORY, createdAt)

  assert.equal(sessionStore.listSessions().length, 1)
  assert.ok(sessionStore.loadActiveSession())

  const deletedCount = sessionStore.deleteSessionsByCreatedAt(createdAt)

  assert.equal(deletedCount, 2)
  assert.equal(sessionStore.listSessions().length, 0)
  assert.equal(sessionStore.loadActiveSession(), null)
})

test('deleteAllSessions counts only files that existed', async () => {
  const sessionStore = await import(`./sessionStore.js?case=${Date.now() + 1}`)

  sessionStore.archiveSession(FIXTURE_HISTORY, '2026-04-10T00:00:00.000Z')
  sessionStore.archiveSession(FIXTURE_HISTORY, '2026-04-11T00:00:00.000Z')

  assert.equal(sessionStore.deleteAllSessions(), 2)

  sessionStore.saveSession(FIXTURE_HISTORY, '2026-04-12T00:00:00.000Z')
  assert.equal(sessionStore.deleteAllSessions(), 1)
})

test('listDeletableSessions includes the active session when no archived copy exists', async () => {
  const sessionStore = await import(`./sessionStore.js?case=${Date.now() + 2}`)
  const createdAt = '2026-04-13T00:00:00.000Z'

  sessionStore.saveSession(FIXTURE_HISTORY, createdAt)

  const deletable = sessionStore.listDeletableSessions()

  assert.equal(deletable.length, 1)
  assert.equal(deletable[0]?.isActive, true)
  assert.equal(deletable[0]?.data.createdAt, createdAt)
})

test('deleteAllSessions removes malformed archived session files too', async () => {
  const sessionStore = await import(`./sessionStore.js?case=${Date.now() + 3}`)

  fs.writeFileSync(path.join(testDir, 'session-bad.json'), '{broken json', 'utf-8')
  sessionStore.archiveSession(FIXTURE_HISTORY, '2026-04-14T00:00:00.000Z')

  const deletedCount = sessionStore.deleteAllSessions()

  assert.equal(deletedCount, 2)
  assert.deepEqual(fs.readdirSync(testDir).filter(name => name.startsWith('session-')), [])
})

test('hasStoredSessions reports true even when only malformed session files exist', async () => {
  const sessionStore = await import(`./sessionStore.js?case=${Date.now() + 4}`)

  fs.writeFileSync(path.join(testDir, 'session-corrupt.json'), '{broken json', 'utf-8')

  assert.equal(sessionStore.hasStoredSessions(), true)
  assert.equal(sessionStore.listSessions().length, 0)
})

test('listDeletableSessions marks the archived row as active when the current session was resumed from archive', async () => {
  const sessionStore = await import(`./sessionStore.js?case=${Date.now() + 5}`)
  const createdAt = '2026-04-15T00:00:00.000Z'

  sessionStore.archiveSession(FIXTURE_HISTORY, createdAt)
  sessionStore.saveSession(FIXTURE_HISTORY, createdAt)

  const deletable = sessionStore.listDeletableSessions()

  assert.equal(deletable.length, 1)
  assert.equal(deletable[0]?.isActive, true)
  assert.equal(deletable[0]?.data.createdAt, createdAt)
})
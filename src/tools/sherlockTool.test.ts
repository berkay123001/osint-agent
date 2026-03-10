import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'events'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { runSherlockCLI } from './sherlockTool.js'

/**
 * Sherlock Tool Test Suite
 * Mock spawn fonksiyonu ile calisir. Gercek Sherlock calistirilmaz.
 */

// Mock ChildProcess olusturucu
function createMockSpawn(response: {
  stdout?: string
  stderr?: string
  code?: number
  error?: Error
}) {
  return (
    _command: string,
    _args: string[],
    _options: SpawnOptions
  ): ChildProcess => {
    const proc = new EventEmitter() as ChildProcess
    Object.defineProperty(proc, 'stdout', { value: new EventEmitter(), writable: true })
    Object.defineProperty(proc, 'stderr', { value: new EventEmitter(), writable: true })

    setImmediate(() => {
      if (response.stdout) {
        (proc.stdout as EventEmitter).emit('data', Buffer.from(response.stdout))
      }
      if (response.stderr) {
        (proc.stderr as EventEmitter).emit('data', Buffer.from(response.stderr))
      }
      if (response.error) {
        proc.emit('error', response.error)
      } else {
        proc.emit('close', response.code ?? 0)
      }
    })

    return proc
  }
}

// Test Fixtures
const FIXTURES = {
  typical: {
    stdout: JSON.stringify({
      GitHub: { url_user: 'https://github.com/octocat', exists: 'found' },
      Twitter: { url_user: 'https://twitter.com/octocat', exists: 'found' },
      Reddit: { url_user: 'https://reddit.com/user/octocat', exists: 'found' },
    }),
    code: 0,
  },
  mixed: {
    stdout: JSON.stringify({
      GitHub: { url_user: 'https://github.com/user', exists: 'found' },
      Twitter: { url_user: '', exists: 'not_found' },
      Facebook: { url_user: null, exists: 'not_found' },
    }),
    code: 0,
  },
  empty: { stdout: '{}', code: 0 },
  textOutput: {
    stdout: 'Found:\nhttps://github.com/user123\nhttps://twitter.com/user123',
    code: 0,
  },
  spawnError: { error: new Error('spawn python ENOENT') },
}

// ===== TESTLER =====

test('3 platform JSON ciktisi dogru parse ediliyor', async () => {
  const mockSpawn = createMockSpawn(FIXTURES.typical)
  const results = await runSherlockCLI('octocat', mockSpawn)

  assert.equal(results.length, 3)
  assert.ok(results.some((r) => r.platform === 'GitHub'))
  assert.ok(results.some((r) => r.url === 'https://github.com/octocat'))
})

test('Bos/null URL olan platformlar filtreleniyor', async () => {
  const mockSpawn = createMockSpawn(FIXTURES.mixed)
  const results = await runSherlockCLI('user', mockSpawn)

  assert.equal(results.length, 1)
  assert.equal(results[0]?.platform, 'GitHub')
})

test('Bos JSON sonucu bos array dondurur', async () => {
  const mockSpawn = createMockSpawn(FIXTURES.empty)
  const results = await runSherlockCLI('xyz', mockSpawn)

  assert.deepEqual(results, [])
})

test('JSON parse hatasinda text fallback calisiyor', async () => {
  const mockSpawn = createMockSpawn(FIXTURES.textOutput)
  const results = await runSherlockCLI('user', mockSpawn)

  assert.ok(results.length >= 1)
  assert.ok(results.every((r) => r.url.startsWith('http')))
})

test('Spawn hatasinda reject ediliyor', async () => {
  const mockSpawn = createMockSpawn(FIXTURES.spawnError)
  await assert.rejects(runSherlockCLI('user', mockSpawn), /ENOENT/)
})

test('50 platform sonucu hizli isleniyor', async () => {
  const many: Record<string, { url_user: string }> = {}
  for (let i = 0; i < 50; i++) {
    many[`Platform${i}`] = { url_user: `https://p${i}.com/user` }
  }

  const mockSpawn = createMockSpawn({ stdout: JSON.stringify(many), code: 0 })
  const start = performance.now()
  const results = await runSherlockCLI('user', mockSpawn)
  const duration = performance.now() - start

  assert.equal(results.length, 50)
  assert.ok(duration < 10, `50 platform ${duration.toFixed(2)}ms surdu`)
})

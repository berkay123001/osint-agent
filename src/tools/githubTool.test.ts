import assert from 'node:assert/strict'
import test from 'node:test'
import { githubOsint } from './githubTool.js'

/**
 * GitHub Tool Test Suite
 * fetch API mock ile calisir. Gercek GitHub API cagrilmaz.
 */

// Mock Response tipi
type MockResponse = {
  status?: number
  ok?: boolean
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

// Global fetch mock
let mockResponses: Map<string, MockResponse> = new Map()
let mockFetchCalls: string[] = []

const originalFetch = globalThis.fetch

function mockFetch(url: string): Promise<MockResponse> {
  mockFetchCalls.push(url)
  const response = mockResponses.get(url) || { status: 404, ok: false }
  return Promise.resolve(response as Response)
}

test.before(() => {
  globalThis.fetch = mockFetch as typeof fetch
})

test.beforeEach(() => {
  mockResponses.clear()
  mockFetchCalls = []
})

test.after(() => {
  globalThis.fetch = originalFetch
})

// Fixtures
const FIXTURES = {
  profile: {
    login: 'octocat',
    name: 'The Octocat',
    company: '@github',
    blog: 'https://github.blog',
    location: 'San Francisco',
    email: 'octocat@github.com',
    bio: 'GitHub mascot',
    twitter_username: 'github',
    public_repos: 8,
    followers: 100,
    following: 0,
    created_at: '2011-01-25T18:44:36Z',
  },
  repos: [
    { name: 'Hello-World', fork: false },
    { name: 'Spoon-Knife', fork: false },
    { name: 'forked-repo', fork: true },
  ],
  commits: [{ sha: 'abc123' }],
  patch: `From abc123 Mon Sep 17 00:00:00 2001
From: The Octocat <octocat@github.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: [PATCH] Initial commit

Test commit body`,
  gpgKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----
Version: GnuPG v2

mQENBF... (real key content)
=abcd
-----END PGP PUBLIC KEY BLOCK-----`,
  sshKeys: `ssh-rsa AAAAB3NzaC1... octocat@github.com
ssh-ed25519 AAAAC3NzaC... octocat@github.com`,
}

// Helper: mock response ekle
function addMock(url: string, response: MockResponse) {
  mockResponses.set(url, response)
}

// ===== TESTLER =====

test('Profil ve email basariyla cekiliyor', async () => {
  addMock('https://api.github.com/users/octocat', {
    status: 200,
    ok: true,
    json: async () => FIXTURES.profile,
  })
  addMock('https://api.github.com/users/octocat/repos?per_page=30&sort=pushed&type=owner', {
    status: 200,
    ok: true,
    json: async () => FIXTURES.repos,
  })
  addMock('https://api.github.com/repos/octocat/Hello-World/commits?author=octocat&per_page=1', {
    status: 200,
    ok: true,
    json: async () => FIXTURES.commits,
  })
  addMock('https://github.com/octocat/Hello-World/commit/abc123.patch', {
    status: 200,
    ok: true,
    text: async () => FIXTURES.patch,
  })
  addMock('https://github.com/octocat.gpg', {
    status: 200,
    ok: true,
    text: async () => FIXTURES.gpgKey,
  })
  addMock('https://github.com/octocat.keys', {
    status: 200,
    ok: true,
    text: async () => FIXTURES.sshKeys,
  })

  const result = await githubOsint('octocat')

  assert.equal(result.username, 'octocat')
  assert.equal(result.profile.login, 'octocat')
  assert.equal(result.profile.name, 'The Octocat')
  assert.ok(result.emails.includes('octocat@github.com'))
  assert.ok(result.gpgKeyUrl?.includes('octocat.gpg'))
  assert.ok(result.sshKeyUrl?.includes('octocat.keys'))
  assert.ok(result.rawSummary.includes('GitHub mascot'))
})

test('Kullanici bulunamadi hatasi', async () => {
  addMock('https://api.github.com/users/nonexistent', {
    status: 404,
    ok: false,
  })

  const result = await githubOsint('nonexistent')

  assert.ok(result.error?.includes('does not exist'))
  assert.deepEqual(result.emails, [])
})

test('Repo listesi bos email listesi bos doner', async () => {
  addMock('https://api.github.com/users/testuser', {
    status: 200,
    ok: true,
    json: async () => ({ ...FIXTURES.profile, login: 'testuser', email: null }),
  })
  addMock('https://api.github.com/users/testuser/repos?per_page=30&sort=pushed&type=owner', {
    status: 200,
    ok: true,
    json: async () => [],
  })
  addMock('https://github.com/testuser.gpg', {
    status: 404,
    ok: false,
  })
  addMock('https://github.com/testuser.keys', {
    status: 404,
    ok: false,
  })

  const result = await githubOsint('testuser')

  assert.equal(result.username, 'testuser')
  assert.deepEqual(result.emails, [])
  assert.equal(result.gpgKeyUrl, null)
})

test('Fork repolar kontrol edilmiyor', async () => {
  addMock('https://api.github.com/users/testuser', {
    status: 200,
    ok: true,
    json: async () => ({ ...FIXTURES.profile, login: 'testuser', email: null }),
  })
  addMock('https://api.github.com/users/testuser/repos?per_page=30&sort=pushed&type=owner', {
    status: 200,
    ok: true,
    json: async () => FIXTURES.repos,
  })
  addMock('https://github.com/testuser.gpg', { status: 404, ok: false })
  addMock('https://github.com/testuser.keys', { status: 404, ok: false })

  await githubOsint('testuser')

  // Sadece 2 repo icin commit API cagrilmali (fork haric)
  const commitCalls = mockFetchCalls.filter((url) => url.includes('/commits?'))
  assert.equal(commitCalls.length, 2)
})

test('Patch email profil emailinden farkliysa her ikisi de ekleniyor', async () => {
  addMock('https://api.github.com/users/testuser', {
    status: 200,
    ok: true,
    json: async () => ({ ...FIXTURES.profile, login: 'testuser', email: 'profile@example.com' }),
  })
  addMock('https://api.github.com/users/testuser/repos?per_page=30&sort=pushed&type=owner', {
    status: 200,
    ok: true,
    json: async () => [{ name: 'repo', fork: false }],
  })
  addMock('https://api.github.com/repos/testuser/repo/commits?author=testuser&per_page=1', {
    status: 200,
    ok: true,
    json: async () => [{ sha: 'xyz' }],
  })
  addMock('https://github.com/testuser/repo/commit/xyz.patch', {
    status: 200,
    ok: true,
    text: async () => `From: Test User <commit@example.com>`,
  })
  addMock('https://github.com/testuser.gpg', { status: 404, ok: false })
  addMock('https://github.com/testuser.keys', { status: 404, ok: false })

  const result = await githubOsint('testuser')

  assert.equal(result.emails.length, 2)
  assert.ok(result.emails.includes('profile@example.com'))
  assert.ok(result.emails.includes('commit@example.com'))
})

test('GitHub placeholder GPG key reddediliyor', async () => {
  addMock('https://api.github.com/users/testuser', {
    status: 200,
    ok: true,
    json: async () => ({ ...FIXTURES.profile, login: 'testuser' }),
  })
  addMock('https://api.github.com/users/testuser/repos?per_page=30&sort=pushed&type=owner', {
    status: 200,
    ok: true,
    json: async () => [],
  })
  addMock('https://github.com/testuser.gpg', {
    status: 200,
    ok: true,
    text: async () => `-----BEGIN PGP PUBLIC KEY BLOCK-----
Note: This user hasn't uploaded any GPG keys.

=twTO
-----END PGP PUBLIC KEY BLOCK-----`,
  })
  addMock('https://github.com/testuser.keys', { status: 404, ok: false })

  const result = await githubOsint('testuser')

  assert.equal(result.gpgKeyUrl, null, 'Placeholder GPG key reddedilmeli')
})

/**
 * GitHub OSINT Tool — GitHub resmi API'si üzerinden çalışır.
 * Web scraping yok, IP ban riski yok.
 * Commit e-postalarını .patch endpoint'inden (GitHub'ın sunduğu) çeker.
 */

import { hasUsableGithubGpgKey } from './githubGpgUtils.js'

interface GitHubProfile {
  login: string
  name: string | null
  company: string | null
  blog: string | null
  location: string | null
  email: string | null
  bio: string | null
  twitter_username: string | null
  public_repos: number
  followers: number
  following: number
  created_at: string
}

interface CommitEmail {
  email: string
  source: string
}

export interface GitHubOsintResult {
  username: string
  profile: Partial<GitHubProfile>
  emails: string[]
  gpgKeyUrl: string | null
  sshKeyUrl: string | null
  rawSummary: string
  error?: string
}

const GITHUB_API = 'https://api.github.com'
const REQUEST_TIMEOUT = 8000

async function fetchWithTimeout(url: string, ms = REQUEST_TIMEOUT): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'osint-agent/1.0', Accept: 'application/json' },
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function getProfile(username: string): Promise<GitHubProfile | null> {
  try {
    const res = await fetchWithTimeout(`${GITHUB_API}/users/${username}`)
    if (!res.ok) return null
    return await res.json() as GitHubProfile
  } catch {
    return null
  }
}

async function getRepos(username: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      `${GITHUB_API}/users/${username}/repos?per_page=30&sort=pushed&type=owner`
    )
    if (!res.ok) return []
    const repos = await res.json() as Array<{ name: string; fork: boolean }>
    return repos.filter((r) => !r.fork).map((r) => r.name)
  } catch {
    return []
  }
}

async function getEmailFromRepo(username: string, repo: string): Promise<string | null> {
  try {
    // GitHub'ın resmi .patch endpoint'i — herkes erişebilir, scraping değil
    const commitsRes = await fetchWithTimeout(
      `${GITHUB_API}/repos/${username}/${repo}/commits?author=${username}&per_page=1`
    )
    if (!commitsRes.ok) return null
    const commits = await commitsRes.json() as Array<{ sha: string }>
    if (!commits.length) return null

    const sha = commits[0].sha
    const patchRes = await fetchWithTimeout(
      `https://github.com/${username}/${repo}/commit/${sha}.patch`,
      5000
    )
    if (!patchRes.ok) return null
    const patch = await patchRes.text()

    const match = patch.match(/^From:.*?<([^>]+@[^>]+)>/m)
    if (match) return match[1]
  } catch {
    return null
  }
  return null
}

async function getKeys(username: string): Promise<{ gpg: string | null; ssh: string | null }> {
  let gpg: string | null = null
  let ssh: string | null = null
  try {
    const gpgRes = await fetchWithTimeout(`https://github.com/${username}.gpg`, 5000)
    if (gpgRes.ok) {
      const text = await gpgRes.text()
      if (hasUsableGithubGpgKey(text)) gpg = `https://github.com/${username}.gpg`
    }
  } catch { /* ignore */ }
  try {
    const sshRes = await fetchWithTimeout(`https://github.com/${username}.keys`, 5000)
    if (sshRes.ok) {
      const text = await sshRes.text()
      if (text.trim().length > 10) ssh = `https://github.com/${username}.keys`
    }
  } catch { /* ignore */ }
  return { gpg, ssh }
}

export async function githubOsint(username: string): Promise<GitHubOsintResult> {
  const result: GitHubOsintResult = {
    username,
    profile: {},
    emails: [],
    gpgKeyUrl: null,
    sshKeyUrl: null,
    rawSummary: '',
  }

  // 1. Profil bilgisi
  const profile = await getProfile(username)
  if (!profile) {
    result.error = `GitHub user "${username}" not found or API rate limited.`
    result.rawSummary = result.error
    return result
  }
  result.profile = profile

  // Profile'daki email varsa ekle
  if (profile.email) result.emails.push(profile.email)

  // 2. Repolardan email çıkar (max 5 repo, paralel)
  const repos = await getRepos(username)
  const reposToCheck = repos.slice(0, 5)
  const emailPromises = reposToCheck.map((repo) => getEmailFromRepo(username, repo))
  const emailResults = await Promise.all(emailPromises)
  for (const email of emailResults) {
    if (email && !result.emails.includes(email)) result.emails.push(email)
  }

  // 3. GPG/SSH anahtarları
  const keys = await getKeys(username)
  result.gpgKeyUrl = keys.gpg
  result.sshKeyUrl = keys.ssh

  // 4. Ham özet metin (LLM için)
  const lines: string[] = [
    `=== GitHub OSINT: ${username} ===`,
    `Name: ${profile.name || 'N/A'}`,
    `Company: ${profile.company || 'N/A'}`,
    `Location: ${profile.location || 'N/A'}`,
    `Email (profile): ${profile.email || 'N/A'}`,
    `Bio: ${profile.bio || 'N/A'}`,
    `Blog: ${profile.blog || 'N/A'}`,
    `Twitter: ${profile.twitter_username || 'N/A'}`,
    `Followers: ${profile.followers} | Following: ${profile.following}`,
    `Public repos: ${profile.public_repos}`,
    `Created: ${profile.created_at}`,
    `Emails found in commits: ${result.emails.join(', ') || 'none'}`,
    `GPG key: ${result.gpgKeyUrl || 'none'}`,
    `SSH keys: ${result.sshKeyUrl || 'none'}`,
  ]
  result.rawSummary = lines.join('\n')

  return result
}

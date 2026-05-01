/**
 * GitHub OSINT Tool — uses the official GitHub API.
 * Web scraping yok, IP ban riski yok.
 * Fetches commit emails from the .patch endpoint (provided by GitHub).
 */

import { hasUsableGithubGpgKey } from './githubGpgUtils.js'

interface GitHubProfile {
  login: string
  avatar_url: string | null
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

export interface SocialAccount {
  provider: string
  url: string
}

export interface GitHubOsintResult {
  username: string
  profile: Partial<GitHubProfile>
  emails: string[]
  gpgKeyUrl: string | null
  sshKeyUrl: string | null
  socialAccounts: SocialAccount[]
  following: FollowingProfile[]
  rawSummary: string
  error?: string
}

const GITHUB_API = 'https://api.github.com'
const REQUEST_TIMEOUT = 8000
const FOLLOWING_FOLLOWER_THRESHOLD = 500 // Counts below this are treated as real people
const DEEP_SLEEP_MS = 300 // Delay between API calls

function getAuthHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN
  return {
    'User-Agent': 'osint-agent/1.0',
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url: string, ms = REQUEST_TIMEOUT): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: getAuthHeaders(),
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function getProfile(username: string): Promise<{ profile: GitHubProfile | null; status: number }> {
  try {
    const res = await fetchWithTimeout(`${GITHUB_API}/users/${username}`)
    if (!res.ok) return { profile: null, status: res.status }
    return { profile: await res.json() as GitHubProfile, status: 200 }
  } catch {
    return { profile: null, status: 0 }
  }
}

export interface FollowingProfile {
  username: string
  name: string | null
  bio: string | null
  blog: string | null
  location: string | null
  followers: number
  skipped: boolean // skipped because follower count exceeded threshold
}

async function getFollowing(username: string): Promise<FollowingProfile[]> {
  try {
    const res = await fetchWithTimeout(`${GITHUB_API}/users/${username}/following?per_page=50`)
    if (!res.ok) return []
    const list = await res.json() as Array<{ login: string }>
    const profiles: FollowingProfile[] = []
    for (const item of list) {
      await sleep(DEEP_SLEEP_MS)
      const { profile: p } = await getProfile(item.login)
      if (!p) continue
      profiles.push({
        username: p.login,
        name: p.name,
        bio: p.bio,
        blog: p.blog,
        location: p.location,
        followers: p.followers,
        skipped: p.followers >= FOLLOWING_FOLLOWER_THRESHOLD,
      })
    }
    return profiles
  } catch {
    return []
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
    // GitHub's official .patch endpoint — publicly accessible, not scraping
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

async function getSocialAccounts(username: string): Promise<SocialAccount[]> {
  try {
    const res = await fetchWithTimeout(`${GITHUB_API}/users/${username}/social_accounts`)
    if (!res.ok) return []
    return await res.json() as SocialAccount[]
  } catch {
    return []
  }
}

export async function githubOsint(username: string, deep = false): Promise<GitHubOsintResult> {
  const result: GitHubOsintResult = {
    username,
    profile: {},
    emails: [],
    gpgKeyUrl: null,
    sshKeyUrl: null,
    socialAccounts: [],
    following: [],
    rawSummary: '',
  }

  // 1. Profil bilgisi
  const { profile, status } = await getProfile(username)
  if (!profile) {
    if (status === 401) {
      result.error = `GitHub API authentication failed — GITHUB_TOKEN is expired or invalid. Please refresh the token in .env.`
    } else if (status === 403) {
      result.error = `GitHub API rate limit exceeded for "${username}". Try again later or add/refresh GITHUB_TOKEN in .env.`
    } else if (status === 404) {
      result.error = `GitHub user "${username}" does not exist.`
    } else {
      result.error = `GitHub API request failed for "${username}" (status: ${status || 'network error'}).`
    }
    result.rawSummary = result.error
    return result
  }
  result.profile = profile

  // Profile'daki email varsa ekle
  if (profile.email) result.emails.push(profile.email)

  // 2. Extract emails from repos (max 5 repos, parallel)
  const repos = await getRepos(username)
  const reposToCheck = repos.slice(0, 5)
  const emailPromises = reposToCheck.map((repo) => getEmailFromRepo(username, repo))
  const emailResults = await Promise.all(emailPromises)
  for (const email of emailResults) {
    if (email && !result.emails.includes(email)) result.emails.push(email)
  }

  // 3. GPG/SSH keys
  const keys = await getKeys(username)
  result.gpgKeyUrl = keys.gpg
  result.sshKeyUrl = keys.ssh

  // 3.5. Social Accounts (YouTube, LinkedIn vb.)
  result.socialAccounts = await getSocialAccounts(username)

  // 4. DEEP MODE: following list — only when requested
  if (deep && profile.following > 0 && profile.following <= 200) {
    result.following = await getFollowing(username)
  } else if (deep && profile.following > 200) {
    // Too many followings — listing is not practical
    result.rawSummary += `\n[Deep mode: ${profile.following} followings, limit exceeded (>200), skipped]`
  }

  // 5. Raw summary text (for LLM)
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

  if (result.socialAccounts.length > 0) {
    lines.push(`Social Accounts:`)
    result.socialAccounts.forEach(account => {
      lines.push(`  - [${account.provider}]: ${account.url}`)
    })
  }

  if (result.following.length > 0) {
    const realPeople = result.following.filter(f => !f.skipped)
    const skipped = result.following.filter(f => f.skipped)
    lines.push(`\n--- Following Analizi (Deep Mod) ---`)
    lines.push(`✅ To research (< ${FOLLOWING_FOLLOWER_THRESHOLD} followers): ${realPeople.length} person(s)`)
    lines.push(`⏭️  Skipped (>= ${FOLLOWING_FOLLOWER_THRESHOLD} followers): ${skipped.length} person(s)`)
    for (const f of realPeople) {
      lines.push(`  - ${f.username}${f.name ? ` (${f.name})` : ''}${f.bio ? ` | Bio: ${f.bio}` : ''}${f.location ? ` | Konum: ${f.location}` : ''}${f.blog ? ` | Blog: ${f.blog}` : ''} [${f.followers} follower]`)
    }
  }

  result.rawSummary = lines.join('\n')
  return result
}

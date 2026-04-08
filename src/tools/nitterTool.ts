/**
 * Twitter/X profil aracı — Scrapling Stealth + Puppeteer stealth fallback
 *
 * Nitter instance'ları artık çoğunlukla bot korumalı veya kapalı.
 * Bu araç doğrudan twitter.com/x.com adresini Scrapling StealthyFetcher
 * ile çeker. Scrapling başarısız olursa Puppeteer stealth devreye girer.
 *
 * Scrapling conda ortamı: /home/berkayhsrt/anaconda3/envs/scrapling
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCRAPLING_PYTHON = process.env.SCRAPLING_PYTHON || '/home/berkayhsrt/anaconda3/envs/scrapling/bin/python'
const SCRAPLING_RUNNER = path.join(__dirname, 'scrapling_runner.py')

export interface NitterProfile {
  username: string
  displayName: string
  bio: string
  location: string
  website: string
  joinDate: string
  tweets: number
  followers: number
  following: number
  verified: boolean
  recentTweets: string[]
  avatarUrl: string
  error?: string
  instanceUsed?: string
}

/**
 * Twitter/X profilini Scrapling stealth browser ile çek.
 * og:description, og:title, og:image meta taglerine öncelik verir.
 */
export async function fetchNitterProfile(username: string): Promise<NitterProfile> {
  const cleanUsername = username.replace(/^@/, '').trim()
  const url = `https://x.com/${encodeURIComponent(cleanUsername)}`

  let scrapleResult: any = null

  // 1. Scrapling stealth dene
  try {
    const { stdout } = await execFileAsync(
      SCRAPLING_PYTHON,
      [SCRAPLING_RUNNER, url, '--stealth'],
      { timeout: 30000 }
    )
    scrapleResult = JSON.parse(stdout)
  } catch {
    // Scrapling yoksa / hata → Puppeteer fallback aşağıda
  }

  // 2. Scrapling başarılı mı kontrol et
  if (scrapleResult && !scrapleResult.error && scrapleResult.markdown) {
    return parseScraplingResult(cleanUsername, scrapleResult, 'scrapling-stealth')
  }

  // 3. dynamic mod fallback (JS ağır sayfalar için)
  try {
    const { stdout } = await execFileAsync(
      SCRAPLING_PYTHON,
      [SCRAPLING_RUNNER, url, '--dynamic'],
      { timeout: 40000 }
    )
    scrapleResult = JSON.parse(stdout)
    if (scrapleResult && !scrapleResult.error && scrapleResult.markdown) {
      return parseScraplingResult(cleanUsername, scrapleResult, 'scrapling-dynamic')
    }
  } catch {
    // devam
  }

  // 4. Tüm yöntemler başarısız
  return empty(cleanUsername,
    `Twitter/X profili çekilemedi. Scrapling conda ortamı aktif değil veya ` +
    `@${cleanUsername} profili gizli/silinmiş olabilir. ` +
    `Manuel kontrol: https://x.com/${cleanUsername}`
  )
}

function parseScraplingResult(username: string, result: any, source: string): NitterProfile {
  const markdown: string = result.markdown ?? ''
  const title: string = result.title ?? ''

  // title genellikle "Display Name (@username) / X" formatında gelir
  const displayNameMatch = title.match(/^(.+?)\s*\(@/)
  const displayName = displayNameMatch ? displayNameMatch[1].trim() : username

  // Bio — og:description genellikle profil biyografisini içerir
  const bioMatch = markdown.match(/(?:bio|description)[:\s]+([^\n]{10,200})/i)
  const bio = result.description ?? bioMatch?.[1]?.trim() ?? ''

  // Follower/following sayıları — metin içinden çek
  const followersMatch = markdown.match(/(\d[\d,.]+)\s*(?:Followers?|Takipçi)/i)
  const followingMatch = markdown.match(/(\d[\d,.]+)\s*(?:Following|Takip)/i)
  const tweetsMatch = markdown.match(/(\d[\d,.]+)\s*(?:posts?|tweets?|Gönderi)/i)

  return {
    username,
    displayName,
    bio,
    location: result.location ?? '',
    website: result.website ?? '',
    joinDate: '',
    tweets: parseStat(tweetsMatch?.[1]),
    followers: parseStat(followersMatch?.[1]),
    following: parseStat(followingMatch?.[1]),
    verified: markdown.toLowerCase().includes('verified') || title.includes('✓'),
    recentTweets: [],
    avatarUrl: result.avatarUrl ?? '',
    instanceUsed: source,
  }
}

function parseStat(text: string | undefined): number {
  if (!text) return 0
  const clean = text.replace(/,/g, '').replace(/\./g, '')
  if (text.toLowerCase().endsWith('k')) return Math.round(parseFloat(text) * 1000)
  if (text.toLowerCase().endsWith('m')) return Math.round(parseFloat(text) * 1_000_000)
  return parseInt(clean, 10) || 0
}

function empty(username: string, error: string): NitterProfile {
  return {
    username,
    displayName: '',
    bio: '',
    location: '',
    website: '',
    joinDate: '',
    tweets: 0,
    followers: 0,
    following: 0,
    verified: false,
    recentTweets: [],
    avatarUrl: '',
    error,
  }
}

/**
 * Profil sonucunu formatla
 */
export function formatNitterResult(profile: NitterProfile): string {
  if (profile.error) {
    return `❌ Twitter/X profil hatası (@${profile.username}): ${profile.error}`
  }

  const lines: string[] = [
    `🐦 Twitter/X Profili: @${profile.username}`,
    `(Kaynak: ${profile.instanceUsed ?? 'scrapling'})`,
    '',
    `İsim: ${profile.displayName || 'N/A'}`,
    `Bio: ${profile.bio || 'N/A'}`,
    `Konum: ${profile.location || 'N/A'}`,
    `Web: ${profile.website || 'N/A'}`,
    `Tweet: ${profile.tweets || 'N/A'}`,
    `Takipçi: ${profile.followers || 'N/A'}`,
    `Takip: ${profile.following || 'N/A'}`,
    `Doğrulanmış: ${profile.verified ? '✅ Evet' : '❌ Hayır'}`,
  ]

  if (profile.avatarUrl) lines.push(`Avatar: ${profile.avatarUrl}`)
  if (profile.recentTweets.length > 0) {
    lines.push('', 'Son Tweetler:')
    profile.recentTweets.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`))
  }

  return lines.join('\n')
}



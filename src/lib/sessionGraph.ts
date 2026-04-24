import type { Message } from '../agents/types.js'
import { isInternalControlMessage } from './agentSession.js'
import { isCommonName, isLikelyUsernameCandidate } from './osintHeuristics.js'

export type SessionGraphReplayEvent =
  | { type: 'progress'; msg: string; ts?: string }
  | { type: 'detail'; toolName: string; output: string; toolCallId?: string }
  | { type: 'telemetry'; msg: string; ts?: string }

export interface SessionGraphNode {
  id: string
  kind: 'session' | 'query' | 'agent' | 'tool' | 'entity' | 'source' | 'topic'
  subtype?: string
  label: string
  score: number
  mentionCount: number
  active: boolean
}

export interface SessionGraphEdge {
  id: string
  source: string
  target: string
  relation: string
  weight: number
  mentionCount: number
}

export interface SessionGraph {
  sessionId: string
  revision: number
  nodes: SessionGraphNode[]
  edges: SessionGraphEdge[]
  limits: {
    maxNodes: number
    maxEdges: number
  }
}

export interface SessionToolInvocation {
  toolName: string
  args: Record<string, unknown>
  occurrence: number
  toolCallId?: string
}

export interface SessionToolInvocationWithOutput extends SessionToolInvocation {
  output: string
}

interface MutableNode extends SessionGraphNode {
  degree: number
  required: boolean
}

interface MutableEdge extends SessionGraphEdge {}

const MAX_NODES = 24
const MAX_EDGES = 36

const URL_REGEX = /https?:\/\/[^\s)\]]+/gi
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const HEADING_REGEX = /^#{1,3}\s+(.{4,100})$/
const PLACEHOLDER_VALUES = new Set(['n/a', 'none', 'null', 'unknown', '-', 'n\u002fa'])
const TOOL_LABELS: Record<string, string> = {
  run_github_osint: 'GitHub OSINT',
  run_sherlock: 'Sherlock',
  run_maigret: 'Maigret',
  parse_gpg_key: 'GPG Parse',
  check_email_registrations: 'Email Registration Check',
  search_web: 'Web Search',
  search_web_multi: 'Web Search',
  search_academic_papers: 'Academic Search',
  search_researcher_papers: 'Researcher Search',
  web_fetch: 'Web Fetch',
  scrape_profile: 'Profile Scrape',
  verify_claim: 'Claim Verification',
}
const AGENTS = [
  { id: 'supervisor', label: 'Supervisor', patterns: ['supervisor', 'koordinat', 'routing', 'y\u00f6nlend'] },
  { id: 'identity', label: 'Identity', patterns: ['identityagent', 'identity agent', 'identity', 'kimlik', '🕵'] },
  { id: 'media', label: 'Media', patterns: ['mediaagent', 'media agent', 'media', 'medya', '📸'] },
  { id: 'academic', label: 'Academic', patterns: ['academicagent', 'academic agent', 'academic', 'akademik', '📚'] },
  { id: 'strategy', label: 'Strategy', patterns: ['strategyagent', 'strategy agent', 'strategy', 'strateji', '[strategy-'] },
] as const
const RENDERABLE_TOOLS = new Set([
  'run_github_osint',
  'run_sherlock',
  'run_maigret',
  'parse_gpg_key',
  'check_email_registrations',
  'search_web',
  'search_web_multi',
  'search_academic_papers',
  'search_researcher_papers',
  'web_fetch',
  'scrape_profile',
  'verify_claim',
])

function isRenderableToolName(toolName: string): boolean {
  return RENDERABLE_TOOLS.has(toolName)
}

function summarizeQuery(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function slugify(value: string): string {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'item'
}

function hashLabel(value: string): string {
  let hash = 2166136261
  for (const char of normalizeKey(value)) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function createNodeId(kind: SessionGraphNode['kind'], subtype: string | undefined, label: string): string {
  return [kind, subtype || 'generic', slugify(label), hashLabel(label)].join(':')
}

function createEdgeId(source: string, target: string, relation: string): string {
  return `${source}->${relation}->${target}`
}

function cleanValue(value: string | undefined | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const lowered = trimmed.toLowerCase()
  if (PLACEHOLDER_VALUES.has(lowered)) return null
  if (trimmed.includes('***')) return null
  if (lowered === 'no results found.') return null
  return trimmed
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) || []
  return [...new Set(matches.map(email => email.toLowerCase()))]
}

function normalizeUrl(url: string): string {
  return url.replace(/[),.;]+$/, '')
}

function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) || []
  return [...new Set(matches.map(normalizeUrl))]
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function extractHeadingTopics(messages: Message[]): string[] {
  const topics = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue
    if ((message as any).tool_calls?.length) continue
    for (const line of message.content.split('\n')) {
      const match = HEADING_REGEX.exec(line.trim())
      if (!match) continue
      const heading = match[1]?.trim()
      if (!heading) continue
      const lowered = heading.toLowerCase()
      if (['findings', 'summary', 'results', 'recent sources', 'report'].includes(lowered)) continue
      topics.add(heading)
      if (topics.size >= 4) return [...topics]
    }
  }
  return [...topics]
}

// Maps Turkish/English finding keys to entity kinds for the session map
const FINDING_KEY_MAP: Record<string, { kind: SessionGraphNode['kind']; subtype: string }> = {
  // username variants
  'username': { kind: 'entity', subtype: 'username' },
  'kullanıcı adı': { kind: 'entity', subtype: 'username' },
  'kullanici adi': { kind: 'entity', subtype: 'username' },
  'user': { kind: 'entity', subtype: 'username' },
  'handle': { kind: 'entity', subtype: 'username' },
  // real name variants
  'name': { kind: 'entity', subtype: 'person' },
  'gerçek isim': { kind: 'entity', subtype: 'person' },
  'gercek isim': { kind: 'entity', subtype: 'person' },
  'real name': { kind: 'entity', subtype: 'person' },
  'full name': { kind: 'entity', subtype: 'person' },
  'isim': { kind: 'entity', subtype: 'person' },
  'ad soyad': { kind: 'entity', subtype: 'person' },
  // location variants
  'location': { kind: 'entity', subtype: 'location' },
  'konum': { kind: 'entity', subtype: 'location' },
  'şehir': { kind: 'entity', subtype: 'location' },
  'sehir': { kind: 'entity', subtype: 'location' },
  'city': { kind: 'entity', subtype: 'location' },
  'country': { kind: 'entity', subtype: 'location' },
  'ülke': { kind: 'entity', subtype: 'location' },
  'ulke': { kind: 'entity', subtype: 'location' },
  // organization variants
  'company': { kind: 'entity', subtype: 'organization' },
  'organization': { kind: 'entity', subtype: 'organization' },
  'organisation': { kind: 'entity', subtype: 'organization' },
  'kurum': { kind: 'entity', subtype: 'organization' },
  'kuruluş': { kind: 'entity', subtype: 'organization' },
  'şirket': { kind: 'entity', subtype: 'organization' },
  'sirket': { kind: 'entity', subtype: 'organization' },
  'institution': { kind: 'entity', subtype: 'organization' },
  'employer': { kind: 'entity', subtype: 'organization' },
  // email variants
  'email': { kind: 'entity', subtype: 'email' },
  'e-mail': { kind: 'entity', subtype: 'email' },
  'e-posta': { kind: 'entity', subtype: 'email' },
  'eposta': { kind: 'entity', subtype: 'email' },
  // website / blog
  'blog': { kind: 'entity', subtype: 'website' },
  'website': { kind: 'entity', subtype: 'website' },
  'web site': { kind: 'entity', subtype: 'website' },
  'site': { kind: 'entity', subtype: 'website' },
  // platform
  'platform': { kind: 'source', subtype: 'platform' },
  // twitter / social
  'twitter': { kind: 'entity', subtype: 'username' },
  'linkedin': { kind: 'source', subtype: 'platform' },
}

function extractFindingsFromFinalAnswer(messages: Message[]): Array<{ key: string; value: string; kind: SessionGraphNode['kind']; subtype: string }> {
  const findings: Array<{ key: string; value: string; kind: SessionGraphNode['kind']; subtype: string }> = []
  const seen = new Set<string>()

  function tryAdd(rawKey: string, rawValue: string): void {
    const key = rawKey.trim().replace(/\*/g, '').toLowerCase()
    const value = cleanValue(rawValue.replace(/\*/g, '').replace(/`/g, ''))
    if (!value) return
    // Skip header-like rows and separators
    if (value.startsWith('-') || value.startsWith(':') || value === '---') return
    // Skip pure numeric / stats values (followers: 298k, repos: 11, id: 1024025)
    // We want meaningful entity values only
    const mapping = FINDING_KEY_MAP[key]
    if (!mapping) return
    const dedupeKey = `${mapping.subtype}:${value.toLowerCase()}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    findings.push({ key: rawKey.trim(), value, ...mapping })
  }

  // Walk messages from last to first; stop once we find a substantial final answer
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue
    if ((msg as any).tool_calls?.length) continue
    const content = msg.content.trim()
    if (content.length < 20) continue

    // 1. Parse markdown table rows: | Key | Value |  (any number of columns; take first two)
    const tableRowRegex = /^\|([^|\n]+)\|([^|\n]+)\|/gm
    let match: RegExpExecArray | null
    while ((match = tableRowRegex.exec(content)) !== null) {
      tryAdd(match[1], match[2])
    }

    // 2. Parse bold key-value: **Key**: value or **Key** value
    const boldKvRegex = /\*\*([^*\n]{2,40}?)\*\*[:\s]+([^\n]{1,120})/g
    while ((match = boldKvRegex.exec(content)) !== null) {
      tryAdd(match[1], match[2])
    }

    // 3. Parse plain key-value lines: "Key: value" at start of line
    const plainKvRegex = /^([A-Za-zığüşöçİĞÜŞÖÇ][A-Za-z\s\-ığüşöçİĞÜŞÖÇ]{1,40}):\s+([^\n]{1,120})/gm
    while ((match = plainKvRegex.exec(content)) !== null) {
      tryAdd(match[1], match[2])
    }

    if (findings.length > 0) break  // found a substantial answer, stop
  }

  return findings.slice(0, 8)  // cap at 8 finding nodes to avoid clutter
}

function humanizeToolName(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName]
  return toolName
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function addNode(
  nodeMap: Map<string, MutableNode>,
  input: {
    kind: SessionGraphNode['kind']
    subtype?: string
    label: string
    score?: number
    active?: boolean
    required?: boolean
  },
): MutableNode {
  const id = createNodeId(input.kind, input.subtype, input.label)
  const existing = nodeMap.get(id)
  if (existing) {
    existing.score += input.score ?? 0
    existing.mentionCount += 1
    existing.active = existing.active || Boolean(input.active)
    existing.required = existing.required || Boolean(input.required)
    return existing
  }

  const created: MutableNode = {
    id,
    kind: input.kind,
    subtype: input.subtype,
    label: input.label,
    score: input.score ?? 0,
    mentionCount: 1,
    active: Boolean(input.active),
    degree: 0,
    required: Boolean(input.required),
  }
  nodeMap.set(id, created)
  return created
}

function addEdge(edgeMap: Map<string, MutableEdge>, source: MutableNode, target: MutableNode, relation: string, weight = 1): void {
  if (source.id === target.id) return
  const id = createEdgeId(source.id, target.id, relation)
  const existing = edgeMap.get(id)
  if (existing) {
    existing.weight += weight
    existing.mentionCount += 1
    return
  }

  edgeMap.set(id, {
    id,
    source: source.id,
    target: target.id,
    relation,
    weight,
    mentionCount: 1,
  })
}

function buildAgentNodes(nodeMap: Map<string, MutableNode>, edgeMap: Map<string, MutableEdge>, sessionNode: MutableNode, replayEvents: SessionGraphReplayEvent[]): void {
  const seenAgents = new Map<string, number>()

  for (const event of replayEvents) {
    if (event.type !== 'progress' && event.type !== 'telemetry') continue
    const lowered = event.msg.toLowerCase()
    for (const agent of AGENTS) {
      if (!agent.patterns.some(pattern => lowered.includes(pattern))) continue
      seenAgents.set(agent.id, (seenAgents.get(agent.id) ?? 0) + 1)
    }
  }

  for (const agent of AGENTS) {
    const count = seenAgents.get(agent.id) ?? 0
    if (count === 0) continue
    const node = addNode(nodeMap, {
      kind: 'agent',
      subtype: agent.id,
      label: agent.label,
      score: 18 + count * 4,
      active: count > 0,
    })
    addEdge(edgeMap, sessionNode, node, 'ORCHESTRATES', count)
  }
}

function addSourceDomains(nodeMap: Map<string, MutableNode>, edgeMap: Map<string, MutableEdge>, toolNode: MutableNode, text: string): void {
  for (const url of extractUrls(text).slice(0, 6)) {
    const domain = extractDomain(url)
    if (!domain) continue
    const domainNode = addNode(nodeMap, {
      kind: 'source',
      subtype: 'domain',
      label: domain,
      score: 10,
    })
    addEdge(edgeMap, toolNode, domainNode, 'SURFACED', 1)
  }
}

function addSeedFromArgs(nodeMap: Map<string, MutableNode>, edgeMap: Map<string, MutableEdge>, toolNode: MutableNode, args: Record<string, unknown>): MutableNode[] {
  const seeds: MutableNode[] = []

  if (typeof args.username === 'string') {
    const username = cleanValue(args.username)
    if (username) {
      const usernameNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'username',
        label: username,
        score: 18,
      })
      addEdge(edgeMap, toolNode, usernameNode, 'LOOKED_UP', 1)
      seeds.push(usernameNode)
    }
  }

  if (typeof args.email === 'string') {
    const email = cleanValue(args.email)?.toLowerCase()
    if (email) {
      const emailNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'email',
        label: email,
        score: 20,
      })
      addEdge(edgeMap, toolNode, emailNode, 'LOOKED_UP', 1)
      seeds.push(emailNode)
    }
  }

  if (typeof args.url === 'string') {
    const url = cleanValue(args.url)
    if (url) {
      const domain = extractDomain(url)
      if (domain) {
        const domainNode = addNode(nodeMap, {
          kind: 'source',
          subtype: 'domain',
          label: domain,
          score: 10,
        })
        addEdge(edgeMap, toolNode, domainNode, 'LOOKED_UP', 1)
        seeds.push(domainNode)
      }
    }
  }

  return seeds
}

function addGitHubEntities(
  nodeMap: Map<string, MutableNode>,
  edgeMap: Map<string, MutableEdge>,
  toolNode: MutableNode,
  seedUsernameNode: MutableNode | undefined,
  output: string,
): void {
  const inferredUsername = /^=== GitHub OSINT:\s+(.+?)\s+===/m.exec(output)?.[1]?.trim()
  const usernameNode = seedUsernameNode || (inferredUsername
    ? addNode(nodeMap, {
        kind: 'entity',
        subtype: 'username',
        label: inferredUsername,
        score: 18,
      })
    : undefined)

  if (usernameNode && !seedUsernameNode) {
    addEdge(edgeMap, toolNode, usernameNode, 'LOOKED_UP', 1)
  }

  const lines = output.split('\n').map(line => line.trim())
  let inSocialAccounts = false

  for (const line of lines) {
    if (!line) continue
    if (line === 'Social Accounts:') {
      inSocialAccounts = true
      continue
    }

    if (inSocialAccounts && line.startsWith('- [')) {
      const match = /^- \[([^\]]+)\]:\s+(.+)$/.exec(line)
      if (match?.[1]) {
        const platformNode = addNode(nodeMap, {
          kind: 'source',
          subtype: 'platform',
          label: match[1],
          score: 10,
        })
        addEdge(edgeMap, toolNode, platformNode, 'FOUND_ON', 1)
        if (usernameNode) addEdge(edgeMap, usernameNode, platformNode, 'HAS_PROFILE_ON', 1)
      }
      continue
    }

    const fieldMatch = /^([^:]+):\s+(.+)$/.exec(line)
    if (!fieldMatch) continue
    const fieldName = fieldMatch[1]?.trim().toLowerCase()
    const fieldValue = cleanValue(fieldMatch[2])
    if (!fieldName || !fieldValue) continue

    if (fieldName === 'name') {
      if (!isCommonName(fieldValue) && fieldValue.split(/\s+/).length === 1) continue
      const personNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'person',
        label: fieldValue,
        score: 20,
      })
      addEdge(edgeMap, toolNode, personNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, personNode, 'POSSIBLE_REAL_NAME', 1)
      continue
    }

    if (fieldName === 'company') {
      const orgNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'organization',
        label: fieldValue,
        score: 12,
      })
      addEdge(edgeMap, toolNode, orgNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, orgNode, 'WORKS_AT', 1)
      continue
    }

    if (fieldName === 'location') {
      const locationNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'location',
        label: fieldValue,
        score: 12,
      })
      addEdge(edgeMap, toolNode, locationNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, locationNode, 'LOCATED_IN', 1)
      continue
    }

    if (fieldName === 'email (profile)') {
      const email = fieldValue.toLowerCase()
      const emailNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'email',
        label: email,
        score: 22,
      })
      addEdge(edgeMap, toolNode, emailNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, emailNode, 'USES_EMAIL', 1)
      continue
    }

    if (fieldName === 'emails found in commits') {
      for (const email of fieldValue.split(',').map(part => cleanValue(part)?.toLowerCase()).filter(Boolean) as string[]) {
        const emailNode = addNode(nodeMap, {
          kind: 'entity',
          subtype: 'email',
          label: email,
          score: 20,
        })
        addEdge(edgeMap, toolNode, emailNode, 'FOUND', 1)
        if (usernameNode) addEdge(edgeMap, usernameNode, emailNode, 'USES_EMAIL', 1)
      }
      continue
    }

    if (fieldName === 'blog') {
      const url = fieldValue.startsWith('http') ? fieldValue : `https://${fieldValue}`
      const websiteNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'website',
        label: url,
        score: 12,
      })
      addEdge(edgeMap, toolNode, websiteNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, websiteNode, 'OWNS_WEBSITE', 1)
      continue
    }

    if (fieldName === 'twitter') {
      const handleNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'username',
        label: fieldValue,
        score: 10,
      })
      addEdge(edgeMap, toolNode, handleNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, handleNode, 'TWITTER_ACCOUNT', 1)
    }
  }

  addSourceDomains(nodeMap, edgeMap, toolNode, output)
}

function addGpgEntities(
  nodeMap: Map<string, MutableNode>,
  edgeMap: Map<string, MutableEdge>,
  toolNode: MutableNode,
  seedUsernameNode: MutableNode | undefined,
  output: string,
): void {
  const inferredSource = /^=== GPG Key Analizi:\s+(.+?)\s+===/m.exec(output)?.[1]?.trim()
  const usernameNode = seedUsernameNode || (inferredSource && isLikelyUsernameCandidate(inferredSource)
    ? addNode(nodeMap, {
        kind: 'entity',
        subtype: 'username',
        label: inferredSource,
        score: 16,
      })
    : undefined)

  if (usernameNode && !seedUsernameNode) {
    addEdge(edgeMap, toolNode, usernameNode, 'LOOKED_UP', 1)
  }

  let section: 'emails' | 'names' | null = null

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.includes('Bulunan email adresleri')) {
      section = 'emails'
      continue
    }
    if (line.includes('Bulunan isimler')) {
      section = 'names'
      continue
    }

    const bullet = /^-\s+(.+)$/.exec(line)
    if (!bullet?.[1]) continue
    const value = cleanValue(bullet[1])
    if (!value) continue

    if (section === 'emails') {
      const emailNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'email',
        label: value.toLowerCase(),
        score: 20,
      })
      addEdge(edgeMap, toolNode, emailNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, emailNode, 'USES_EMAIL', 1)
      continue
    }

    if (section === 'names') {
      const personNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'person',
        label: value,
        score: 18,
      })
      addEdge(edgeMap, toolNode, personNode, 'FOUND', 1)
      if (usernameNode) addEdge(edgeMap, usernameNode, personNode, 'POSSIBLE_REAL_NAME', 1)
    }
  }
}

function addHoleheEntities(
  nodeMap: Map<string, MutableNode>,
  edgeMap: Map<string, MutableEdge>,
  toolNode: MutableNode,
  seedEmailNode: MutableNode | undefined,
  output: string,
): void {
  const inferredEmail = /Email Registration Check:\s+([^\s]+)/.exec(output)?.[1]?.trim()?.toLowerCase()
  const emailNode = seedEmailNode || (inferredEmail
    ? addNode(nodeMap, {
        kind: 'entity',
        subtype: 'email',
        label: inferredEmail,
        score: 20,
      })
    : undefined)

  if (emailNode && !seedEmailNode) {
    addEdge(edgeMap, toolNode, emailNode, 'LOOKED_UP', 1)
  }

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('[+] ')) continue
    const platformName = cleanValue(line.replace(/^\[\+]\s+/, '').replace(/\s+\(.+$/, ''))
    if (!platformName) continue
    const platformNode = addNode(nodeMap, {
      kind: 'source',
      subtype: 'platform',
      label: platformName,
      score: 12,
    })
    addEdge(edgeMap, toolNode, platformNode, 'FOUND_ON', 1)
    if (emailNode) addEdge(edgeMap, emailNode, platformNode, 'REGISTERED_ON', 1)
  }
}

function addSherlockEntities(
  nodeMap: Map<string, MutableNode>,
  edgeMap: Map<string, MutableEdge>,
  toolNode: MutableNode,
  seedUsernameNode: MutableNode | undefined,
  output: string,
): void {
  let usernameNode = seedUsernameNode
  let added = 0
  for (const rawLine of output.split('\n')) {
    if (added >= 6) break
    const line = rawLine.trim()
    const match = /^\[\+\]\s+([^:]+):\s+(https?:\/\/\S+)/.exec(line)
    if (!match?.[1]) continue
    if (!usernameNode) {
      const candidate = match[2]?.replace(/[),.;]+$/, '').split('/').filter(Boolean).pop()
      if (candidate && isLikelyUsernameCandidate(candidate)) {
        usernameNode = addNode(nodeMap, {
          kind: 'entity',
          subtype: 'username',
          label: candidate,
          score: 16,
        })
        addEdge(edgeMap, toolNode, usernameNode, 'LOOKED_UP', 1)
      }
    }
    const platformNode = addNode(nodeMap, {
      kind: 'source',
      subtype: 'platform',
      label: match[1].trim(),
      score: 10,
    })
    addEdge(edgeMap, toolNode, platformNode, 'FOUND_ON', 1)
    if (usernameNode) addEdge(edgeMap, usernameNode, platformNode, 'HAS_PROFILE_ON', 1)
    added += 1
  }
  addSourceDomains(nodeMap, edgeMap, toolNode, output)
}

function addGenericEntities(
  nodeMap: Map<string, MutableNode>,
  edgeMap: Map<string, MutableEdge>,
  toolNode: MutableNode,
  output: string,
): void {
  addSourceDomains(nodeMap, edgeMap, toolNode, output)
}

function finalizeGraph(sessionId: string, nodeMap: Map<string, MutableNode>, edgeMap: Map<string, MutableEdge>, revision: number): SessionGraph {
  for (const node of nodeMap.values()) node.degree = 0
  for (const edge of edgeMap.values()) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (source) source.degree += 1
    if (target) target.degree += 1
  }

  const allNodes = [...nodeMap.values()].sort((left, right) => {
    if (left.required !== right.required) return Number(right.required) - Number(left.required)
    if (left.active !== right.active) return Number(right.active) - Number(left.active)
    if (left.degree !== right.degree) return right.degree - left.degree
    if (left.score !== right.score) return right.score - left.score
    return left.label.localeCompare(right.label)
  })

  const keptIds = new Set(allNodes.slice(0, MAX_NODES).map(node => node.id))
  let edges = [...edgeMap.values()]
    .filter(edge => keptIds.has(edge.source) && keptIds.has(edge.target))
    .sort((left, right) => {
      if (left.weight !== right.weight) return right.weight - left.weight
      return left.relation.localeCompare(right.relation)
    })
    .slice(0, MAX_EDGES)

  const connectedIds = new Set<string>()
  for (const edge of edges) {
    connectedIds.add(edge.source)
    connectedIds.add(edge.target)
  }

  const nodes = allNodes
    .filter(node => keptIds.has(node.id))
    .filter(node => node.required || connectedIds.has(node.id) || node.kind === 'session')
    .map(({ degree: _degree, required: _required, ...node }) => node)

  const finalNodeIds = new Set(nodes.map(node => node.id))
  edges = edges.filter(edge => finalNodeIds.has(edge.source) && finalNodeIds.has(edge.target))

  return {
    sessionId,
    revision,
    nodes,
    edges,
    limits: {
      maxNodes: MAX_NODES,
      maxEdges: MAX_EDGES,
    },
  }
}

function getVisibleUserMessages(history: Message[]): string[] {
  return history.flatMap((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return []
    const content = message.content.trim()
    if (!content || isInternalControlMessage(content)) return []
    return [content]
  })
}

export function extractToolInvocations(history: Message[]): SessionToolInvocation[] {
  const counts = new Map<string, number>()
  const invocations: SessionToolInvocation[] = []

  for (const message of history) {
    const toolCalls = Array.isArray((message as any).tool_calls) ? (message as any).tool_calls : []
    for (const toolCall of toolCalls) {
      if (toolCall?.type !== 'function') continue
      const toolName = String(toolCall.function?.name || '').trim()
      if (!toolName) continue

      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(String(toolCall.function?.arguments || '{}'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        args = {}
      }

      const occurrence = counts.get(toolName) ?? 0
      counts.set(toolName, occurrence + 1)
      invocations.push({
        toolName,
        args,
        occurrence,
        toolCallId: typeof toolCall.id === 'string' ? toolCall.id : undefined,
      })
    }
  }

  return invocations
}

export function pairDetailEventsToInvocations(
  invocations: SessionToolInvocation[],
  replayEvents: SessionGraphReplayEvent[],
): SessionToolInvocationWithOutput[] {
  const detailEvents = replayEvents
    .filter((event): event is Extract<SessionGraphReplayEvent, { type: 'detail' }> => event.type === 'detail')
    .map(event => ({ ...event, matched: false }))

  return invocations.map((invocation) => {
    let matchedEvent = invocation.toolCallId
      ? detailEvents.find(event => !event.matched && event.toolCallId === invocation.toolCallId)
      : undefined

    if (!matchedEvent) {
      matchedEvent = detailEvents.find(event => !event.matched && event.toolName === invocation.toolName)
    }

    if (matchedEvent) matchedEvent.matched = true

    return {
      ...invocation,
      output: matchedEvent?.output ?? '',
    }
  })
}

function pairToolOutputsToInvocations(
  invocations: SessionToolInvocation[],
  history: Message[],
  replayEvents: SessionGraphReplayEvent[],
): SessionToolInvocationWithOutput[] {
  const outputsByToolCallId = new Map<string, string>()
  for (const message of history) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue
    const toolCallId = typeof (message as any).tool_call_id === 'string' ? (message as any).tool_call_id : null
    if (!toolCallId || !message.content.trim()) continue
    outputsByToolCallId.set(toolCallId, message.content)
  }

  return pairDetailEventsToInvocations(invocations, replayEvents).map((invocation) => {
    const historyOutput = invocation.toolCallId ? outputsByToolCallId.get(invocation.toolCallId) || '' : ''
    const replayOutput = invocation.output || ''
    const preferredOutput = historyOutput.length >= replayOutput.length ? historyOutput : replayOutput

    return {
      ...invocation,
      output: preferredOutput,
    }
  })
}

export function buildSessionGraph(input: {
  sessionId: string
  history: Message[]
  replayEvents: SessionGraphReplayEvent[]
}): SessionGraph {
  const { sessionId, history, replayEvents } = input
  const nodeMap = new Map<string, MutableNode>()
  const edgeMap = new Map<string, MutableEdge>()

  const sessionNode = addNode(nodeMap, {
    kind: 'session',
    subtype: 'session',
    label: 'Current Session',
    score: 100,
    active: true,
    required: true,
  })

  const queries = getVisibleUserMessages(history).slice(-2)
  const queryNodes = queries.map((query, index) => {
    const queryNode = addNode(nodeMap, {
      kind: 'query',
      subtype: 'query',
      label: summarizeQuery(query),
      score: index === queries.length - 1 ? 40 : 24,
      active: index === queries.length - 1,
      required: index === queries.length - 1,
    })
    addEdge(edgeMap, sessionNode, queryNode, 'QUESTION', 1)

    for (const email of extractEmails(query)) {
      const emailNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'email',
        label: email,
        score: 18,
      })
      addEdge(edgeMap, queryNode, emailNode, 'FOCUSES_ON', 1)
    }

    for (const url of extractUrls(query)) {
      const domain = extractDomain(url)
      if (!domain) continue
      const domainNode = addNode(nodeMap, {
        kind: 'source',
        subtype: 'domain',
        label: domain,
        score: 10,
      })
      addEdge(edgeMap, queryNode, domainNode, 'FOCUSES_ON', 1)
    }

    const candidateTokens = query.match(/[A-Za-z0-9_.-]{3,30}/g) || []
    for (const token of candidateTokens.slice(0, 6)) {
      if (!isLikelyUsernameCandidate(token)) continue
      const lowered = token.toLowerCase()
      if (['research', 'investigate', 'papers', 'paper', 'recent', 'query', 'session', 'github'].includes(lowered)) continue
      const usernameNode = addNode(nodeMap, {
        kind: 'entity',
        subtype: 'username',
        label: token,
        score: 12,
      })
      addEdge(edgeMap, queryNode, usernameNode, 'FOCUSES_ON', 1)
      break
    }

    return queryNode
  })

  buildAgentNodes(nodeMap, edgeMap, sessionNode, replayEvents)

  for (const topic of extractHeadingTopics(history)) {
    const topicNode = addNode(nodeMap, {
      kind: 'topic',
      subtype: 'heading',
      label: topic,
      score: 14,
    })
    const queryNode = queryNodes[queryNodes.length - 1] ?? sessionNode
    addEdge(edgeMap, queryNode, topicNode, 'HIGHLIGHTS', 1)
  }

  // Extract structured findings (username, real name, location, org, etc.) from the
  // agent's final answer and attach them directly to the last query node.
  const lastQueryNode = queryNodes[queryNodes.length - 1]
  if (lastQueryNode) {
    for (const finding of extractFindingsFromFinalAnswer(history)) {
      const findingNode = addNode(nodeMap, {
        kind: finding.kind,
        subtype: finding.subtype,
        label: finding.value,
        score: finding.subtype === 'person' ? 22 : finding.subtype === 'username' ? 20 : finding.subtype === 'email' ? 20 : 14,
      })
      addEdge(edgeMap, lastQueryNode, findingNode, 'FOUND', 2)
    }
  }

  const pairedInvocations = pairToolOutputsToInvocations(extractToolInvocations(history), history, replayEvents)
  const renderableItems: SessionToolInvocationWithOutput[] = [...pairedInvocations]
  const matchedToolCallIds = new Set(pairedInvocations.map(invocation => invocation.toolCallId).filter(Boolean))

  for (const event of replayEvents) {
    if (event.type !== 'detail' || !isRenderableToolName(event.toolName)) continue
    if (event.toolCallId && matchedToolCallIds.has(event.toolCallId)) continue
    renderableItems.push({
      toolName: event.toolName,
      args: {},
      occurrence: -1,
      toolCallId: event.toolCallId,
      output: event.output,
    })
  }

  for (const invocation of renderableItems) {
    if (!isRenderableToolName(invocation.toolName)) continue
    const toolNode = addNode(nodeMap, {
      kind: 'tool',
      subtype: invocation.toolName,
      label: humanizeToolName(invocation.toolName),
      score: 16,
      active: Boolean(invocation.output),
    })
    addEdge(edgeMap, sessionNode, toolNode, 'USES', 1)

    const seedNodes = addSeedFromArgs(nodeMap, edgeMap, toolNode, invocation.args)
    const seedUsernameNode = seedNodes.find(node => node.subtype === 'username')
    const seedEmailNode = seedNodes.find(node => node.subtype === 'email')

    if (invocation.toolName === 'run_github_osint') {
      addGitHubEntities(nodeMap, edgeMap, toolNode, seedUsernameNode, invocation.output)
      continue
    }

    if (invocation.toolName === 'parse_gpg_key') {
      addGpgEntities(nodeMap, edgeMap, toolNode, seedUsernameNode, invocation.output)
      continue
    }

    if (invocation.toolName === 'check_email_registrations') {
      addHoleheEntities(nodeMap, edgeMap, toolNode, seedEmailNode, invocation.output)
      continue
    }

    if (invocation.toolName === 'run_sherlock' || invocation.toolName === 'run_maigret') {
      addSherlockEntities(nodeMap, edgeMap, toolNode, seedUsernameNode, invocation.output)
      continue
    }

    addGenericEntities(nodeMap, edgeMap, toolNode, invocation.output)
  }

  return finalizeGraph(sessionId, nodeMap, edgeMap, history.length + replayEvents.length)
}
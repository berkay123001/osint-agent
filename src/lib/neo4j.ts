import neo4j, { Driver, Session } from 'neo4j-driver'

let driver: Driver | null = null
let driverUri: string | null = null

function getNeo4jUri(): string {
  return process.env.NEO4J_URI || 'bolt://localhost:7687'
}

function isSafeClearTarget(uri: string): boolean {
  return /^(bolt|neo4j):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(uri)
}

export function getDriver(): Driver {
  if (!driver) {
    driverUri = getNeo4jUri()
    driver = neo4j.driver(
      driverUri,
      neo4j.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || 'password'
      )
    )
  }
  return driver
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close()
    driver = null
    driverUri = null
  }
}

export async function clearGraph(): Promise<void> {
  if (process.env.NEO4J_ALLOW_CLEAR !== '1') {
    throw new Error('Graph clear işlemi için NEO4J_ALLOW_CLEAR=1 gerekli.')
  }

  const uri = getNeo4jUri()
  if (!isSafeClearTarget(uri)) {
    throw new Error(`Graph clear yalnızca lokal Neo4j hedeflerinde izinli: ${uri}`)
  }
  if (driverUri && driverUri !== uri) {
    throw new Error(`Aktif Neo4j bağlantısı (${driverUri}) ile clear hedefi (${uri}) uyuşmuyor.`)
  }

  const session = getDriver().session()
  try {
    await session.run('MATCH (n) DETACH DELETE n')
  } finally {
    await session.close()
  }
}

/** MERGE bir node — varsa günceller, yoksa oluşturur */
export async function mergeNode(
  label: string,
  properties: Record<string, string>
): Promise<void> {
  const session = getDriver().session()
  try {
    const key = properties.value || properties.name || Object.values(properties)[0]
    await session.run(
      `MERGE (n:${sanitizeLabel(label)} {value: $key})
       SET n += $props, n.updatedAt = datetime()`,
      { key, props: properties }
    )
  } finally {
    await session.close()
  }
}

/** Güven seviyesi — her ilişkiye atanır */
export type ConfidenceLevel = 'verified' | 'high' | 'medium' | 'low'

/** MERGE bir ilişki — iki node arasında edge oluşturur, kaynak ve güven seviyesi ile */
export async function mergeRelation(
  fromLabel: string,
  fromValue: string,
  toLabel: string,
  toValue: string,
  relationType: string,
  meta?: { source?: string; confidence?: ConfidenceLevel }
): Promise<void> {
  const session = getDriver().session()
  try {
    const setClause = meta
      ? `, r.source = $source, r.confidence = $confidence, r.updatedAt = datetime()`
      : ', r.updatedAt = datetime()'
    await session.run(
      `MERGE (a:${sanitizeLabel(fromLabel)} {value: $fromVal})
       MERGE (b:${sanitizeLabel(toLabel)} {value: $toVal})
       MERGE (a)-[r:${sanitizeLabel(relationType)}]->(b)
       SET r += {}${setClause}`,
      {
        fromVal: fromValue,
        toVal: toValue,
        source: meta?.source ?? 'unknown',
        confidence: meta?.confidence ?? 'medium',
      }
    )
  } finally {
    await session.close()
  }
}

/** Bir node'un tüm bağlantılarını getir — kaynak ve güven seviyesi ile */
export async function getConnections(value: string): Promise<
  Array<{ from: string; relation: string; to: string; toLabel: string; source?: string; confidence?: string }>
> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      `MATCH (a {value: $val})-[r]->(b)
       RETURN a.value AS from, type(r) AS relation, b.value AS to, labels(b)[0] AS toLabel,
              r.source AS source, r.confidence AS confidence
       UNION
       MATCH (a)-[r]->(b {value: $val})
       RETURN a.value AS from, type(r) AS relation, b.value AS to, labels(b)[0] AS toLabel,
              r.source AS source, r.confidence AS confidence
       UNION
       MATCH (a {value: $val})-[:HAS_PROFILE]->(:Profile)-[:ON_PLATFORM]->(platform:Platform)
       RETURN a.value AS from, 'HAS_PROFILE_ON' AS relation, platform.value AS to, labels(platform)[0] AS toLabel,
              null AS source, null AS confidence`,
      { val: value }
    )
    return result.records.map((r) => ({
      from: r.get('from') as string,
      relation: r.get('relation') as string,
      to: r.get('to') as string,
      toLabel: r.get('toLabel') as string,
      source: r.get('source') as string | undefined,
      confidence: r.get('confidence') as string | undefined,
    }))
  } finally {
    await session.close()
  }
}

/** Tüm graf istatistiklerini getir */
export async function getGraphStats(): Promise<{ nodes: number; relationships: number }> {
  const session = getDriver().session()
  try {
    const nodesResult = await session.run('MATCH (n) RETURN count(n) AS c')
    const relsResult = await session.run('MATCH ()-[r]->() RETURN count(r) AS c')
    return {
      nodes: (nodesResult.records[0]?.get('c') as any)?.toNumber?.() ?? 0,
      relationships: (relsResult.records[0]?.get('c') as any)?.toNumber?.() ?? 0,
    }
  } finally {
    await session.close()
  }
}

export async function getGraphNodeCountsByLabel(): Promise<Array<{ label: string; count: number }>> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS c ORDER BY label'
    )
    return result.records.map((record) => ({
      label: record.get('label') as string,
      count: (record.get('c') as any)?.toNumber?.() ?? Number(record.get('c')),
    }))
  } finally {
    await session.close()
  }
}

export async function listGraphNodes(
  limit = 100,
  label?: string
): Promise<Array<{ label: string; value: string }>> {
  const session = getDriver().session()
  try {
    const safeLimit = Math.min(Math.max(limit, 1), 200)
    if (label) {
      const sanitized = sanitizeLabel(label)
      const result = await session.run(
        `MATCH (n:${sanitized}) RETURN labels(n)[0] AS label, n.value AS value ORDER BY value LIMIT toInteger($limit)`,
        { limit: safeLimit }
      )
      return result.records.map((record) => ({
        label: record.get('label') as string,
        value: record.get('value') as string,
      }))
    }

    const result = await session.run(
      'MATCH (n) RETURN labels(n)[0] AS label, n.value AS value ORDER BY label, value LIMIT toInteger($limit)',
      { limit: safeLimit }
    )
    return result.records.map((record) => ({
      label: record.get('label') as string,
      value: record.get('value') as string,
    }))
  } finally {
    await session.close()
  }
}

export async function pruneMisclassifiedFullNameUsernames(): Promise<{
  usernamesRemoved: number
  profilesRemoved: number
  orphanPlatformsRemoved: number
}> {
  const session = getDriver().session()
  try {
    const result = await session.run(`
      MATCH (u:Username)
      WHERE u.value CONTAINS ' '
        AND EXISTS { MATCH (:Person {value: u.value}) }
      OPTIONAL MATCH (u)-[:HAS_PROFILE]->(profile:Profile)
      WITH collect(DISTINCT u) AS usernames, collect(DISTINCT profile) AS profiles
      CALL {
        WITH profiles
        UNWIND profiles AS profile
        WITH profile WHERE profile IS NOT NULL
        DETACH DELETE profile
        RETURN count(profile) AS profilesRemoved
      }
      CALL {
        WITH usernames
        UNWIND usernames AS username
        WITH username WHERE username IS NOT NULL
        DETACH DELETE username
        RETURN count(username) AS usernamesRemoved
      }
      CALL {
        MATCH (platform:Platform)
        WHERE NOT EXISTS { MATCH (:Profile)-[:ON_PLATFORM]->(platform) }
        DETACH DELETE platform
        RETURN count(platform) AS orphanPlatformsRemoved
      }
      RETURN usernamesRemoved, profilesRemoved, orphanPlatformsRemoved
    `)

    return {
      usernamesRemoved: (result.records[0]?.get('usernamesRemoved') as any)?.toNumber?.() ?? 0,
      profilesRemoved: (result.records[0]?.get('profilesRemoved') as any)?.toNumber?.() ?? 0,
      orphanPlatformsRemoved: (result.records[0]?.get('orphanPlatformsRemoved') as any)?.toNumber?.() ?? 0,
    }
  } finally {
    await session.close()
  }
}

/** Bir username'e bağlı tüm doğrulanmış tanımlayıcıları getir (çapraz doğrulama için) */
export async function findLinkedIdentifiers(username: string): Promise<{
  emails: string[]
  realNames: string[]
  handles: string[]
  websites: string[]
  avatarUrl?: string
}> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      `MATCH (u:Username {value: $username})
       OPTIONAL MATCH (u)-[:USES_EMAIL]->(e:Email)
       OPTIONAL MATCH (u)-[:REAL_NAME]->(p:Person)
       OPTIONAL MATCH (u)-[:TWITTER_ACCOUNT]->(t:Username)
       OPTIONAL MATCH (u)-[:OWNS_WEBSITE]->(w:Website)
       RETURN u.avatarUrl AS avatarUrl,
              collect(DISTINCT e.value) AS emails,
              collect(DISTINCT p.value) AS realNames,
              collect(DISTINCT t.value) AS handles,
              collect(DISTINCT w.value) AS websites`,
      { username }
    )
    const record = result.records[0]
    return {
      emails: (record?.get('emails') ?? []).filter(Boolean) as string[],
      realNames: (record?.get('realNames') ?? []).filter(Boolean) as string[],
      handles: (record?.get('handles') ?? []).filter(Boolean) as string[],
      websites: (record?.get('websites') ?? []).filter(Boolean) as string[],
      avatarUrl: record?.get('avatarUrl') as string | undefined,
    }
  } finally {
    await session.close()
  }
}

/** Label injection önleme — sadece alfanumerik */
function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '')
}

/** OSINT sonuçlarını grafa toplu yaz — kaynak ve güven seviyesi ile */
export async function writeOsintToGraph(
  seedUsername: string,
  data: {
    emails?: string[]
    platforms?: Array<{ platform: string; url: string }>
    realName?: string
    location?: string
    company?: string
    twitter?: string
    blog?: string
    avatarUrl?: string
  },
  source: string = 'unknown'
): Promise<{ nodesCreated: number; relsCreated: number }> {
  const beforeStats = await getGraphStats()

  // Confidence: kaynak-bazlı otomatik atama
  const confidence = sourceToConfidence(source)
  const meta = { source, confidence }

  // Seed node
  const usernameProps: Record<string, string> = { value: seedUsername }
  if (data.avatarUrl) {
    usernameProps.avatarUrl = data.avatarUrl
  }
  await mergeNode('Username', usernameProps)

  // Emails
  for (const email of data.emails || []) {
    await mergeNode('Email', { value: email })
    await mergeRelation('Username', seedUsername, 'Email', email, 'USES_EMAIL', meta)
  }

  // Platforms
  for (const p of data.platforms || []) {
    await mergeNode('Platform', { value: p.platform })
    await mergeNode('Profile', { value: p.url, platform: p.platform })
    await mergeRelation('Username', seedUsername, 'Profile', p.url, 'HAS_PROFILE', meta)
    await mergeRelation('Profile', p.url, 'Platform', p.platform, 'ON_PLATFORM', meta)
  }

  // Real name
  if (data.realName) {
    await mergeNode('Person', { value: data.realName })
    await mergeRelation('Username', seedUsername, 'Person', data.realName, 'REAL_NAME', meta)
  }

  // Location
  if (data.location) {
    await mergeNode('Location', { value: data.location })
    await mergeRelation('Username', seedUsername, 'Location', data.location, 'LOCATED_IN', meta)
  }

  // Company
  if (data.company) {
    await mergeNode('Organization', { value: data.company })
    await mergeRelation('Username', seedUsername, 'Organization', data.company, 'WORKS_AT', meta)
  }

  // Twitter
  if (data.twitter) {
    await mergeNode('Username', { value: data.twitter })
    await mergeRelation('Username', seedUsername, 'Username', data.twitter, 'TWITTER_ACCOUNT', meta)
  }

  // Blog
  if (data.blog) {
    await mergeNode('Website', { value: data.blog })
    await mergeRelation('Username', seedUsername, 'Website', data.blog, 'OWNS_WEBSITE', meta)
  }

  const afterStats = await getGraphStats()
  return {
    nodesCreated: Math.max(afterStats.nodes - beforeStats.nodes, 0),
    relsCreated: Math.max(afterStats.relationships - beforeStats.relationships, 0),
  }
}

/** Kaynak adından otomatik güven seviyesi çıkar */
function sourceToConfidence(source: string): ConfidenceLevel {
  if (source === 'github_api' || source === 'gpg_key') return 'verified'
  if (source === 'commit_email') return 'high'
  if (source === 'holehe' || source === 'hibp') return 'high'
  if (source === 'sherlock') return 'medium' // Sherlock sadece HTTP 200 kontrol eder, kimlik doğrulamaz
  if (source === 'wayback' || source === 'metadata') return 'medium'
  return 'low'
}

/**
 * Email'in kayıtlı olduğu platformları grafa yaz.
 * Holehe sonuçlarıyla Email → REGISTERED_ON → Platform ilişkisi kurar.
 */
export async function writeEmailRegistrations(
  email: string,
  services: Array<{ name: string; emailrecovery?: string | null; phoneNumber?: string | null }>,
  source: string = 'holehe'
): Promise<{ nodesCreated: number; relsCreated: number }> {
  const beforeStats = await getGraphStats()
  const confidence = sourceToConfidence(source)
  const meta = { source, confidence }

  await mergeNode('Email', { value: email })

  for (const s of services) {
    await mergeNode('Platform', { value: s.name })
    await mergeRelation('Email', email, 'Platform', s.name, 'REGISTERED_ON', meta)

    // Recovery email veya telefon varsa ekstra node oluştur
    if (s.emailrecovery && s.emailrecovery !== 'null') {
      await mergeNode('Email', { value: s.emailrecovery })
      await mergeRelation('Email', email, 'Email', s.emailrecovery, 'RECOVERY_EMAIL', meta)
    }
    if (s.phoneNumber && s.phoneNumber !== 'null') {
      await mergeNode('Phone', { value: s.phoneNumber })
      await mergeRelation('Email', email, 'Phone', s.phoneNumber, 'LINKED_PHONE', meta)
    }
  }

  const afterStats = await getGraphStats()
  return {
    nodesCreated: Math.max(afterStats.nodes - beforeStats.nodes, 0),
    relsCreated: Math.max(afterStats.relationships - beforeStats.relationships, 0),
  }
}

/**
 * Email'in bulunduğu veri sızıntılarını grafa yaz.
 * Email → LEAKED_IN → Breach ilişkisi kurar.
 */
export async function writeBreachData(
  email: string,
  breaches: Array<{ name: string; domain: string; breachDate: string; dataClasses: string[] }>,
  source: string = 'hibp'
): Promise<{ nodesCreated: number; relsCreated: number }> {
  const beforeStats = await getGraphStats()
  const confidence = sourceToConfidence(source)
  const meta = { source, confidence }

  await mergeNode('Email', { value: email })

  for (const b of breaches) {
    await mergeNode('Breach', { value: b.name, domain: b.domain, breachDate: b.breachDate })
    await mergeRelation('Email', email, 'Breach', b.name, 'LEAKED_IN', meta)

    // Sızıntıdaki veri türlerini property olarak ekle
    const session = getDriver().session()
    try {
      await session.run(
        `MATCH (b:Breach {value: $name})
         SET b.dataClasses = $dataClasses, b.domain = $domain, b.breachDate = $breachDate`,
        { name: b.name, dataClasses: b.dataClasses.join(', '), domain: b.domain, breachDate: b.breachDate }
      )
    } finally {
      await session.close()
    }
  }

  const afterStats = await getGraphStats()
  return {
    nodesCreated: Math.max(afterStats.nodes - beforeStats.nodes, 0),
    relsCreated: Math.max(afterStats.relationships - beforeStats.relationships, 0),
  }
}

/**
 * GitHub following bağlantılarını grafa yazar.
 * Username→FOLLOWS→Username ve bio bilgilerini (konum, bio, blog) node property'si olarak saklar.
 * Düşük follower'lı (gerçek kişi olası) hesaplar OSINT_TARGET olarak işaretlenir.
 */
export async function writeFollowingConnections(
  username: string,
  following: Array<{ username: string; name: string | null; bio: string | null; blog: string | null; location: string | null; followers: number; skipped: boolean }>,
  source: string = 'github_api'
): Promise<{ nodesCreated: number; relsCreated: number }> {
  const beforeStats = await getGraphStats()
  const meta = { source, confidence: sourceToConfidence(source) }

  for (const f of following) {
    const props: Record<string, string> = { value: f.username }
    if (f.name) props.realName = f.name
    if (f.bio) props.bio = f.bio
    if (f.location) props.location = f.location
    if (f.blog) props.blog = f.blog
    props.followerCount = String(f.followers)
    props.osintPriority = f.skipped ? 'low' : 'high'

    await mergeNode('Username', props)
    await mergeRelation('Username', username, 'Username', f.username, 'FOLLOWS', meta)

    // Blog link varsa Website node'u olarak bağla
    if (f.blog && (f.blog.startsWith('http://') || f.blog.startsWith('https://'))) {
      await mergeNode('Website', { value: f.blog })
      await mergeRelation('Username', f.username, 'Website', f.blog, 'OWNS_WEBSITE', meta)
    }
  }

  const afterStats = await getGraphStats()
  return {
    nodesCreated: Math.max(afterStats.nodes - beforeStats.nodes, 0),
    relsCreated: Math.max(afterStats.relationships - beforeStats.relationships, 0),
  }
}

/**
 * Firecrawl scrape sonuçlarını grafa yazar.
 * Profile→SCRAPE_FOUND→Email/CryptoWallet/Username ilişkileri oluşturur.
 */
export async function writeScrapeData(
  profileUrl: string,
  data: {
    emails: string[]
    cryptoWallets: string[]
    usernameHints: string[]
  },
  source: string = 'firecrawl'
): Promise<{ nodesCreated: number; relsCreated: number }> {
  const beforeStats = await getGraphStats()
  const meta = { source, confidence: sourceToConfidence(source) }

  await mergeNode('Website', { value: profileUrl })

  for (const email of data.emails) {
    await mergeNode('Email', { value: email })
    await mergeRelation('Website', profileUrl, 'Email', email, 'SCRAPE_FOUND', meta)
  }
  for (const wallet of data.cryptoWallets) {
    await mergeNode('CryptoWallet', { value: wallet })
    await mergeRelation('Website', profileUrl, 'CryptoWallet', wallet, 'SCRAPE_FOUND', meta)
  }
  for (const hint of data.usernameHints) {
    await mergeNode('Username', { value: hint })
    await mergeRelation('Website', profileUrl, 'Username', hint, 'SCRAPE_FOUND', meta)
  }

  const afterStats = await getGraphStats()
  return {
    nodesCreated: Math.max(afterStats.nodes - beforeStats.nodes, 0),
    relsCreated: Math.max(afterStats.relationships - beforeStats.relationships, 0),
  }
}

/**
 * SAME_AS ilişkisi kur — iki farklı platformdaki hesabın aynı kişiye ait olduğuna dair kanıt.
 * Pivot noktası: email eşleşmesi, SSH key eşleşmesi vb.
 */
export async function mergeSameAsRelation(
  fromLabel: string,
  fromValue: string,
  toLabel: string,
  toValue: string,
  evidence: string,
  source: string
): Promise<void> {
  const confidence = sourceToConfidence(source)
  const session = getDriver().session()
  try {
    await session.run(
      `MERGE (a:${sanitizeLabel(fromLabel)} {value: $fromVal})
       MERGE (b:${sanitizeLabel(toLabel)} {value: $toVal})
       MERGE (a)-[r:SAME_AS]->(b)
       SET r.evidence = $evidence, r.source = $source, r.confidence = $confidence, r.updatedAt = datetime()`,
      { fromVal: fromValue, toVal: toValue, evidence, source, confidence }
    )
  } finally {
    await session.close()
  }
}

/** Tüm graf verisini D3.js uyumlu JSON formatına dışa aktar */
export interface GraphNode {
  id: string
  label: string
  properties: Record<string, string>
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  confidence?: string
  source_tool?: string
}

/** Grafta Person node'larını isimle ters ara — bağlı Username/Email bilgilerini döndür */
export async function findPersonByName(name: string): Promise<Array<{
  personName: string
  linkedUsernames: string[]
  linkedEmails: string[]
  linkedLocations: string[]
  linkedOrganizations: string[]
}>> {
  const session = getDriver().session()
  try {
    const result = await session.run(
      `MATCH (p:Person)
       WHERE toLower(p.value) CONTAINS toLower($name)
       OPTIONAL MATCH (u:Username)-[:REAL_NAME]->(p)
       OPTIONAL MATCH (u)-[:USES_EMAIL]->(e:Email)
       OPTIONAL MATCH (u)-[:LOCATED_IN]->(loc:Location)
       OPTIONAL MATCH (u)-[:WORKS_AT]->(org:Organization)
       RETURN p.value AS personName,
              collect(DISTINCT u.value) AS linkedUsernames,
              collect(DISTINCT e.value) AS linkedEmails,
              collect(DISTINCT loc.value) AS linkedLocations,
              collect(DISTINCT org.value) AS linkedOrganizations`,
      { name }
    )
    return result.records.map(r => ({
      personName: r.get('personName') as string,
      linkedUsernames: (r.get('linkedUsernames') ?? []).filter(Boolean) as string[],
      linkedEmails: (r.get('linkedEmails') ?? []).filter(Boolean) as string[],
      linkedLocations: (r.get('linkedLocations') ?? []).filter(Boolean) as string[],
      linkedOrganizations: (r.get('linkedOrganizations') ?? []).filter(Boolean) as string[],
    }))
  } finally {
    await session.close()
  }
}

export async function exportGraphForVisualization(): Promise<{
  nodes: GraphNode[]
  edges: GraphEdge[]
}> {
  const session = getDriver().session()
  try {
    // Tüm node'ları çek
    const nodesResult = await session.run(
      `MATCH (n) RETURN labels(n)[0] AS label, properties(n) AS props, elementId(n) AS eid`
    )
    const nodeMap = new Map<string, GraphNode>()
    for (const record of nodesResult.records) {
      const props = record.get('props') as Record<string, unknown>
      const value = String(props.value ?? '')
      const label = record.get('label') as string
      const id = value || record.get('eid') as string
      const cleanProps: Record<string, string> = {}
      for (const [k, v] of Object.entries(props)) {
        if (v != null) cleanProps[k] = String(v)
      }
      nodeMap.set(id, { id, label, properties: cleanProps })
    }

    // Tüm edge'leri çek
    const edgesResult = await session.run(
      `MATCH (a)-[r]->(b)
       RETURN a.value AS fromVal, b.value AS toVal, type(r) AS relType,
              r.confidence AS confidence, r.source AS sourceTool`
    )
    const edges: GraphEdge[] = edgesResult.records.map((r) => ({
      source: String(r.get('fromVal') ?? ''),
      target: String(r.get('toVal') ?? ''),
      type: r.get('relType') as string,
      confidence: (r.get('confidence') as string) ?? undefined,
      source_tool: (r.get('sourceTool') as string) ?? undefined,
    }))

    return { nodes: Array.from(nodeMap.values()), edges }
  } finally {
    await session.close()
  }
}

export async function deleteGraphNodeAndRelations(label: string, value: string): Promise<boolean> {
  const session = getDriver().session()
  const safeLabel = sanitizeLabel(label)

  try {
    const result = await session.run(
      `MATCH (n:${safeLabel} {value: $value}) DETACH DELETE n RETURN count(n) as deleted`,
      { value }
    )
    
    // Check if any node was deleted (count > 0)
    const deletedCount = result.records[0]?.get('deleted')?.toNumber() || 0
    return deletedCount > 0
  } catch (error: any) {
    console.error(`[Neo4j] Düğüm silme hatası (${label}:${value}):`, error.message)
    return false
  } finally {
    await session.close()
  }
}

import 'dotenv/config'
import assert from 'node:assert/strict'
import test from 'node:test'
import neo4j from 'neo4j-driver'
import {
  clearGraph,
  closeNeo4j,
  getConnections,
  getGraphNodeCountsByLabel,
  getGraphStats,
  listGraphNodes,
  mergeNode,
  mergeRelation,
  pruneMisclassifiedFullNameUsernames,
  findLinkedIdentifiers,
  writeOsintToGraph,
  batchWriteFindings,
} from './neo4j.js'

const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(
    process.env.NEO4J_USER || 'neo4j',
    process.env.NEO4J_PASSWORD || 'password'
  )
)

function toNumber(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const maybeInteger = value as { toNumber?: () => number }
    return maybeInteger.toNumber?.() ?? Number(value)
  }
  return Number(value)
}

async function runQuery(query: string, params: Record<string, string> = {}) {
  const session = driver.session()
  try {
    return await session.run(query, params)
  } finally {
    await session.close()
  }
}

test.beforeEach(async () => {
  await clearGraph()
  assert.deepEqual(await getGraphStats(), { nodes: 0, relationships: 0 })
})

test.after(async () => {
  await clearGraph()
  await closeNeo4j()
  await driver.close()
})

test('mergeNode merges by value and updates latest properties', async () => {
  await mergeNode('Username', { value: 'alice', source: 'github' })
  await mergeNode('Username', { value: 'alice', source: 'x' })

  const result = await runQuery(
    'MATCH (n:Username {value: $value}) RETURN count(n) AS count, n.source AS source',
    { value: 'alice' }
  )

  assert.equal(toNumber(result.records[0]?.get('count')), 1)
  assert.equal(result.records[0]?.get('source'), 'x')
  assert.deepEqual(await getGraphStats(), { nodes: 1, relationships: 0 })
})

test('clearGraph rejects calls without the explicit allow flag', async () => {
  const previousFlag = process.env.NEO4J_ALLOW_CLEAR
  delete process.env.NEO4J_ALLOW_CLEAR

  try {
    await assert.rejects(() => clearGraph(), /NEO4J_ALLOW_CLEAR=1 gerekli/)
  } finally {
    process.env.NEO4J_ALLOW_CLEAR = previousFlag
  }
})

test('clearGraph rejects non-local Neo4j targets', async () => {
  const previousUri = process.env.NEO4J_URI
  process.env.NEO4J_URI = 'bolt://example.com:7687'

  try {
    await assert.rejects(() => clearGraph(), /yalnızca lokal Neo4j hedeflerinde izinli/)
  } finally {
    process.env.NEO4J_URI = previousUri
  }
})

test('mergeRelation is idempotent for same endpoints and type', async () => {
  await mergeRelation('Username', 'alice', 'Email', 'alice@example.com', 'USES_EMAIL')
  await mergeRelation('Username', 'alice', 'Email', 'alice@example.com', 'USES_EMAIL')

  const rels = await runQuery(
    'MATCH (:Username {value: $username})-[r:USES_EMAIL]->(:Email {value: $email}) RETURN count(r) AS count',
    { username: 'alice', email: 'alice@example.com' }
  )

  assert.equal(toNumber(rels.records[0]?.get('count')), 1)
  assert.deepEqual(await getGraphStats(), { nodes: 2, relationships: 1 })
})

test('getConnections returns both incoming and outgoing edges', async () => {
  await mergeRelation('Username', 'seed-user', 'Email', 'seed@example.com', 'USES_EMAIL')
  await mergeRelation('Organization', 'ACME', 'Username', 'seed-user', 'EMPLOYS')

  const connections = await getConnections('seed-user')
  const summary = connections
    .map((connection) => `${connection.from}|${connection.relation}|${connection.to}|${connection.toLabel}`)
    .sort()

  assert.deepEqual(summary, [
    'ACME|EMPLOYS|seed-user|Username',
    'seed-user|USES_EMAIL|seed@example.com|Email',
  ])
})

test('graph overview helpers return labels and node values', async () => {
  await mergeNode('Username', { value: 'alice' })
  await mergeNode('Email', { value: 'alice@example.com' })
  await mergeNode('Person', { value: 'Alice Example' })

  assert.deepEqual(await getGraphNodeCountsByLabel(), [
    { label: 'Email', count: 1 },
    { label: 'Person', count: 1 },
    { label: 'Username', count: 1 },
  ])

  assert.deepEqual(await listGraphNodes(10, 'Username'), [
    { label: 'Username', value: 'alice' },
  ])
})

test('pruneMisclassifiedFullNameUsernames removes full-name username noise but keeps Person data', async () => {
  await mergeNode('Person', { value: 'Alice Example' })
  await mergeNode('Username', { value: 'Alice Example' })
  await mergeNode('Profile', { value: 'https://example.com/alice', platform: 'ExampleNet' })
  await mergeNode('Platform', { value: 'ExampleNet' })
  await mergeRelation('Username', 'Alice Example', 'Profile', 'https://example.com/alice', 'HAS_PROFILE')
  await mergeRelation('Profile', 'https://example.com/alice', 'Platform', 'ExampleNet', 'ON_PLATFORM')

  const result = await pruneMisclassifiedFullNameUsernames()

  assert.deepEqual(result, {
    usernamesRemoved: 1,
    profilesRemoved: 1,
    orphanPlatformsRemoved: 1,
  })

  assert.deepEqual(await getGraphNodeCountsByLabel(), [
    { label: 'Person', count: 1 },
  ])
})

test('writeOsintToGraph creates the expected graph for a full subject', async () => {
  const writeStats = await writeOsintToGraph('graph_subject', {
    emails: ['graph_subject@example.com'],
    platforms: [{ platform: 'GitHub', url: 'https://github.com/graph_subject' }],
    realName: 'Graph Subject',
    location: 'Ankara',
    company: 'Graph Labs',
    twitter: 'graph_subject_x',
    blog: 'https://graph.example',
  })

  assert.deepEqual(writeStats, { nodesCreated: 9, relsCreated: 8 })
  assert.deepEqual(await getGraphStats(), { nodes: 9, relationships: 8 })

  const connections = await getConnections('graph_subject')
  const relationTypes = new Set(connections.map((connection) => connection.relation))

  assert.deepEqual(
    Array.from(relationTypes).sort(),
    ['HAS_PROFILE', 'HAS_PROFILE_ON', 'LOCATED_IN', 'OWNS_WEBSITE', 'REAL_NAME', 'TWITTER_ACCOUNT', 'USES_EMAIL', 'WORKS_AT']
  )

  const profileLinks = await runQuery(
    'MATCH (:Username {value: $username})-[:HAS_PROFILE]->(profile:Profile)-[:ON_PLATFORM]->(platform:Platform) RETURN profile.value AS profileUrl, platform.value AS platformName',
    { username: 'graph_subject' }
  )

  assert.deepEqual(
    profileLinks.records.map((record) => ({
      profileUrl: record.get('profileUrl') as string,
      platformName: record.get('platformName') as string,
    })),
    [{ profileUrl: 'https://github.com/graph_subject', platformName: 'GitHub' }]
  )
})

test('writeOsintToGraph keeps distinct profile URLs for different users on the same platform', async () => {
  await writeOsintToGraph('alice', {
    platforms: [{ platform: 'GitHub', url: 'https://github.com/alice' }],
  })
  await writeOsintToGraph('bob', {
    platforms: [{ platform: 'GitHub', url: 'https://github.com/bob' }],
  })

  assert.deepEqual(await getGraphStats(), { nodes: 5, relationships: 4 })

  const result = await runQuery(
    'MATCH (profile:Profile)-[:ON_PLATFORM]->(:Platform {value: $platform}) RETURN profile.value AS profileUrl ORDER BY profile.value',
    { platform: 'GitHub' }
  )

  assert.deepEqual(
    result.records.map((record) => record.get('profileUrl') as string),
    ['https://github.com/alice', 'https://github.com/bob']
  )
})

test('repeated writeOsintToGraph with same payload does not grow the graph', async () => {
  const payload = {
    emails: ['stable@example.com'],
    platforms: [{ platform: 'GitHub', url: 'https://github.com/stable-user' }],
    realName: 'Stable User',
    location: 'Istanbul',
    company: 'Stable Corp',
    twitter: 'stable_user_x',
    blog: 'https://stable.example',
  }

  const firstWrite = await writeOsintToGraph('stable-user', payload)
  const firstStats = await getGraphStats()

  const secondWrite = await writeOsintToGraph('stable-user', payload)
  const secondStats = await getGraphStats()

  assert.deepEqual(firstWrite, { nodesCreated: 9, relsCreated: 8 })
  assert.deepEqual(secondWrite, { nodesCreated: 0, relsCreated: 0 })
  assert.deepEqual(firstStats, { nodes: 9, relationships: 8 })
  assert.deepEqual(secondStats, firstStats)
})

test('mergeRelation stores source and confidence metadata', async () => {
  await mergeRelation('Username', 'alice', 'Email', 'alice@example.com', 'USES_EMAIL', {
    source: 'github_api',
    confidence: 'verified',
  })

  const result = await runQuery(
    'MATCH (:Username {value: $u})-[r:USES_EMAIL]->(:Email {value: $e}) RETURN r.source AS source, r.confidence AS confidence',
    { u: 'alice', e: 'alice@example.com' }
  )

  assert.equal(result.records[0]?.get('source'), 'github_api')
  assert.equal(result.records[0]?.get('confidence'), 'verified')
})

test('getConnections returns source and confidence', async () => {
  await mergeRelation('Username', 'bob', 'Email', 'bob@test.com', 'USES_EMAIL', {
    source: 'sherlock',
    confidence: 'high',
  })

  const connections = await getConnections('bob')
  const emailConn = connections.find(c => c.relation === 'USES_EMAIL')
  assert.equal(emailConn?.source, 'sherlock')
  assert.equal(emailConn?.confidence, 'high')
})

test('writeOsintToGraph tags relationships with source and correct confidence', async () => {
  await writeOsintToGraph('tagged-user', {
    emails: ['tagged@example.com'],
    realName: 'Tagged User',
  }, 'github_api')

  const emailRel = await runQuery(
    'MATCH (:Username {value: $u})-[r:USES_EMAIL]->(:Email) RETURN r.source AS source, r.confidence AS confidence',
    { u: 'tagged-user' }
  )
  assert.equal(emailRel.records[0]?.get('source'), 'github_api')
  assert.equal(emailRel.records[0]?.get('confidence'), 'verified')

  const nameRel = await runQuery(
    'MATCH (:Username {value: $u})-[r:REAL_NAME]->(:Person) RETURN r.source AS source, r.confidence AS confidence',
    { u: 'tagged-user' }
  )
  assert.equal(nameRel.records[0]?.get('source'), 'github_api')
  assert.equal(nameRel.records[0]?.get('confidence'), 'verified')
})

test('findLinkedIdentifiers returns all verified links for a username', async () => {
  await writeOsintToGraph('linked-user', {
    emails: ['linked@example.com'],
    realName: 'Linked User',
    twitter: 'linked_twitter',
    blog: 'https://linked.example',
  }, 'github_api')

  const ids = await findLinkedIdentifiers('linked-user')
  assert.deepEqual(ids.emails, ['linked@example.com'])
  assert.deepEqual(ids.realNames, ['Linked User'])
  assert.deepEqual(ids.handles, ['linked_twitter'])
  assert.deepEqual(ids.websites, ['https://linked.example'])
})

test('findLinkedIdentifiers returns empty arrays for unknown username', async () => {
  const ids = await findLinkedIdentifiers('nonexistent')
  assert.deepEqual(ids, { emails: [], realNames: [], handles: [], websites: [] })
})

test('batchWriteFindings creates multiple nodes and relations in a single call', async () => {
  const stats = await batchWriteFindings([
    { subjectLabel: 'Username', subjectValue: 'batchuser', targetLabel: 'Email', targetValue: 'batch@test.com', relation: 'USES_EMAIL', confidence: 'verified' },
    { subjectLabel: 'Username', subjectValue: 'batchuser', targetLabel: 'Person', targetValue: 'Batch User', relation: 'REAL_NAME', confidence: 'high' },
    { subjectLabel: 'Person', subjectValue: 'Batch User', targetLabel: 'Organization', targetValue: 'BatchCorp', relation: 'WORKS_AT', confidence: 'medium' },
  ])

  assert.equal(stats.errors.length, 0)
  assert.equal(stats.nodesCreated, 4) // batchuser, email, person, org
  assert.equal(stats.relsCreated, 3)

  const graphStats = await getGraphStats()
  assert.deepEqual(graphStats, { nodes: 4, relationships: 3 })

  // Verify relations
  const connections = await getConnections('batchuser')
  assert.equal(connections.length, 2)
  const relationTypes = connections.map(c => c.relation).sort()
  assert.deepEqual(relationTypes, ['REAL_NAME', 'USES_EMAIL'])
})

test('batchWriteFindings is idempotent — same findings do not grow graph', async () => {
  const findings = [
    { subjectLabel: 'Username', subjectValue: 'idemuser', targetLabel: 'Email', targetValue: 'idem@test.com', relation: 'USES_EMAIL' },
  ]

  const first = await batchWriteFindings(findings)
  const second = await batchWriteFindings(findings)

  assert.equal(first.nodesCreated, 2)
  assert.equal(first.relsCreated, 1)
  assert.equal(second.nodesCreated, 0)
  assert.equal(second.relsCreated, 0)

  assert.deepEqual(await getGraphStats(), { nodes: 2, relationships: 1 })
})

test('batchWriteFindings returns empty result for empty array', async () => {
  const stats = await batchWriteFindings([])
  assert.deepEqual(stats, { nodesCreated: 0, relsCreated: 0, errors: [] })
})

test('batchWriteFindings rejects arrays over 30 items', async () => {
  const findings = Array.from({ length: 31 }, (_, i) => ({
    subjectLabel: 'Username', subjectValue: `user${i}`, targetLabel: 'Email', targetValue: `u${i}@test.com`, relation: 'USES_EMAIL',
  }))
  const stats = await batchWriteFindings(findings)
  assert.equal(stats.nodesCreated, 0)
  assert.equal(stats.relsCreated, 0)
  assert.ok(stats.errors.length > 0)
  assert.ok(stats.errors[0].includes('30'))
})

test('batchWriteFindings stores confidence and evidence metadata', async () => {
  await batchWriteFindings([
    { subjectLabel: 'Username', subjectValue: 'metauser', targetLabel: 'Email', targetValue: 'meta@test.com', relation: 'USES_EMAIL', confidence: 'verified', evidence: 'GitHub API' },
  ])

  const result = await runQuery(
    'MATCH (:Username {value: $u})-[r:USES_EMAIL]->(:Email {value: $e}) RETURN r.confidence AS conf, r.evidence AS ev, r.source AS src',
    { u: 'metauser', e: 'meta@test.com' }
  )
  assert.equal(result.records[0]?.get('conf'), 'verified')
  assert.equal(result.records[0]?.get('ev'), 'GitHub API')
  assert.equal(result.records[0]?.get('src'), 'supervisor_llm')
})
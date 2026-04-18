/**
 * Test Graph Seed Script
 *
 * Populates Neo4j with known, verified data.
 * Run before each test: npm run test:seed
 *
 * Targets: Real people, publicly available information, verifiable data.
 */
import 'dotenv/config'
import { clearGraph, writeOsintToGraph, getGraphStats, closeNeo4j } from '../lib/neo4j.js'

const ALLOW_CLEAR = process.env.NEO4J_ALLOW_CLEAR === '1'

async function main() {
  if (!ALLOW_CLEAR) {
    console.error('NEO4J_ALLOW_CLEAR=1 is required to seed (the graph needs to be cleared).')
    process.exit(1)
  }

  console.log('🧹 Clearing graph...')
  await clearGraph()

  // ── Seed 1: torvalds ──────────────────────────────────────────
  // Source: GitHub API (verified, publicly available)
  // https://api.github.com/users/torvalds
  console.log('\n📌 Seed: torvalds (Linus Torvalds)')
  await writeOsintToGraph('torvalds', {
    realName: 'Linus Torvalds',
    location: 'Portland, OR',
    company: 'Linux Foundation',
    blog: 'https://linuxfoundation.org',
  }, 'github_api')

  // Known email from commits (public before GitHub noreply system)
  await writeOsintToGraph('torvalds', {
    emails: ['torvalds@linux-foundation.org'],
  }, 'commit_email')

  console.log('   ✅ torvalds seeded')

  // ── Seed 2: jessfraz ──────────────────────────────────────────
  // Source: GitHub API — has GPG key, email public
  // https://api.github.com/users/jessfraz
  console.log('\n📌 Seed: jessfraz (Jessie Frazelle)')
  await writeOsintToGraph('jessfraz', {
    realName: 'Jess Frazelle',
    company: 'Oxide Computer Company',
    blog: 'https://blog.jessfraz.com',
    platforms: [
      { platform: 'GitHub', url: 'https://github.com/jessfraz' },
      { platform: 'Twitter', url: 'https://twitter.com/jessfraz' },
    ],
  }, 'github_api')

  await writeOsintToGraph('jessfraz', {
    emails: ['jess@oxide.computer'],
  }, 'gpg_key')

  console.log('   ✅ jessfraz seeded')

  // ── Seed 3: octocat ───────────────────────────────────────────
  // GitHub mascot — fictional but ideal for testing (no real PII)
  console.log('\n📌 Seed: octocat (GitHub Mascot)')
  await writeOsintToGraph('octocat', {
    realName: 'The Octocat',
    company: 'GitHub',
    location: 'San Francisco, CA',
    blog: 'https://github.blog',
    platforms: [
      { platform: 'GitHub', url: 'https://github.com/octocat' },
    ],
  }, 'github_api')

  console.log('   ✅ octocat seeded')

  // ── Summary ───────────────────────────────────────────────────
  const stats = await getGraphStats()
  console.log(`\n✅ Seed complete: ${stats.nodes} nodes, ${stats.relationships} relationships`)
  console.log('\nTest scenarios:')
  console.log('  1. "Research torvalds" → GitHub commits, real name verification')
  console.log('  2. "Who is jessfraz, find email" → GPG key parse, trust chain')
  console.log('  3. "Search Linus Torvalds on social media" → name→handle pivot, cross_reference')
  console.log('  4. "Query graph for connections with query_graph" → view trust levels')

  await closeNeo4j()
}

main().catch((e) => {
  console.error('Seed error:', e)
  process.exit(1)
})

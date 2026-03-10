/**
 * Test Graf Seed Scripti
 *
 * Neo4j'yi bilinen, doğrulanmış verilerle doldurur.
 * Her test öncesi çalıştırılmalı: npm run test:seed
 *
 * Hedefler: Gerçek kişiler, herkese açık bilgiler, doğrulanabilir veri.
 */
import 'dotenv/config'
import { clearGraph, writeOsintToGraph, getGraphStats, closeNeo4j } from '../lib/neo4j.js'

const ALLOW_CLEAR = process.env.NEO4J_ALLOW_CLEAR === '1'

async function main() {
  if (!ALLOW_CLEAR) {
    console.error('NEO4J_ALLOW_CLEAR=1 olmadan seed çalışmaz (grafı temizlemek gerekiyor).')
    process.exit(1)
  }

  console.log('🧹 Graf temizleniyor...')
  await clearGraph()

  // ── Seed 1: torvalds ──────────────────────────────────────────
  // Kaynak: GitHub API (doğrulanmış, herkese açık)
  // https://api.github.com/users/torvalds
  console.log('\n📌 Seed: torvalds (Linus Torvalds)')
  await writeOsintToGraph('torvalds', {
    realName: 'Linus Torvalds',
    location: 'Portland, OR',
    company: 'Linux Foundation',
    blog: 'https://linuxfoundation.org',
  }, 'github_api')

  // Commit'lerden bilinen email (GitHub noreply sistemi öncesi açık olan)
  await writeOsintToGraph('torvalds', {
    emails: ['torvalds@linux-foundation.org'],
  }, 'commit_email')

  console.log('   ✅ torvalds seed\'lendi')

  // ── Seed 2: jessfraz ──────────────────────────────────────────
  // Kaynak: GitHub API — GPG key var, email açık
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

  console.log('   ✅ jessfraz seed\'lendi')

  // ── Seed 3: octocat ───────────────────────────────────────────
  // GitHub maskotu — sahte ama test için ideal (hiç gerçek PII yok)
  console.log('\n📌 Seed: octocat (GitHub Maskot)')
  await writeOsintToGraph('octocat', {
    realName: 'The Octocat',
    company: 'GitHub',
    location: 'San Francisco, CA',
    blog: 'https://github.blog',
    platforms: [
      { platform: 'GitHub', url: 'https://github.com/octocat' },
    ],
  }, 'github_api')

  console.log('   ✅ octocat seed\'lendi')

  // ── Özet ──────────────────────────────────────────────────────
  const stats = await getGraphStats()
  console.log(`\n✅ Seed tamamlandı: ${stats.nodes} node, ${stats.relationships} ilişki`)
  console.log('\nTest senaryoları:')
  console.log('  1. "torvalds hakkında araştır" → GitHub commits, gerçek isim doğrulama')
  console.log('  2. "jessfraz kimdir, email bul" → GPG key parse, güven zinciri')
  console.log('  3. "Linus Torvalds sosyal medyada ara" → isim→handle pivot, cross_reference')
  console.log('  4. query_graph ile bağlantıları sorgula → güven seviyeleri görüntüleme')

  await closeNeo4j()
}

main().catch((e) => {
  console.error('Seed hatası:', e)
  process.exit(1)
})

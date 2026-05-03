/**
 * performanceTest.ts — Gerçek Performans Ölçüm Suitesi
 *
 * Bunu değerli yapan şey:
 *   D  API & Servis Sağlığı   — Hangi API/servisler gerçekten çalışıyor? Latency ölçümü
 *   E  Scraper Fallback Zinciri— SearXNG→Brave→Google→Tavily hangi katmanda cevap veriyor?
 *   F  Araç Hata Toleransı    — Bozuk token, ENOENT vs. uygulama crash olmamalı
 *   G  Graph Kalıcılık Döngüsü— Yaz → Oku → Doğrula (Neo4j entegrasyon loop)
 *   H  Ajan Yönlendirme Matrisi— 5 farklı sorgu tipi doğru ajana gidiyor mu?
 *
 * Çalıştırma:
 *   npx tsx src/agents/performanceTest.ts            # D+E+F+G+H (tümü)
 *   npx tsx src/agents/performanceTest.ts --no-graph # Neo4j olmadan (D+E+F+H)
 *   npx tsx src/agents/performanceTest.ts --no-llm   # Sadece D+E+F+G (ajan yok)
 *
 * Başarı kriterleri:
 *   - Hiçbir test crash (unhandled exception) üretmemeli
 *   - Her fallback kademesi test edilmeli
 *   - Ajan yönlendirme: 5/5 doğru olmalı
 *   - Graph write→read roundtrip: integrity bozulmamalı
 */

import 'dotenv/config'
import { executeTool } from '../lib/toolRegistry.js'
import { runSupervisor } from './supervisorAgent.js'
import type { Message } from './types.js'

// ── Sonuç Tipi ─────────────────────────────────────────────────────────

interface PerfResult {
  group: 'D' | 'E' | 'F' | 'G' | 'H'
  name: string
  passed: boolean
  durationMs: number
  notes: string[]
  error?: string
  metrics?: Record<string, number | string | boolean>
}

const results: PerfResult[] = []

function pass(
  group: PerfResult['group'],
  name: string,
  durationMs: number,
  notes: string[],
  metrics?: PerfResult['metrics']
): void {
  results.push({ group, name, passed: true, durationMs, notes, metrics })
  console.log(`  ✅ PASS  [${group}] ${name}  (${(durationMs / 1000).toFixed(2)}s)`)
  for (const n of notes) console.log(`        ${n}`)
}

function fail(
  group: PerfResult['group'],
  name: string,
  durationMs: number,
  error: string,
  notes: string[] = [],
  metrics?: PerfResult['metrics']
): void {
  results.push({ group, name, passed: false, durationMs, notes, error, metrics })
  console.log(`  ❌ FAIL  [${group}] ${name}  (${(durationMs / 1000).toFixed(2)}s)`)
  console.log(`        ${error}`)
  for (const n of notes) console.log(`        ${n}`)
}

function info(msg: string): void {
  console.log(`  ℹ  ${msg}`)
}

// ── Grup D: API & Servis Sağlığı ──────────────────────────────────────

/**
 * D1: Her search provider'ı ayrı ayrı test et, hangisi yanıt veriyor?
 * Sadece search_web çağrısının arkasında hangi provider cevap verdiğini ölçeriz.
 */
async function testD1_searchProviderHealth(): Promise<void> {
  const t = Date.now()
  const queries = [
    { query: 'site:github.com torvalds', label: 'GitHub site: search' },
    { query: 'Linus Torvalds Linux kernel', label: 'General OSINT search' },
    { query: '"octocat" github profile created', label: 'Quoted name search' },
  ]

  const queryResults: Array<{ label: string; ok: boolean; chars: number; durationMs: number; provider: string }> = []

  for (const q of queries) {
    const qt = Date.now()
    try {
      const result = await executeTool('search_web', { query: q.query })
      const str = String(result)
      // Detect which provider answered by checking provider markers in output
      const provider =
        str.includes('[SearXNG]') ? 'SearXNG' :
        str.includes('[Brave]') ? 'Brave' :
        str.includes('[Google]') ? 'Google CSE' :
        str.includes('[Tavily]') ? 'Tavily' : 'unknown'
      queryResults.push({ label: q.label, ok: str.length > 100, chars: str.length, durationMs: Date.now() - qt, provider })
    } catch (e: unknown) {
      queryResults.push({ label: q.label, ok: false, chars: 0, durationMs: Date.now() - qt, provider: 'error' })
      info(`Query "${q.label}" failed: ${(e as Error).message}`)
    }
  }

  const passed = queryResults.filter(r => r.ok).length
  const notes = queryResults.map(r =>
    `${r.ok ? '✓' : '✗'} "${r.label}": ${r.chars} chars via ${r.provider} (${(r.durationMs / 1000).toFixed(2)}s)`
  )
  const avgLatency = queryResults.reduce((s, r) => s + r.durationMs, 0) / queryResults.length

  if (passed === 0) {
    fail('D', 'D1: Search provider health — tüm providerlar çalışmıyor', Date.now() - t, 'Hiçbir search query yanıt vermedi', notes, { avgLatencyMs: avgLatency })
    return
  }

  const successRate = (passed / queries.length) * 100
  if (passed < queries.length) {
    // Partial pass — still useful signal
    pass('D', `D1: Search provider health — ${passed}/${queries.length} query başarılı`, Date.now() - t, [
      ...notes,
      `Success rate: ${successRate.toFixed(0)}%`,
      `Avg latency: ${(avgLatency / 1000).toFixed(2)}s`,
    ], { successRate, avgLatencyMs: avgLatency })
  } else {
    pass('D', `D1: Search provider health — ${passed}/${queries.length} query başarılı`, Date.now() - t, [
      ...notes,
      `Avg latency: ${(avgLatency / 1000).toFixed(2)}s`,
    ], { successRate, avgLatencyMs: avgLatency })
  }
}

/**
 * D2: GitHub API token durumu — hangi limitler geçerli?
 */
async function testD2_githubApiStatus(): Promise<void> {
  const t = Date.now()
  try {
    // Use web_fetch to check GitHub rate limit endpoint directly
    const result = await executeTool('web_fetch', { url: 'https://api.github.com/rate_limit' })
    const str = String(result)

    // Look for rate limit data OR error messages
    const isAuthError = str.includes('Bad credentials') || str.includes('401')
    const isRateLimited = str.includes('rate limit exceeded') || str.includes('403')
    const hasRateData = str.includes('"limit"') || str.includes('"remaining"') || str.includes('"reset"')

    const notes: string[] = []
    let tokenStatus: string

    if (isAuthError) {
      tokenStatus = '⚠️  GITHUB_TOKEN expired/invalid (401 Bad credentials)'
      notes.push(tokenStatus)
      notes.push('Fix: Generate a new token at https://github.com/settings/tokens')
      notes.push('     Add to .env: GITHUB_TOKEN=ghp_...')
    } else if (isRateLimited) {
      tokenStatus = '⚠️  GitHub rate limited (403) — too many unauthenticated requests'
      notes.push(tokenStatus)
    } else if (hasRateData) {
      const limitMatch = str.match(/"limit":\s*(\d+)/)
      const remainingMatch = str.match(/"remaining":\s*(\d+)/)
      const limit = limitMatch ? parseInt(limitMatch[1]) : '?'
      const remaining = remainingMatch ? parseInt(remainingMatch[1]) : '?'
      tokenStatus = `✓ GitHub API working: ${remaining}/${limit} requests remaining`
      notes.push(tokenStatus)
    } else {
      tokenStatus = `GitHub API response unclear: ${str.slice(0, 200)}`
      notes.push(tokenStatus)
    }

    // Even if auth error, test "passed" as in: we got a clear response, didn't crash
    // We fail only if we can't reach GitHub at all
    const reachable = str.length > 20
    if (!reachable) {
      fail('D', 'D2: GitHub API status', Date.now() - t, 'Could not reach GitHub API', notes, { tokenStatus, reachable })
      return
    }

    pass('D', 'D2: GitHub API status', Date.now() - t, notes, { tokenStatus: tokenStatus.slice(0, 80), reachable })
  } catch (e: unknown) {
    fail('D', 'D2: GitHub API status', Date.now() - t, (e as Error).message)
  }
}

/**
 * D3: Neo4j bağlantı kontrolü — gerçekten veri yazılabiliyor mu?
 */
async function testD3_neo4jConnectivity(): Promise<void> {
  const t = Date.now()
  try {
    const result = await executeTool('query_graph_confidence', { label: 'Username', value: 'perf-test-probe' })
    const str = String(result)
    const hasScore = str.includes('Score:') || str.includes('score')
    const hasComponents = str.includes('source_quality') || str.includes('corroboration')

    if (!hasScore && !hasComponents) {
      fail('D', 'D3: Neo4j connectivity', Date.now() - t,
        `query_graph_confidence returned unexpected format: ${str.slice(0, 200)}`)
      return
    }

    pass('D', 'D3: Neo4j connectivity', Date.now() - t, [
      `query_graph_confidence returned valid format`,
      `Output: ${str.slice(0, 150)}`,
    ])
  } catch (e: unknown) {
    fail('D', 'D3: Neo4j connectivity', Date.now() - t, (e as Error).message)
  }
}

/**
 * D4: Scraper latency — web_fetch'in p50/p90 hız profili
 */
async function testD4_scraperLatencyProfile(): Promise<void> {
  const t = Date.now()
  const urls = [
    'https://api.github.com/users/octocat',           // Fast JSON API
    'https://httpbin.org/get',                         // Simple echo endpoint
    'https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore', // Raw file
  ]

  const timings: number[] = []
  const notes: string[] = []

  for (const url of urls) {
    const ut = Date.now()
    try {
      const result = await executeTool('web_fetch', { url })
      const str = String(result)
      const elapsed = Date.now() - ut
      timings.push(elapsed)
      notes.push(`${url.split('/').slice(-1)[0] || url}: ${str.length} chars in ${(elapsed / 1000).toFixed(2)}s`)
    } catch (e: unknown) {
      const elapsed = Date.now() - ut
      timings.push(elapsed)
      notes.push(`${url}: FAILED in ${(elapsed / 1000).toFixed(2)}s — ${(e as Error).message.slice(0, 60)}`)
    }
  }

  const sorted = [...timings].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const avg = timings.reduce((s, v) => s + v, 0) / timings.length

  notes.push(`p50=${(p50 / 1000).toFixed(2)}s  p90=${(p90 / 1000).toFixed(2)}s  avg=${(avg / 1000).toFixed(2)}s`)

  // Fail only if avg > 30s (something is severely broken)
  if (avg > 30000) {
    fail('D', 'D4: Scraper latency profile', Date.now() - t,
      `Avg latency ${(avg / 1000).toFixed(1)}s exceeds 30s threshold — something is severely wrong`, notes,
      { p50Ms: p50, p90Ms: p90, avgMs: avg })
    return
  }

  pass('D', 'D4: Scraper latency profile', Date.now() - t, notes, { p50Ms: p50, p90Ms: p90, avgMs: avg })
}

// ── Grup E: Scraper Fallback Zinciri ──────────────────────────────────

/**
 * E1: search_web — multi-query paralel başarı oranı
 */
async function testE1_searchMultiSuccessRate(): Promise<void> {
  const t = Date.now()
  const queries = [
    'octocat github profile',
    'linux kernel git repository linus',
    'site:twitter.com elon musk profile',   // social — Brave skipped, Google/Tavily used
    'OSINT username investigation tools 2024',
    '"node.js" npm package ecosystem statistics',
  ]

  try {
    const result = await executeTool('search_web_multi', { queries: queries.join('\n') })
    const str = String(result)

    // Count how many queries got results (each result block starts with the query or URL)
    const hasContent = str.length > 200
    const resultBlocks = (str.match(/https?:\/\//g) || []).length

    const notes = [
      `Total result chars: ${str.length}`,
      `URL references found: ${resultBlocks}`,
      `Queries sent: ${queries.length}`,
      `Content per query: ~${Math.round(str.length / queries.length)} chars avg`,
    ]

    if (!hasContent) {
      fail('E', 'E1: search_web_multi — parallel multi-query', Date.now() - t, 'No content returned', notes)
      return
    }

    pass('E', 'E1: search_web_multi — parallel multi-query', Date.now() - t, notes, {
      totalChars: str.length,
      urlCount: resultBlocks,
    })
  } catch (e: unknown) {
    fail('E', 'E1: search_web_multi — parallel multi-query', Date.now() - t, (e as Error).message)
  }
}

/**
 * E2: scrape_profile — farklı domain tiplerini test et
 * Bu test scraper fallback zincirini zorlar: Firecrawl→Puppeteer→Scrapling
 */
async function testE2_scraperFallbackChain(): Promise<void> {
  const t = Date.now()
  const targets = [
    { url: 'https://github.com/torvalds', label: 'GitHub profile (HTML page)' },
    { url: 'https://api.github.com/users/octocat', label: 'JSON API endpoint' },
  ]

  const scrapeResults: Array<{ label: string; ok: boolean; chars: number; durationMs: number }> = []

  for (const target of targets) {
    const st = Date.now()
    try {
      const result = await executeTool('scrape_profile', { url: target.url })
      const str = String(result)
      const elapsed = Date.now() - st
      const ok = str.length > 100 && !str.toLowerCase().includes('error') && !str.toLowerCase().includes('failed')
      scrapeResults.push({ label: target.label, ok, chars: str.length, durationMs: elapsed })
    } catch (e: unknown) {
      scrapeResults.push({ label: target.label, ok: false, chars: 0, durationMs: Date.now() - st })
      info(`Scrape "${target.label}" threw: ${(e as Error).message.slice(0, 80)}`)
    }
  }

  const passed = scrapeResults.filter(r => r.ok).length
  const notes = scrapeResults.map(r =>
    `${r.ok ? '✓' : '✗'} ${r.label}: ${r.chars} chars (${(r.durationMs / 1000).toFixed(2)}s)`
  )

  if (passed === 0) {
    fail('E', 'E2: Scraper fallback chain — all targets failed', Date.now() - t,
      'Tüm scrape denemeleri başarısız — Firecrawl/Puppeteer/Scrapling çalışmıyor', notes)
    return
  }

  pass('E', `E2: Scraper fallback chain — ${passed}/${targets.length} target başarılı`, Date.now() - t, notes, {
    successRate: (passed / targets.length) * 100,
  })
}

/**
 * E3: SSRF koruması — localhost ve özel IP'lere erişim engellenmelidir
 * webFetchTool + scrapeTool SSRF blocklist'i test eder
 * Not: 127.0.0.1:22 ve 169.254.x.x gibi kapalı portlar atlanır (TCP timeout),
 * localhost:7474 (Neo4j) ise açık port olduğundan direkt test edilir.
 */
async function testE3_ssrfProtection(): Promise<void> {
  const t = Date.now()

  // Test 1: web_fetch → localhost should be blocked
  const wfResult = await executeTool('web_fetch', { url: 'http://localhost:7474' }).catch(() => 'exception')
  const wfStr = String(wfResult)
  const wfBlocked = wfStr.includes('engellendi') || wfStr.includes('blocked') || wfResult === 'exception'
  const wfLeaked = wfStr.toLowerCase().includes('neo4j browser') || wfStr.toLowerCase().includes('<title>')

  // Test 2: scrape_profile → localhost should be blocked  
  const spResult = await executeTool('scrape_profile', { url: 'http://localhost:7474' }).catch(() => 'exception')
  const spStr = String(spResult)
  const spBlocked = spStr.includes('engellendi') || spStr.includes('blocked') || spResult === 'exception'
  const spLeaked = spStr.toLowerCase().includes('neo4j browser') || spStr.toLowerCase().includes('<title>')

  const checks = [
    { label: 'web_fetch: localhost blocked', ok: wfBlocked && !wfLeaked },
    { label: 'scrape_profile: localhost blocked', ok: spBlocked && !spLeaked },
  ]

  const notes = [
    ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
    `web_fetch response (80): ${wfStr.slice(0, 80)}`,
    `scrape_profile response (80): ${spStr.slice(0, 80)}`,
  ]

  const failed = checks.filter(c => !c.ok)
  if (failed.length > 0) {
    fail('E', 'E3: SSRF protection — localhost:7474 blocked', Date.now() - t,
      `SECURITY: ${failed.map(c => c.label).join(', ')}`, notes)
    return
  }

  pass('E', 'E3: SSRF protection — localhost:7474 blocked by both tools', Date.now() - t, notes)
}

// ── Grup F: Araç Hata Toleransı ──────────────────────────────────────

/**
 * F1: GitHub OSINT — expired/invalid token ile çalışınca crash olmamalı,
 *     net bir hata mesajı dönmeli (401 tespiti fix testi)
 */
async function testF1_githubApiErrorRecovery(): Promise<void> {
  const t = Date.now()
  try {
    // Run against a well-known non-existent user first — should return clean 404
    const result404 = await executeTool('run_github_osint', { username: 'this-user-definitely-does-not-exist-xyz-1234567890' })
    const str404 = String(result404)

    // Run against real user — if token expired, should return 401 message not crash
    const resultReal = await executeTool('run_github_osint', { username: 'octocat' })
    const strReal = String(resultReal)

    const checks = [
      { label: 'run_github_osint does not crash (no throw)', ok: true }, // got here = no crash
      { label: '404 case: clear "not exist" message', ok: str404.includes('not exist') || str404.includes('not found') || str404.includes('404') },
      {
        label: 'Token error: not generic "rate limited" message',
        ok: !strReal.includes('not found or API rate limited'),  // old generic message gone
      },
      {
        label: 'Token error: specific error type stated',
        ok: strReal.includes('expired') || strReal.includes('invalid') ||
            strReal.includes('rate limit') || strReal.includes('authentication') ||
            strReal.includes('email') || strReal.includes('GitHub'),  // some useful info
      },
    ]

    const failed = checks.filter(c => !c.ok)
    const notes = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`)
    notes.push(`404 response (first 120): ${str404.slice(0, 120)}`)
    notes.push(`Real user response (first 120): ${strReal.slice(0, 120)}`)

    if (failed.length > 1) {
      fail('F', 'F1: GitHub API error recovery', Date.now() - t,
        `${failed.length} checks failed`, notes)
      return
    }

    pass('F', 'F1: GitHub API error recovery', Date.now() - t, notes)
  } catch (e: unknown) {
    fail('F', 'F1: GitHub API error recovery', Date.now() - t,
      `CRASH: ${(e as Error).message}`)
  }
}

/**
 * F2: fact_check_to_graph — model'in gönderdiği geçersiz JSON tags ile crash olmamalı
 *     (Bu testte JSON parse fix'ini doğruluyoruz)
 */
async function testF2_factCheckToGraphBadJson(): Promise<void> {
  const t = Date.now()
  try {
    // Simulate what the model used to send: tags as a plain string (not JSON array)
    const result = await executeTool('fact_check_to_graph', {
      claimId: 'perf-test-claim-2024',
      claimText: 'This is a performance test claim',
      source: 'https://example.com/test',
      claimDate: '2024-01-01',
      verdict: 'UNVERIFIED',
      truthExplanation: 'This is a test — not a real claim',
      tags: 'perf-test, automated, osint-agent',  // Plain CSV string — not JSON array!
    })
    const str = String(result)

    const checks = [
      { label: 'No crash (no exception thrown)', ok: true },
      { label: 'No JSON parse error in response', ok: !str.includes('is not valid JSON') && !str.includes('Unexpected token') },
      { label: 'Response is meaningful', ok: str.length > 10 },
    ]

    const failed = checks.filter(c => !c.ok)
    const notes = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`)
    notes.push(`Response: ${str.slice(0, 200)}`)

    if (failed.length > 0) {
      fail('F', 'F2: fact_check_to_graph — invalid JSON tags graceful handling', Date.now() - t,
        `${failed.map(c => c.label).join(', ')}`, notes)
      return
    }

    pass('F', 'F2: fact_check_to_graph — invalid JSON tags graceful handling', Date.now() - t, notes)
  } catch (e: unknown) {
    fail('F', 'F2: fact_check_to_graph — invalid JSON tags graceful handling', Date.now() - t,
      `CRASH: ${(e as Error).message}`)
  }
}

/**
 * F3: Sherlock binary bulunamadığında uygulama crash vermemeli
 *     (resolveSherlockPath fix testi)
 */
async function testF3_sherlockBinaryResolution(): Promise<void> {
  const t = Date.now()
  try {
    // This tests the binary resolution — if sherlock is missing it should return an error string,
    // not crash the process
    const result = await executeTool('run_sherlock', { username: 'octocat' })
    const str = String(result)

    const checks = [
      { label: 'No crash (no exception thrown)', ok: true },
      { label: 'Response is a string', ok: typeof str === 'string' },
      {
        label: 'If sherlock missing: "ENOENT" not leaked raw',
        // ENOENT in error response is OK as part of a user-friendly message
        // What we want: it should be inside the "Sherlock error:" string, NOT an unhandled exception
        ok: !str.includes('ENOENT') || str.startsWith('Sherlock error:'),
      },
    ]

    const failed = checks.filter(c => !c.ok)
    const notes = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`)
    notes.push(`Response (first 150): ${str.slice(0, 150)}`)

    // Check if sherlock was actually found and ran
    const sherlockRan = !str.includes('ENOENT') && !str.includes('Sherlock error:')
    if (sherlockRan) {
      notes.push(`✓ Sherlock binary found and executed successfully`)
    } else {
      notes.push(`ℹ  Sherlock binary not found — error handled gracefully`)
    }

    if (failed.length > 0) {
      fail('F', 'F3: Sherlock binary resolution', Date.now() - t,
        `${failed.map(c => c.label).join(', ')}`, notes)
      return
    }

    pass('F', 'F3: Sherlock binary resolution', Date.now() - t, notes, { sherlockRan })
  } catch (e: unknown) {
    fail('F', 'F3: Sherlock binary resolution', Date.now() - t,
      `CRASH: ${(e as Error).message}`)
  }
}

// ── Grup G: Graph Kalıcılık Döngüsü ───────────────────────────────────

/**
 * G1: save_finding → query_graph_confidence roundtrip
 *     Gerçekten yazıp okuyabiliyor muyuz?
 */
async function testG1_graphWriteReadRoundtrip(): Promise<void> {
  const t = Date.now()
  const testSubject = `perf-test-user-${Date.now()}`

  try {
    // Step 1: Write a finding
    const writeResult = await executeTool('save_finding', {
      subject_label: 'Username',
      subject_value: testSubject,
      finding_type: 'identity',
      target_label: 'Email',
      target_value: `${testSubject}@test.local`,
      relation: 'HAS_EMAIL',
      confidence: 'medium',
      evidence: 'Performance test fixture',
    })
    const writeStr = String(writeResult)
    const writeOk = writeStr.includes('✅') || writeStr.toLowerCase().includes('success')

    if (!writeOk) {
      fail('G', 'G1: Graph write→read roundtrip', Date.now() - t,
        `save_finding failed: ${writeStr.slice(0, 200)}`)
      return
    }

    // Step 2: Read it back via query_graph_confidence
    // If Neo4j stored the finding, corroboration score should be > 0
    const readResult = await executeTool('query_graph_confidence', {
      label: 'Username',
      value: testSubject,
    })
    const readStr = String(readResult)
    const hasScore = readStr.includes('Score:') || readStr.includes('score')

    // Step 3: Check if the node shows up in graph nodes list
    const listResult = await executeTool('list_graph_nodes', { label: 'Username', limit: '10' })
    const listStr = String(listResult)
    const nodeFound = listStr.includes(testSubject)

    const checks = [
      { label: 'save_finding succeeded', ok: writeOk },
      { label: 'query_graph_confidence returned score after write', ok: hasScore },
      { label: 'list_graph_nodes shows the written node', ok: nodeFound },
    ]

    const failed = checks.filter(c => !c.ok)
    const notes = [
      ...checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`),
      `Write response: ${writeStr.slice(0, 100)}`,
      `Read response: ${readStr.slice(0, 120)}`,
      `Node found in list: ${nodeFound}`,
    ]

    if (failed.length > 0) {
      fail('G', 'G1: Graph write→read roundtrip', Date.now() - t,
        `${failed.map(c => c.label).join(', ')}`, notes)
      return
    }

    pass('G', 'G1: Graph write→read roundtrip', Date.now() - t, notes)
  } catch (e: unknown) {
    fail('G', 'G1: Graph write→read roundtrip', Date.now() - t, (e as Error).message)
  }
}

/**
 * G2: fact_check_to_graph → Neo4j'e gerçekten yazıldı mı?
 */
async function testG2_factCheckGraphPersistence(): Promise<void> {
  const t = Date.now()
  const claimId = `perf-claim-${Date.now()}`

  try {
    // Write fact check
    const writeResult = await executeTool('fact_check_to_graph', {
      claimId,
      claimText: 'Performans test iddiası — otomatik olarak oluşturuldu',
      source: 'https://example.com/perf-test',
      claimDate: new Date().toISOString().slice(0, 10),
      verdict: 'UNVERIFIED',
      truthExplanation: 'Otomatik performans testi',
      tags: JSON.stringify(['perf-test', 'automated']),  // Valid JSON array this time
    })
    const writeStr = String(writeResult)
    const writeOk = writeStr.includes('✅') || writeStr.includes('successfully')

    if (!writeOk) {
      fail('G', 'G2: fact_check_to_graph persistence', Date.now() - t,
        `fact_check_to_graph failed: ${writeStr.slice(0, 200)}`)
      return
    }

    const notes = [
      `✓ fact_check_to_graph succeeded`,
      `Claim ID: ${claimId}`,
      `Response: ${writeStr.slice(0, 150)}`,
    ]

    pass('G', 'G2: fact_check_to_graph persistence', Date.now() - t, notes)
  } catch (e: unknown) {
    fail('G', 'G2: fact_check_to_graph persistence', Date.now() - t, (e as Error).message)
  }
}

// ── Grup H: Ajan Yönlendirme Matrisi ──────────────────────────────────

interface RoutingCase {
  query: string
  expectedAgent: 'identity' | 'media' | 'academic' | 'supervisor_direct'
  description: string
}

/**
 * H1-H5: Supervisor 5 farklı sorgu tipini doğru ajana yönlendiriyor mu?
 * Bu test LLM gerektirir ama routing determinizmini ölçer.
 */
async function testH_agentRoutingMatrix(): Promise<void> {
  const cases: RoutingCase[] = [
    {
      query: '@torvalds kimdir? GitHub profilini çıkar.',
      expectedAgent: 'identity',
      description: 'H1: @username mention → IdentityAgent',
    },
    {
      query: '"defunkt" kullanıcısını araştır, tüm sosyal medya hesaplarını bul.',
      expectedAgent: 'identity',
      description: 'H2: username investigation → IdentityAgent',
    },
    {
      query: 'Bu fotoğrafın metadata bilgilerini çıkar ve nerede çekildiğini bul: https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
      expectedAgent: 'media',
      description: 'H3: image metadata → MediaAgent',
    },
    {
      query: '"Graph RAG" ve "OSINT" üzerine akademik makale ara.',
      expectedAgent: 'academic',
      description: 'H4: academic papers → AcademicAgent',
    },
    {
      query: 'Grafta kaç node ve relation var? İstatistikleri göster.',
      expectedAgent: 'supervisor_direct',
      description: 'H5: graph stats → Supervisor direct',
    },
  ]

  let passCount = 0
  let totalCount = 0

  for (const c of cases) {
    const t = Date.now()
    totalCount++
    try {
      const history: Message[] = [{ role: 'user', content: c.query }]
      const result = await runSupervisor(history)

      if (!result || !result.finalResponse) {
        fail('H', c.description, Date.now() - t, 'Supervisor returned no response')
        continue
      }

      const { finalResponse, history: resultHistory } = result

      // Check which tool was called in supervisor history
      const calledTools = resultHistory
        .filter((msg: Message) => {
          const m = msg as unknown as Record<string, unknown>
          return m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0
        })
        .flatMap((msg: Message) => {
          const m = msg as unknown as Record<string, unknown>
          const tcs = m.tool_calls as Array<{ function: { name: string } }>
          return tcs.map(tc => tc.function.name)
        })

      const delegatedToIdentity = calledTools.includes('ask_identity_agent')
      const delegatedToMedia = calledTools.includes('ask_media_agent')
      const delegatedToAcademic = calledTools.includes('ask_academic_agent')
      const usedGraphTool = calledTools.some(t => t.includes('graph') || t === 'get_graph_stats')

      let routedCorrectly = false
      let actualRoute = 'unknown'

      switch (c.expectedAgent) {
        case 'identity':
          routedCorrectly = delegatedToIdentity
          actualRoute = delegatedToIdentity ? 'ask_identity_agent ✓' : `tools: [${calledTools.join(', ')}]`
          break
        case 'media':
          routedCorrectly = delegatedToMedia
          actualRoute = delegatedToMedia ? 'ask_media_agent ✓' : `tools: [${calledTools.join(', ')}]`
          break
        case 'academic':
          routedCorrectly = delegatedToAcademic
          actualRoute = delegatedToAcademic ? 'ask_academic_agent ✓' : `tools: [${calledTools.join(', ')}]`
          break
        case 'supervisor_direct':
          // Supervisor handled directly — no sub-agent delegation needed
          routedCorrectly = !delegatedToIdentity && !delegatedToMedia && !delegatedToAcademic
          actualRoute = routedCorrectly ? 'supervisor handled directly ✓' : `unexpectedly delegated: ${calledTools.join(', ')}`
          break
      }

      const notes = [
        `Expected: ${c.expectedAgent}`,
        `Actual route: ${actualRoute}`,
        `All tools called: ${calledTools.join(', ') || '(none)'}`,
        `Response length: ${finalResponse.length} chars`,
        `Preview: ${finalResponse.slice(0, 120).replace(/\n/g, ' ')}`,
      ]

      if (!routedCorrectly) {
        fail('H', c.description, Date.now() - t,
          `Wrong routing: expected=${c.expectedAgent}, actual=${actualRoute}`, notes)
      } else {
        passCount++
        pass('H', c.description, Date.now() - t, notes)
      }
    } catch (e: unknown) {
      fail('H', c.description, Date.now() - t, `CRASH: ${(e as Error).message}`)
    }
  }

  // Summary note for the group
  console.log(`\n  H Summary: ${passCount}/${totalCount} routing cases correct`)
}

// ── Rapor ──────────────────────────────────────────────────────────────

function generateReport(): void {
  const totalPassed = results.filter(r => r.passed).length
  const totalFailed = results.filter(r => !r.passed).length
  const totalDurationMs = results.reduce((s, r) => s + r.durationMs, 0)

  const groups = ['D', 'E', 'F', 'G', 'H'] as const
  const groupStats = groups.map(g => {
    const gr = results.filter(r => r.group === g)
    return { group: g, passed: gr.filter(r => r.passed).length, total: gr.length }
  })

  console.log('\n════════════════════════════════════════════════════════')
  console.log(' PERFORMANCE TEST REPORT')
  console.log('════════════════════════════════════════════════════════')
  console.log(`  Tarih:          ${new Date().toISOString()}`)
  console.log(`  Toplam Süre:    ${(totalDurationMs / 1000).toFixed(1)}s`)
  console.log(`  Sonuç:          ${totalPassed}/${totalPassed + totalFailed} passed  (${totalFailed} failed)`)
  console.log()

  console.log('  Grup Özeti:')
  const groupDescriptions: Record<string, string> = {
    D: 'API & Servis Sağlığı',
    E: 'Scraper Fallback Zinciri',
    F: 'Araç Hata Toleransı',
    G: 'Graph Kalıcılık Döngüsü',
    H: 'Ajan Yönlendirme Matrisi',
  }
  for (const s of groupStats) {
    const icon = s.passed === s.total ? '✅' : s.passed > 0 ? '⚠️ ' : '❌'
    console.log(`    ${icon} [${s.group}] ${groupDescriptions[s.group]}: ${s.passed}/${s.total}`)
  }

  const failedResults = results.filter(r => !r.passed)
  if (failedResults.length > 0) {
    console.log('\n  Başarısız Testler:')
    for (const r of failedResults) {
      console.log(`    ❌ [${r.group}] ${r.name}`)
      if (r.error) console.log(`       → ${r.error}`)
    }
  }

  // Performance metrics summary
  const perfResults = results.filter(r => r.metrics)
  if (perfResults.length > 0) {
    console.log('\n  Performans Metrikleri:')
    for (const r of perfResults) {
      if (!r.metrics) continue
      const metricStr = Object.entries(r.metrics)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? (k.includes('Ms') ? `${(v as number / 1000).toFixed(2)}s` : (v as number).toFixed(2)) : v}`)
        .join('  ')
      console.log(`    [${r.group}] ${r.name.split('—')[0].trim()}: ${metricStr}`)
    }
  }

  console.log('════════════════════════════════════════════════════════\n')
}

// ── Ana Çalıştırıcı ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const noGraph = process.argv.includes('--no-graph')
  const noLlm = process.argv.includes('--no-llm')

  console.log('════════════════════════════════════════════════════════')
  console.log(' OSINT Agent Performance Test Suite')
  const flags = [noGraph && '--no-graph', noLlm && '--no-llm'].filter(Boolean)
  console.log(`  Flags: ${flags.length > 0 ? flags.join(', ') : 'none (full run)'}`)
  console.log('════════════════════════════════════════════════════════')

  // ── D: API & Servis Sağlığı ──────────────────────────────────────
  console.log('\n[D] API & Servis Sağlığı')
  await testD1_searchProviderHealth()
  await testD2_githubApiStatus()
  await testD3_neo4jConnectivity()
  await testD4_scraperLatencyProfile()

  // ── E: Scraper Fallback Zinciri ───────────────────────────────────
  console.log('\n[E] Scraper Fallback Zinciri')
  await testE1_searchMultiSuccessRate()
  await testE2_scraperFallbackChain()
  await testE3_ssrfProtection()

  // ── F: Araç Hata Toleransı ────────────────────────────────────────
  console.log('\n[F] Araç Hata Toleransı')
  await testF1_githubApiErrorRecovery()
  await testF2_factCheckToGraphBadJson()
  await testF3_sherlockBinaryResolution()

  // ── G: Graph Kalıcılık Döngüsü ────────────────────────────────────
  if (!noGraph) {
    console.log('\n[G] Graph Kalıcılık Döngüsü')
    await testG1_graphWriteReadRoundtrip()
    await testG2_factCheckGraphPersistence()
  } else {
    console.log('\n[G] Graph testleri atlandı (--no-graph)')
  }

  // ── H: Ajan Yönlendirme Matrisi ───────────────────────────────────
  if (!noLlm) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.log('\n[H] Ajan yönlendirme testleri atlandı — OPENROUTER_API_KEY eksik')
    } else {
      console.log('\n[H] Ajan Yönlendirme Matrisi (LLM — yavaş, ~2-5 dk)')
      await testH_agentRoutingMatrix()
    }
  } else {
    console.log('\n[H] Ajan yönlendirme testleri atlandı (--no-llm)')
  }

  generateReport()
}

main().catch(err => {
  console.error('Performans testi crash!', err)
  process.exit(1)
})

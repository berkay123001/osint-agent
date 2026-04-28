/**
 * Smoke Test Senaryoları — Agent davranışının yapısal doğrulaması.
 *
 * 3 senaryo: identity, media, academic
 * Her senaryo mock tool sonuçlarıyla çalışır.
 * Assertion'lar: tool usage, fabrication, limitation, budget, confidence labels.
 *
 * Mock agent loop kullanılır — gerçek API çağrısı yapılmaz.
 * Test edilen şey: assertion engine + agent konfigürasyon doğruluğu.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMockAgentLoop,
  runAssertions,
  runSmokeScenario,
  type SmokeTestScenario,
  type MockToolMapping,
} from './smokeTestHarness.js'
import type { AgentResult } from './types.js'

// ── Ortak Mock Veriler ─────────────────────────────────────────────────

const KNOWN_URLS = [
  'https://github.com/johndoe',
  'https://twitter.com/johndoe',
  'https://example.com/profile',
  'https://example.com/source-1',
  'https://example.com/source-2',
  'https://example.com/original-photo',
  'https://example.com/photo.jpg',
  'https://example.com/researcher',
  'https://example.com',
  'https://arxiv.org/abs/2401.00001',
  'https://arxiv.org/abs/2401.00002',
  'https://api.semanticscholar.org',
  'https://avatars.githubusercontent.com/johndoe',
  'https://example.com/article',
]

const KNOWN_DOIS = ['10.1234/test-paper-1', '10.5678/test-paper-2']

// ── Identity Mock Tool Sonuçları ───────────────────────────────────────

const IDENTITY_MOCK_TOOLS: MockToolMapping = {
  run_sherlock: JSON.stringify({
    status: 'completed',
    platforms_found: [
      { platform: 'GitHub', url: 'https://github.com/johndoe', status: 'claimed' },
      { platform: 'Twitter', url: 'https://twitter.com/johndoe', status: 'claimed' },
    ],
  }),
  run_maigret: 'Maigret scan result: 2 profiles found.\n- GitHub: https://github.com/johndoe\n- Twitter: https://twitter.com/johndoe',
  run_github_osint: JSON.stringify({
    username: 'johndoe',
    name: 'John Doe',
    bio: 'Software developer',
    location: 'Istanbul, Turkey',
    public_repos: 5,
    followers: 42,
    email: 'john@example.com',
    blog: 'https://example.com',
    avatar_url: 'https://avatars.githubusercontent.com/johndoe',
  }),
  search_person: 'Search results for "John Doe":\n1. John Doe - Software Developer - Istanbul',
  search_web: 'Search results for "johndoe":\n1. GitHub - johndoe\nURL: https://github.com/johndoe\n2. Twitter @johndoe\nURL: https://twitter.com/johndoe',
  scrape_profile: 'Page title: John Doe - GitHub\nBio: Software developer from Istanbul.\nEmail: john@example.com\nLocation: Istanbul, Turkey',
  cross_reference: 'Cross-reference results: 2 matches found.\n- Email john@example.com confirmed on GitHub profile\n- Location Istanbul confirmed on both GitHub and Twitter',
  verify_profiles: 'Profile verification report:\n✅ GitHub: Email match (john@example.com)\n⚠️ Twitter: Could not verify - login wall detected',
  check_email_registrations: JSON.stringify([
    { name: 'GitHub', emailrecovery: null, phoneNumber: null },
    { name: 'Twitter', emailrecovery: null, phoneNumber: null },
  ]),
  check_breaches: JSON.stringify({
    email: 'john@example.com',
    breaches: [{ name: 'ExampleBreach2023', domain: 'example.com', breachDate: '2023-06-15', dataClasses: ['email', 'password'] }],
  }),
  nitter_profile: 'Nitter profile unavailable. Falling back to Scrapling stealth.',
  web_fetch: 'Page content for https://example.com:\nJohn Doe is a software developer based in Istanbul.',
  verify_claim: 'Claim verification: ✅ Verified - John Doe is located in Istanbul (source: GitHub API)',
  auto_visual_intel: 'Visual intel: Avatar found on GitHub. No reverse image matches found.',
}

// ── Media Mock Tool Sonuçları ──────────────────────────────────────────

const MEDIA_MOCK_TOOLS: MockToolMapping = {
  extract_metadata: JSON.stringify({
    camera: 'Canon EOS 5D Mark IV',
    date: '2024-03-15T14:30:00Z',
    gps: { latitude: 41.0082, longitude: 28.9784 },
    software: 'Adobe Photoshop CC 2024',
    interestingFields: { date: true, gps: true, software: true },
  }),
  reverse_image_search: JSON.stringify({
    matches: [
      { url: 'https://example.com/original-photo', title: 'Original Photo - Istanbul', similarity: 0.95 },
      { url: 'https://example.com/edited-version', title: 'Edited Version', similarity: 0.72 },
    ],
  }),
  compare_images_phash: 'Image comparison: Hamming distance = 8 (moderate similarity). Possible minor edits detected.',
  fact_check_to_graph: 'Fact-check result saved to graph. Confidence: medium.',
  wayback_search: JSON.stringify({
    url: 'https://example.com/article',
    snapshots: [
      { timestamp: '20240315120000', status: '200' },
      { timestamp: '20240320090000', status: '200' },
    ],
  }),
  search_web: 'Search results for "Istanbul photo March 2024":\n1. Original source found at example.com\nURL: https://example.com/original-photo',
  search_web_multi: 'Multi-search results: 5 unique results found.',
  scrape_profile: 'Article content: The photo was taken in Istanbul on March 15, 2024. The original photographer confirmed the location.',
  verify_claim: 'Claim verification: ⚠️ Single source - Photo metadata shows editing software (Adobe Photoshop). Original source confirmed but edits detected.',
  auto_visual_intel: 'Visual intel: Reverse image search found 2 matches. Original source identified.',
}

// ── Academic Mock Tool Sonuçları ───────────────────────────────────────

const ACADEMIC_MOCK_TOOLS: MockToolMapping = {
  search_researcher_papers: JSON.stringify({
    authorId: '12345678',
    name: 'Jane Smith',
    affiliations: [{ name: 'MIT' }],
    hIndex: 25,
    paperCount: 45,
    citationCount: 1200,
    papers: [
      { paperId: 'abc123', title: 'Multi-Agent Systems for OSINT', year: 2024, citationCount: 15, venue: 'AAAI 2024' },
      { paperId: 'def456', title: 'Graph Neural Networks for Entity Resolution', year: 2023, citationCount: 30, venue: 'NeurIPS 2023' },
    ],
  }),
  search_academic_papers: JSON.stringify({
    results: [
      { arxivId: '2401.00001', title: 'LLM-based Agents for Open Source Intelligence', authors: ['Smith, J.', 'Doe, A.'], year: 2024, citationCount: 8 },
      { arxivId: '2401.00002', title: 'Confidence Scoring in Multi-Agent Systems', authors: ['Brown, B.'], year: 2023, citationCount: 12 },
    ],
    total: 2,
  }),
  check_plagiarism: 'Plagiarism check: Similarity score 12%. Low risk.',
  search_web: 'Academic search results:\n1. Jane Smith MIT - ResearchGate\nURL: https://example.com/researcher\n2. Recent publications on OSINT',
  web_fetch: 'Paper abstract: This paper presents a novel approach to multi-agent OSINT systems using graph-based confidence scoring...',
  scrape_profile: 'MIT Profile: Jane Smith, Associate Professor. Research areas: AI, Multi-Agent Systems.',
  wayback_search: 'No archived snapshots found for the given URL.',
  query_graph: 'Graph query result: No existing Paper/Author node found.',
}

// ── Mock Final Response'lar ────────────────────────────────────────────

const IDENTITY_FINAL_RESPONSE = [
  '## Identity Investigation Report',
  '',
  '### Summary',
  'Target: johndoe — Digital footprint analysis complete.',
  '',
  '### Verified Candidates',
  '✅ **John Doe** — Software Developer, Istanbul',
  '- GitHub: https://github.com/johndoe [source: run_sherlock, run_github_osint]',
  '- Twitter: https://twitter.com/johndoe [source: run_sherlock]',
  '- Email: john@example.com [source: run_github_osint]',
  '- Location: Istanbul, Turkey [source: run_github_osint]',
  '- Confidence: ✅ VERIFIED (2+ independent sources)',
  '',
  '### Unverified Findings',
  '❓ Blog: https://example.com — Could not verify ownership independently.',
  '',
  '### Breach Data',
  '⚠️ Email john@example.com found in ExampleBreach2023 (2023-06-15)',
  '   Data exposed: email, password [source: check_breaches]',
  '',
  '### Limitations',
  '- Twitter profile could not be fully scraped (login wall)',
  '- No LinkedIn data available',
  '',
  '---',
  '**[META] IdentityAgent tool stats:** run_sherlock×1, run_github_osint×1, cross_reference×1, verify_profiles×1, check_email_registrations×1, check_breaches×1, search_web×1, scrape_profile×1 (total: 8)',
].join('\n')

const MEDIA_FINAL_RESPONSE = [
  '## Media Verification Report',
  '',
  '### 🎯 Claim Summary',
  'Image claimed to be an unedited photo from Istanbul, March 2024.',
  '',
  '### 📊 Source Analysis',
  '1. Original source: https://example.com/original-photo — Confirmed Istanbul location [source: reverse_image_search]',
  '2. EXIF data: Canon EOS 5D Mark IV, GPS: Istanbul coordinates [source: extract_metadata]',
  '',
  '### ⚖️ Confidence Score: 72%',
  'Base: 0.80 (original source found) × Consistency: 0.6 (partial overlap)',
  'Penalty: -0.15 (Adobe Photoshop detected in metadata)',
  '',
  '### ✅ / ❌ Conclusion',
  '⚠️ PARTIALLY VERIFIED: Location and date match, but editing software detected.',
  'The photo was taken in Istanbul but has been post-processed.',
  '',
  '### Limitations',
  '- Original photographer identity could not be independently verified',
  '- Only single source confirms original publication',
  '',
  '---',
  '**[META] MediaAgent tool stats:** extract_metadata×1, reverse_image_search×1, compare_images_phash×1, search_web×1, verify_claim×1 (total: 5)',
].join('\n')

const ACADEMIC_FINAL_RESPONSE = [
  '## Academic Research Report',
  '',
  '### 👤 Researcher Profile',
  '| Full Name | Institution | h-index | Total Papers | Semantic Scholar |',
  '| Jane Smith | MIT | 25 | 45 | ✅ Found |',
  '',
  '### 🗺️ Topic Map',
  '| Topic Area | Paper Count | Most-Cited Example |',
  '| Multi-Agent OSINT | 2 | Multi-Agent Systems for OSINT (15 citations) [source: search_researcher_papers] |',
  '| Graph Neural Networks | 1 | GNN for Entity Resolution (30 citations) [source: search_researcher_papers] |',
  '',
  '### 🔬 Detailed Paper Analyses',
  '**Paper 1: Multi-Agent Systems for OSINT**',
  '- Authors: Jane Smith et al. | Published: 2024 | Venue: AAAI 2024 | Citations: 15 [source: search_researcher_papers]',
  '- Contribution: Novel approach combining multiple specialized agents for OSINT tasks.',
  '',
  '**Paper 2: LLM-based Agents for Open Source Intelligence**',
  '- Authors: Smith, J., Doe, A. | Published: 2024 | Citations: 8 [source: search_academic_papers]',
  '',
  '### Research Gaps',
  '- ❓ No peer-reviewed comparison of confidence scoring methods in multi-agent OSINT',
  '- ❓ Limited evaluation of graph-based entity resolution in real-world OSINT scenarios',
  '',
  '### Limitations',
  '- Full text not available for all papers (needs verification for detailed method comparison)',
  '- Citation counts from Semantic Scholar may not reflect complete picture',
  '',
  '---',
  '**[META] AcademicAgent tool stats:** search_researcher_papers×1, search_academic_papers×1, search_web×1, web_fetch×1 (total: 4)',
].join('\n')

// ── Yardımcı: Mock Agent Sonucu Üretici ────────────────────────────────

function makeMockAgentResult(
  finalResponse: string,
  toolsUsed: Record<string, number>,
): AgentResult {
  const toolCallCount = Object.values(toolsUsed).reduce((sum, c) => sum + c, 0)
  return {
    finalResponse,
    toolCallCount,
    toolsUsed,
    history: [],
  }
}

// ── Test: Identity Smoke ───────────────────────────────────────────────

test('Identity smoke: username investigation uses correct tools, reports limitations, no fabrication', () => {
  const scenario: SmokeTestScenario = {
    name: 'identity-username-investigation',
    agentType: 'identity',
    query: 'johndoe kullanıcısının dijital ayak izini çıkar',
    depth: 'normal',
    maxToolBudget: 20,
    mockTools: IDENTITY_MOCK_TOOLS,
    assertions: [
      { type: 'used_tool', toolName: 'run_sherlock' },
      { type: 'used_tool', toolName: 'run_github_osint' },
      { type: 'used_tool', toolName: 'search_web' },
      { type: 'used_tool', toolName: 'check_breaches', minCount: 1 },
      { type: 'no_fabricated_urls', knownUrls: KNOWN_URLS },
      { type: 'has_limitation_statement' },
      { type: 'tool_budget_respected' },
      { type: 'has_confidence_labels' },
      { type: 'response_min_length', minLength: 200 },
      { type: 'no_empty_claims' },
    ],
  }

  const result = makeMockAgentResult(IDENTITY_FINAL_RESPONSE, {
    run_sherlock: 1,
    run_github_osint: 1,
    cross_reference: 1,
    verify_profiles: 1,
    check_email_registrations: 1,
    check_breaches: 1,
    search_web: 1,
    scrape_profile: 1,
  })

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, true, `Identity smoke failed:\n${assertions.failures.map(f => `  ${f.rule}: expected ${f.expected}, got ${f.actual}`).join('\n')}`)
})

// ── Test: Media Smoke ──────────────────────────────────────────────────

test('Media smoke: fact-check uses correct tools, detects manipulation, no fabrication', () => {
  const scenario: SmokeTestScenario = {
    name: 'media-fact-check',
    agentType: 'media',
    query: 'Bu fotoğraf İstanbul\'da mı çekilmiş ve düzenlenmiş mi?',
    context: 'Image URL: https://example.com/photo.jpg',
    depth: 'normal',
    maxToolBudget: 15,
    mockTools: MEDIA_MOCK_TOOLS,
    assertions: [
      { type: 'used_tool', toolName: 'extract_metadata' },
      { type: 'used_tool', toolName: 'reverse_image_search' },
      { type: 'used_tool', toolName: 'search_web' },
      { type: 'did_not_use_tool', toolName: 'run_sherlock' },
      { type: 'no_fabricated_urls', knownUrls: KNOWN_URLS },
      { type: 'has_limitation_statement' },
      { type: 'tool_budget_respected' },
      { type: 'has_confidence_labels' },
      { type: 'response_min_length', minLength: 200 },
    ],
  }

  const result = makeMockAgentResult(MEDIA_FINAL_RESPONSE, {
    extract_metadata: 1,
    reverse_image_search: 1,
    compare_images_phash: 1,
    search_web: 1,
    verify_claim: 1,
  })

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, true, `Media smoke failed:\n${assertions.failures.map(f => `  ${f.rule}: expected ${f.expected}, got ${f.actual}`).join('\n')}`)
})

// ── Test: Academic Smoke ───────────────────────────────────────────────

test('Academic smoke: literature survey uses correct tools, cites sources, no fabrication', () => {
  const scenario: SmokeTestScenario = {
    name: 'academic-literature-survey',
    agentType: 'academic',
    query: 'Jane Smith MIT araştırmacısının çalışmalarını analiz et',
    depth: 'normal',
    maxToolBudget: 20,
    mockTools: ACADEMIC_MOCK_TOOLS,
    assertions: [
      { type: 'used_tool', toolName: 'search_researcher_papers' },
      { type: 'used_tool', toolName: 'search_academic_papers' },
      { type: 'used_tool', toolName: 'search_web' },
      { type: 'did_not_use_tool', toolName: 'run_sherlock' },
      { type: 'did_not_use_tool', toolName: 'check_breaches' },
      { type: 'no_fabricated_urls', knownUrls: KNOWN_URLS },
      { type: 'no_fabricated_dois', knownDois: KNOWN_DOIS },
      { type: 'has_limitation_statement' },
      { type: 'tool_budget_respected' },
      { type: 'has_confidence_labels' },
      { type: 'response_min_length', minLength: 300 },
    ],
  }

  const result = makeMockAgentResult(ACADEMIC_FINAL_RESPONSE, {
    search_researcher_papers: 1,
    search_academic_papers: 1,
    search_web: 1,
    web_fetch: 1,
  })

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, true, `Academic smoke failed:\n${assertions.failures.map(f => `  ${f.rule}: expected ${f.expected}, got ${f.actual}`).join('\n')}`)
})

// ── Negatif Testler (Assertion Engine Doğrulama) ───────────────────────

test('Assertion engine catches fabricated URLs', () => {
  const scenario: SmokeTestScenario = {
    name: 'fabrication-detection',
    agentType: 'identity',
    query: 'test',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'no_fabricated_urls', knownUrls: ['https://github.com'] },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Found profile at https://totally-fake-url.com/profile',
    toolCallCount: 1,
    toolsUsed: {},
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, false)
  assert.equal(assertions.failures.length, 1)
  assert.ok(assertions.failures[0].actual.includes('totally-fake-url'))
})

test('Assertion engine catches missing limitations', () => {
  const scenario: SmokeTestScenario = {
    name: 'missing-limitations',
    agentType: 'identity',
    query: 'test',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'has_limitation_statement' },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Everything is verified and complete. No issues found.',
    toolCallCount: 1,
    toolsUsed: {},
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, false)
  assert.equal(assertions.failures.length, 1)
  assert.equal(assertions.failures[0].rule, 'has_limitation_statement')
})

test('Assertion engine catches tool budget overflow', () => {
  const scenario: SmokeTestScenario = {
    name: 'budget-overflow',
    agentType: 'identity',
    query: 'test',
    maxToolBudget: 5,
    mockTools: {},
    assertions: [
      { type: 'tool_budget_respected' },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Done',
    toolCallCount: 15,
    toolsUsed: { search_web: 10, scrape_profile: 5 },
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, false)
  assert.equal(assertions.failures.length, 1)
  assert.equal(assertions.failures[0].actual, '15')
})

test('Assertion engine catches empty claims without tool evidence', () => {
  const scenario: SmokeTestScenario = {
    name: 'empty-claims',
    agentType: 'identity',
    query: 'test',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'no_empty_claims' },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Found 5 platforms for this username.',
    toolCallCount: 0,
    toolsUsed: {},
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, false)
  assert.equal(assertions.failures[0].rule, 'no_empty_claims')
})

test('Assertion engine catches fabricated DOIs', () => {
  const scenario: SmokeTestScenario = {
    name: 'fabricated-dois',
    agentType: 'academic',
    query: 'test',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'no_fabricated_dois', knownDois: ['10.1234/real-paper'] },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Paper found with DOI: 10.9999/totally-fake-paper-xyz',
    toolCallCount: 1,
    toolsUsed: {},
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, false)
  assert.equal(assertions.failures.length, 1)
  assert.ok(assertions.failures[0].actual.includes('10.9999'))
})

test('Assertion engine rejects DOI near-matches that only contain a known DOI as a substring', () => {
  const scenario: SmokeTestScenario = {
    name: 'fabricated-doi-near-match',
    agentType: 'academic',
    query: 'test',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'no_fabricated_dois', knownDois: ['10.1234/real-paper'] },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Paper found with DOI: 10.1234/real-paper-fake',
    toolCallCount: 1,
    toolsUsed: {},
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, false)
  assert.equal(assertions.failures.length, 1)
  assert.equal(assertions.failures[0].rule, 'no_fabricated_dois')
})

test('Assertion engine passes when all URLs are known', () => {
  const scenario: SmokeTestScenario = {
    name: 'all-known-urls',
    agentType: 'identity',
    query: 'test',
    maxToolBudget: 10,
    mockTools: {},
    assertions: [
      { type: 'no_fabricated_urls', knownUrls: ['https://github.com/johndoe', 'https://twitter.com/johndoe'] },
    ],
  }

  const result: AgentResult = {
    finalResponse: 'Profile found at https://github.com/johndoe and https://twitter.com/johndoe',
    toolCallCount: 2,
    toolsUsed: { run_sherlock: 1, search_web: 1 },
    history: [],
  }

  const assertions = runAssertions(result, scenario)
  assert.equal(assertions.passed, true)
})

test('createMockAgentLoop resets tool counters on each invocation', async () => {
  const runner = createMockAgentLoop(
    { search_web: 'https://example.com/result' },
    'mock report',
  )
  const config = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: 'Searches the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ],
    maxToolCalls: 5,
  } as any

  const firstResult = await runner([{ role: 'user', content: 'first run' }], config)
  const secondResult = await runner([{ role: 'user', content: 'second run' }], config)

  assert.equal(firstResult.toolCallCount, 1)
  assert.equal(secondResult.toolCallCount, 1)
  assert.deepEqual(firstResult.toolsUsed, { search_web: 1 })
  assert.deepEqual(secondResult.toolsUsed, { search_web: 1 })
})

test('runSmokeScenario strips meta footer before content assertions while keeping parsed tool stats', async () => {
  const scenario: SmokeTestScenario = {
    name: 'meta-footer-stripping',
    agentType: 'identity',
    query: 'test',
    maxToolBudget: 5,
    mockTools: {},
    assertions: [
      { type: 'response_min_length', minLength: 20 },
    ],
  }

  const result = await runSmokeScenario(scenario, async () => ({
    response: [
      'short body',
      '',
      '---',
      '**[META] IdentityAgent tool stats:** search_web×1 (total: 1)',
    ].join('\n'),
    history: [],
  }))

  assert.equal(result.toolCallCount, 1)
  assert.equal(result.responseLength, 'short body'.length)
  assert.equal(result.responsePreview, 'short body')
  assert.equal(result.assertions.passed, false)
  assert.equal(result.assertions.failures[0].rule, 'response_min_length(20)')
})

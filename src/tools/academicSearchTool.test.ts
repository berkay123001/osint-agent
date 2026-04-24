import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatAcademicResult,
  resetAcademicSearchToolStateForTests,
  searchAcademicPapers,
  writeAcademicPapersToGraph,
} from './academicSearchTool.js'

type MockResponse = {
  ok: boolean
  status: number
  text?: () => Promise<string>
  json?: () => Promise<unknown>
}

const originalFetch = globalThis.fetch

function makeArxivXml(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
    <opensearch:totalResults>${entries.length}</opensearch:totalResults>
    ${entries.join('\n')}
  </feed>`
}

function makeArxivEntry(args: {
  id: string
  title: string
  abstract: string
  authors: string[]
  published?: string
}): string {
  return `<entry>
    <id>https://arxiv.org/abs/${args.id}</id>
    <title>${args.title}</title>
    <summary>${args.abstract}</summary>
    <published>${args.published ?? '2025-01-01T00:00:00Z'}</published>
    <updated>${args.published ?? '2025-01-01T00:00:00Z'}</updated>
    ${args.authors.map(author => `<author><name>${author}</name></author>`).join('')}
    <category term="cs.AI" />
  </entry>`
}

function installFetchMock(factory: (url: string) => MockResponse): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    return factory(url) as Response
  }) as typeof fetch
}

test.beforeEach(() => {
  resetAcademicSearchToolStateForTests()
})

test.after(() => {
  globalThis.fetch = originalFetch
})

test('peerReviewedOnly filters out arXiv-only papers when DOI-backed matches exist', async () => {
  installFetchMock((url) => {
    if (url.includes('export.arxiv.org')) {
      return {
        ok: true,
        status: 200,
        text: async () => makeArxivXml([
          makeArxivEntry({
            id: '2501.00001',
            title: 'Agentic OSINT with Preprint Evidence',
            abstract: 'Preprint only result',
            authors: ['Alice Example'],
          }),
        ]),
      }
    }

    if (url.includes('api.semanticscholar.org/graph/v1/paper/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              title: 'Multi-Agent Orchestration for Large Language Models',
              authors: [{ name: 'Jane Doe' }, { name: 'John Roe' }],
              year: 2024,
              citationCount: 64,
              externalIds: { DOI: '10.1145/1234567.1234568' },
              venue: 'ACM Computing Surveys',
              publicationVenue: { name: 'ACM Computing Surveys' },
              isOpenAccess: true,
              abstract: 'Peer-reviewed survey on multi-agent orchestration.',
            },
          ],
        }),
      }
    }

    throw new Error(`Unexpected URL: ${url}`)
  })

  const result = await searchAcademicPapers(
    'LLM agent orchestration frameworks',
    10,
    'relevance',
    { peerReviewedOnly: true },
  )

  assert.equal(result.papers.length, 1)
  assert.equal(result.papers[0]?.title, 'Multi-Agent Orchestration for Large Language Models')
  assert.equal(result.papers[0]?.doi, '10.1145/1234567.1234568')
  assert.ok(!result.papers.some((paper) => paper.arxivId === '2501.00001'))

  const formatted = formatAcademicResult(result)
  assert.ok(formatted.includes('peer-reviewed'))
  assert.ok(formatted.includes('ACM Computing Surveys'))
})

test('default ranking prioritizes DOI and venue-backed papers before arXiv-only results', async () => {
  installFetchMock((url) => {
    if (url.includes('export.arxiv.org')) {
      return {
        ok: true,
        status: 200,
        text: async () => makeArxivXml([
          makeArxivEntry({
            id: '2502.00002',
            title: 'Tool-Using Language Models in Practice',
            abstract: 'arXiv preprint entry',
            authors: ['Pre Print'],
          }),
        ]),
      }
    }

    if (url.includes('api.semanticscholar.org/graph/v1/paper/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              title: 'Tool-Augmented Language Models for External API Use',
              authors: [{ name: 'Casey Author' }],
              year: 2023,
              citationCount: 25,
              externalIds: { DOI: '10.1109/5.771073' },
              venue: 'IEEE Intelligent Systems',
              publicationVenue: { name: 'IEEE Intelligent Systems' },
              isOpenAccess: false,
              abstract: 'Journal paper on tool-augmented LLMs.',
            },
          ],
        }),
      }
    }

    throw new Error(`Unexpected URL: ${url}`)
  })

  const result = await searchAcademicPapers('tool use and function calling in llms', 10, 'relevance')

  assert.equal(result.papers[0]?.title, 'Tool-Augmented Language Models for External API Use')
  assert.equal(result.papers[1]?.title, 'Tool-Using Language Models in Practice')
})

test('peerReviewedOnly falls back to Semantic Scholar candidates and emits a warning when no likely peer-reviewed match exists', async () => {
  installFetchMock((url) => {
    if (url.includes('export.arxiv.org')) {
      return {
        ok: true,
        status: 200,
        text: async () => makeArxivXml([
          makeArxivEntry({
            id: '2503.00003',
            title: 'Metasearch Privacy Workbench',
            abstract: 'arXiv-only candidate',
            authors: ['Ar Xiv'],
          }),
        ]),
      }
    }

    if (url.includes('api.semanticscholar.org/graph/v1/paper/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              title: 'Open Source Intelligence Discovery Notes',
              authors: [{ name: 'Pat Researcher' }],
              year: 2022,
              citationCount: 3,
              externalIds: {},
              venue: 'SSRN Electronic Journal',
              publicationVenue: { name: 'SSRN Electronic Journal' },
              isOpenAccess: true,
              abstract: 'Preprint-style Semantic Scholar record.',
            },
          ],
        }),
      }
    }

    throw new Error(`Unexpected URL: ${url}`)
  })

  const result = await searchAcademicPapers(
    'self-hosted metasearch engines in osint',
    10,
    'relevance',
    { peerReviewedOnly: true },
  )

  assert.equal(result.papers.length, 1)
  assert.equal(result.papers[0]?.source, 'semantic-scholar')
  assert.equal(result.papers[0]?.title, 'Open Source Intelligence Discovery Notes')
  assert.ok(!result.papers.some((paper) => paper.arxivId === '2503.00003'))
  assert.ok((result as { _ssNote?: string })._ssNote?.includes('no likely peer-reviewed'))
})

test('peerReviewedOnly accepts venue-backed conference papers without DOI', async () => {
  installFetchMock((url) => {
    if (url.includes('export.arxiv.org')) {
      return {
        ok: true,
        status: 200,
        text: async () => makeArxivXml([]),
      }
    }

    if (url.includes('api.semanticscholar.org/graph/v1/paper/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              title: 'Context Windows for Multi-Agent Coordination',
              authors: [{ name: 'Venue Only' }],
              year: 2024,
              citationCount: 12,
              externalIds: {},
              venue: 'Proceedings of the AAAI Conference on Artificial Intelligence',
              publicationVenue: { name: 'Proceedings of the AAAI Conference on Artificial Intelligence' },
              isOpenAccess: true,
              abstract: 'Conference paper without DOI in the API payload.',
            },
          ],
        }),
      }
    }

    throw new Error(`Unexpected URL: ${url}`)
  })

  const result = await searchAcademicPapers('context window management in llm conversations', 10, 'relevance', {
    peerReviewedOnly: true,
  })

  assert.equal(result.papers.length, 1)
  assert.equal(result.papers[0]?.title, 'Context Windows for Multi-Agent Coordination')
  assert.equal(result.papers[0]?.venue, 'Proceedings of the AAAI Conference on Artificial Intelligence')
})

test('submittedDate ordering stays newest-first when peerReviewedOnly is disabled', async () => {
  installFetchMock((url) => {
    if (url.includes('export.arxiv.org')) {
      return {
        ok: true,
        status: 200,
        text: async () => makeArxivXml([
          makeArxivEntry({
            id: '2601.00001',
            title: 'Newest arXiv Paper',
            abstract: 'Newest result',
            authors: ['Latest Author'],
            published: '2026-01-01T00:00:00Z',
          }),
        ]),
      }
    }

    if (url.includes('api.semanticscholar.org/graph/v1/paper/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              title: 'Older Journal Paper',
              authors: [{ name: 'Older Author' }],
              year: 2020,
              citationCount: 200,
              externalIds: { DOI: '10.1000/old-paper' },
              venue: 'Journal of OSINT Systems',
              publicationVenue: { name: 'Journal of OSINT Systems' },
              isOpenAccess: false,
              abstract: 'Older but highly cited.',
            },
          ],
        }),
      }
    }

    throw new Error(`Unexpected URL: ${url}`)
  })

  const result = await searchAcademicPapers('llm agent orchestration', 10, 'submittedDate')

  assert.equal(result.papers[0]?.title, 'Newest arXiv Paper')
})

test('writeAcademicPapersToGraph keys DOI-only papers by DOI instead of empty arxivId', async () => {
  const calls: Array<{ query: string; params: Record<string, unknown> }> = []

  await writeAcademicPapersToGraph(
    [
      {
        arxivId: '',
        doi: '10.1000/first-doi',
        title: 'First DOI Paper',
        authors: ['One'],
        abstract: 'First',
        publishedDate: '2024-01-01',
        updatedDate: '',
        categories: ['cs.AI'],
        pdfUrl: 'https://doi.org/10.1000/first-doi',
        htmlUrl: 'https://doi.org/10.1000/first-doi',
        venue: 'Journal A',
      },
      {
        arxivId: '',
        doi: '10.1000/second-doi',
        title: 'Second DOI Paper',
        authors: ['Two'],
        abstract: 'Second',
        publishedDate: '2024-02-01',
        updatedDate: '',
        categories: ['cs.CL'],
        pdfUrl: 'https://doi.org/10.1000/second-doi',
        htmlUrl: 'https://doi.org/10.1000/second-doi',
        venue: 'Journal B',
      },
    ],
    'graph test',
    async (query, params) => {
      calls.push({ query, params })
    },
  )

  const mergeCalls = calls.filter((call) => call.query.includes('MERGE (p:Paper'))
  assert.equal(mergeCalls.length, 2)
  assert.ok(mergeCalls.every((call) => call.query.includes('MERGE (p:Paper {doi: $doi})')))
  assert.deepEqual(mergeCalls.map((call) => call.params.doi), ['10.1000/first-doi', '10.1000/second-doi'])
})
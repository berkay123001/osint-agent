/**
 * Agent E2E test — Verifies that the LLM correctly calls new tools.
 * Each scenario: user message → LLM tool-call → tool executor → result validation
 */
import 'dotenv/config'
import OpenAI from 'openai'
import chalk from 'chalk'
import { extractMetadataFromUrl, formatMetadata } from './tools/metadataTool.js'
import { parseGithubGpgKey, formatGpgResult } from './tools/gpgParserTool.js'
import { waybackSearch, formatWaybackResult } from './tools/waybackTool.js'
import { webFetch } from './tools/webFetchTool.js'
import { writeOsintToGraph, getConnections, getGraphStats, closeNeo4j } from './lib/neo4j.js'

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})
const MODEL = 'qwen/qwen3.6-plus-preview:free'

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'extract_metadata',
      description: 'Extract EXIF/metadata from a file URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_gpg_key',
      description: "Parse a GitHub user's GPG key to find hidden emails/names.",
      parameters: {
        type: 'object',
        properties: { username: { type: 'string' } },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wayback_search',
      description: 'Search Wayback Machine for archived versions of a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Download and read content from a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
]

async function testScenario(
  name: string,
  userMessage: string,
  expectedTool: string,
  executor: (args: Record<string, string>) => Promise<string>
): Promise<boolean> {
  console.log(chalk.cyan.bold(`\n━━━ ${name} ━━━`))
  console.log(chalk.gray(`User: "${userMessage}"`))

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are an OSINT assistant. Use tools when needed.' },
      { role: 'user', content: userMessage },
    ],
    tools,
    tool_choice: 'auto',
    max_tokens: 512,
  })

  const msg = response.choices[0].message
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    console.log(chalk.red(`❌ LLM did not call a tool. Response: ${msg.content?.slice(0, 100)}`))
    return false
  }

  const tc = msg.tool_calls[0]
  if (tc.type !== 'function') {
    console.log(chalk.red(`❌ Expected a function tool, received: ${tc.type}`))
    return false
  }

  const calledTool = tc.function.name
  const args = JSON.parse(tc.function.arguments) as Record<string, string>
  console.log(chalk.yellow(`LLM called: ${calledTool}(${JSON.stringify(args)})`))

  if (calledTool !== expectedTool) {
    console.log(chalk.red(`❌ Expected: ${expectedTool}, Received: ${calledTool}`))
    return false
  }

  // Run the tool
  const result = await executor(args)
  const preview = result.slice(0, 200)
  console.log(chalk.gray(`Result: ${preview}...`))
  console.log(chalk.green(`✅ ${name} PASSED`))
  return true
}

async function main() {
  const results: boolean[] = []

  // Scenario 1: Metadata extraction
  results.push(await testScenario(
    'SENARYO 1: Metadata Extraction',
    'Extract the metadata from this image: https://raw.githubusercontent.com/exiftool/exiftool/master/t/images/ExifTool.jpg',
    'extract_metadata',
    async (args) => {
      const r = await extractMetadataFromUrl(args.url)
      return formatMetadata(r)
    }
  ))

  // Scenario 2: GPG Key Parse
  results.push(await testScenario(
    'SENARYO 2: GPG Key Parse',
    'Find the hidden emails in jessfraz\'s GPG key',
    'parse_gpg_key',
    async (args) => {
      const r = await parseGithubGpgKey(args.username)
      return formatGpgResult(r)
    }
  ))

  // Scenario 3: Wayback Machine
  results.push(await testScenario(
    'SENARYO 3: Wayback Machine',
    'Find archived old versions of the twitter.com/jack page',
    'wayback_search',
    async (args) => {
      const r = await waybackSearch(args.url, 5)
      return formatWaybackResult(r)
    }
  ))

  // Scenario 4: Web Fetch
  results.push(await testScenario(
    'SENARYO 4: Web Fetch',
    'Fetch and show the content of this page: https://httpbin.org/headers',
    'web_fetch',
    async (args) => {
      const r = await webFetch(args.url)
      return r.textContent || r.error || 'empty'
    }
  ))

  // Results
  const passed = results.filter(Boolean).length
  console.log(chalk.cyan.bold(`\n${'━'.repeat(36)}`))
  console.log(chalk.bold(`RESULTS: ${passed}/${results.length} scenarios passed`))
  console.log(chalk.cyan.bold('━'.repeat(36)))

  await closeNeo4j()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('Test error:', e)
  process.exit(1)
})

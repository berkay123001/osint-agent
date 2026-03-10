import 'dotenv/config'
import { llmGenerate, llmGenerateJSON } from './lib/llm.js'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'

async function testOsgint(username: string): Promise<string> {
  const osgintPath = path.resolve(__dirname, '../osint_collection/osgint/osgint.py')
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [osgintPath, '-u', username], {
      cwd: path.dirname(osgintPath),
      timeout: 30000,
    })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { /* ignore */ })
    proc.on('close', () => resolve(stdout))
    proc.on('error', () => resolve(''))
  })
}

async function main() {
  const testUser = 'octocat'
  
  console.log('=== E2E Test Suite ===\n')
  
  // Test 1: LLM çalışıyor mu?
  console.log('1️⃣  LLM Testi...')
  const llmResult = await llmGenerate('What is 2+2? Reply with just the number.')
  console.log(`   ✅ LLM: ${llmResult.text.trim()}\n`)

  // Test 2: LLM JSON output
  console.log('2️⃣  LLM JSON Testi...')
  const jsonResult = await llmGenerateJSON<{ answer: number }>(
    'What is 2+2? Reply with JSON: {"answer": <number>}'
  )
  console.log(`   ✅ JSON: ${JSON.stringify(jsonResult)}\n`)

  // Test 3: osgint çalışıyor mu?
  console.log(`3️⃣  Osgint Testi (${testUser})...`)
  const osgintOut = await testOsgint(testUser)
  const emails = [...new Set(osgintOut.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])]
  if (osgintOut) {
    console.log(`   ✅ Osgint çıktı (ilk 200 char): ${osgintOut.slice(0, 200)}`)
    console.log(`   📧 Bulunan emailler: ${emails.length > 0 ? emails.join(', ') : 'yok'}`)
  } else {
    console.log('   ⚠️  Osgint çıktı vermedi (GitHub rate limit olabilir)')
  }

  // Test 4: PII extraction with LLM
  console.log('\n4️⃣  PII Extraction Testi...')
  const sampleData = `
    Profile found: GitHub user octocat
    Email from commit: octocat@github.com
    Also found: test@example.com
    Bio mentions: San Francisco, CA
    Username also seen on: Twitter @octocat_test
  `
  const pii = await llmGenerateJSON<{
    emails: string[]
    usernames: string[]
    realNames: string[]
    locations: string[]
  }>(`Extract all PII from this text. Return JSON with keys: emails, usernames, realNames, locations (all string arrays).

Text:
${sampleData}`)
  
  if (pii) {
    console.log(`   ✅ PII extracted:`)
    console.log(`      Emails: ${pii.emails?.join(', ') || 'none'}`)
    console.log(`      Usernames: ${pii.usernames?.join(', ') || 'none'}`)
    console.log(`      Names: ${pii.realNames?.join(', ') || 'none'}`)
    console.log(`      Locations: ${pii.locations?.join(', ') || 'none'}`)
  }

  console.log('\n=== Tüm testler tamamlandı ===')
}

main().catch(console.error)

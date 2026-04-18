import 'dotenv/config'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { llmGenerateJSON } from './lib/llm.js'
import { PII_EXTRACTION_PROMPT } from './prompts/extractPII.js'
import type { PIIData } from './prompts/extractPII.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PYTHON = process.env.PYTHON_PATH || '/home/berkayhsrt/anaconda3/bin/python'

// Mini investigate flow - without Sherlock (quick test)
async function miniInvestigate(username: string) {
  console.log(`\n🕵️ Mini Investigation: "${username}"\n`)

  const graph: Array<{ from: string; to: string; relation: string }> = []
  let rawData = ''

  // Step 1: osgint
  console.log('📡 Step 1: GitHub OSINT...')
  const osgintPath = path.resolve(__dirname, '../../osint_collection/osgint/osgint.py')
  const osgintOut = await new Promise<string>((resolve) => {
    const proc = spawn(PYTHON, [osgintPath, '-u', username], {
      cwd: path.dirname(osgintPath),
      timeout: 30000,
    })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => resolve(out))
    proc.on('error', () => resolve(''))
  })

  if (osgintOut) {
    rawData += `=== GitHub OSINT for ${username} ===\n${osgintOut}\n`
    const emails = [...new Set(osgintOut.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])]
    for (const email of emails) {
      graph.push({ from: username, to: email, relation: 'USES_EMAIL' })
    }
    console.log(`   ✅ Osgint completed`)
  }

  // Step 2: LLM PII extraction
  console.log('🧠 Step 2: LLM PII Extraction...')
  if (rawData.trim()) {
    const pii = await llmGenerateJSON<PIIData>(
      PII_EXTRACTION_PROMPT.replace('{{rawData}}', rawData)
    )

    if (pii) {
      for (const email of pii.emails || []) {
        graph.push({ from: username, to: email, relation: 'LINKED_EMAIL' })
      }
      for (const name of pii.realNames || []) {
        graph.push({ from: username, to: name, relation: 'POSSIBLE_REAL_NAME' })
      }
      for (const loc of pii.locations || []) {
        graph.push({ from: username, to: loc, relation: 'LOCATION' })
      }
      for (const u of pii.usernames || []) {
        if (u !== username) {
          graph.push({ from: username, to: u, relation: 'LINKED_USERNAME' })
        }
      }
      console.log(`   ✅ LLM PII extracted`)
    }
  }

  // Results
  console.log(`\n📊 Relationship Graph (${graph.length} connections):`)
  for (const edge of graph) {
    console.log(`   ${edge.from} --[${edge.relation}]--> ${edge.to}`)
  }

  return graph
}

miniInvestigate('torvalds').catch(console.error)

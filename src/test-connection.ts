import 'dotenv/config'
import { llmGenerate } from './lib/llm.js'

async function main() {
  console.log('🔌 OpenRouter connection test...')
  console.log(`   API Key: ${process.env.OPENROUTER_API_KEY?.slice(0, 15)}...`)

  try {
    const response = await llmGenerate(
      'Say "OSINT Agent connection successful" and nothing else.'
    )
    console.log('✅ LLM Response:', response.text)
  } catch (e: unknown) {
    const err = e as Error
    console.error('❌ Error:', err.message)
  }
}

main()

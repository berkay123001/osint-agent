import { z } from 'zod'
import { ai } from '../lib/ai.js'
import { sherlockTool } from '../tools/sherlockTool.js'
import { githubOsint } from '../tools/githubTool.js'
import { PII_EXTRACTION_PROMPT, piiOutputSchema, type PIIData } from '../prompts/extractPII.js'
import { llmGenerateJSON } from '../lib/llm.js'

const MAX_DEPTH = 3

export const investigateFlow = ai.defineFlow(
  {
    name: 'investigate',
    inputSchema: z.object({
      seed: z.string().describe('Starting point: username, email, or identifier'),
      seedType: z.enum(['username', 'email', 'wallet']).default('username'),
    }),
    outputSchema: z.object({
      totalLeads: z.number(),
      graph: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          relation: z.string(),
        })
      ),
    }),
  },
  async (input) => {
    const visited = new Set<string>()
    const graph: Array<{ from: string; to: string; relation: string }> = []
    const queue: Array<{ value: string; type: string; depth: number }> = [
      { value: input.seed, type: input.seedType, depth: 0 },
    ]

    while (queue.length > 0) {
      const current = queue.shift()!
      const key = `${current.type}:${current.value}`

      if (visited.has(key) || current.depth >= MAX_DEPTH) continue
      visited.add(key)

      console.log(
        `🔍 [Depth ${current.depth}] Investigating: ${current.value} (${current.type})`
      )

      let rawData = ''

      // 1. Sherlock ile username tara
      if (current.type === 'username') {
        try {
          const sherlockResult = await sherlockTool({ username: current.value })
          rawData += `\n=== Sherlock Results for ${current.value} ===\n`
          rawData += sherlockResult.foundPlatforms
            .map((p) => `${p.platform}: ${p.url}`)
            .join('\n')

          for (const p of sherlockResult.foundPlatforms) {
            graph.push({
              from: current.value,
              to: p.url,
              relation: 'HAS_PROFILE',
            })
          }
          console.log(
            `  ✅ Sherlock: ${sherlockResult.foundPlatforms.length} platform bulundu`
          )
        } catch (e) {
          console.error('  ❌ Sherlock error:', e)
        }

        // 2. GitHub OSINT
        try {
          const ghResult = await githubOsint(current.value)
          rawData += `\n=== GitHub OSINT for ${current.value} ===\n`
          rawData += ghResult.rawSummary

          for (const email of ghResult.emails) {
            graph.push({
              from: current.value,
              to: email,
              relation: 'USES_EMAIL',
            })
            queue.push({
              value: email,
              type: 'email',
              depth: current.depth + 1,
            })
          }
          console.log(`  ✅ GitHub OSINT: ${ghResult.emails.length} email bulundu`)
        } catch (e) {
          console.error('  ❌ GitHub OSINT error:', e)
        }
      }

      // 3. LLM ile PII çıkar
      if (rawData.trim()) {
        try {
          const pii = await llmGenerateJSON<PIIData>(
            PII_EXTRACTION_PROMPT.replace('{{rawData}}', rawData)
          )
          if (pii) {
            for (const email of pii.emails) {
              if (!visited.has(`email:${email}`)) {
                graph.push({
                  from: current.value,
                  to: email,
                  relation: 'LINKED_EMAIL',
                })
                queue.push({
                  value: email,
                  type: 'email',
                  depth: current.depth + 1,
                })
              }
            }
            for (const username of pii.usernames) {
              if (!visited.has(`username:${username}`)) {
                graph.push({
                  from: current.value,
                  to: username,
                  relation: 'LINKED_USERNAME',
                })
                queue.push({
                  value: username,
                  type: 'username',
                  depth: current.depth + 1,
                })
              }
            }
            for (const name of pii.realNames) {
              graph.push({
                from: current.value,
                to: name,
                relation: 'POSSIBLE_REAL_NAME',
              })
            }
            console.log(
              `  🧠 LLM PII: ${pii.emails.length} emails, ${pii.usernames.length} usernames, ${pii.realNames.length} names`
            )
          }
        } catch (e) {
          console.error('  ❌ LLM extraction error:', e)
        }
      }
    }

    console.log(`\n✅ Araştırma tamamlandı. ${visited.size} lead, ${graph.length} bağlantı.`)

    return {
      totalLeads: visited.size,
      graph,
    }
  }
)

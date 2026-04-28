/**
 * Smoke Test Harness — Agent davranışını yapısal olarak test eder.
 *
 * Gerçek API çağrısı yapılmaz. Mock tool sonuçlarıyla agent'ın
 * karar mekanizması test edilir. İsteğe bağlı canlı test için
 * OPENROUTER_API_KEY ortam değişkeni kontrol edilir.
 */

import type { Message, AgentResult } from './types.js'

// ── Assertion Sonuçları ────────────────────────────────────────────────

export interface AssertionFailure {
  rule: string
  expected: string
  actual: string
}

export interface SmokeAssertionResult {
  passed: boolean
  failures: AssertionFailure[]
}

// ── Mock Tool Sonuçları ────────────────────────────────────────────────

export interface MockToolResponse {
  toolName: string
  argsPattern?: RegExp
  response: string
}

export interface MockToolMapping {
  [toolName: string]: string | ((args: Record<string, string>) => string)
}

// ── Senaryo Tanımı ─────────────────────────────────────────────────────

export interface SmokeTestScenario {
  name: string
  agentType: 'identity' | 'media' | 'academic'
  query: string
  context?: string
  depth?: string
  maxToolBudget: number
  mockTools: MockToolMapping
  assertions: SmokeAssertion[]
}

// ── Assertion Türleri ──────────────────────────────────────────────────

export type SmokeAssertion =
  | { type: 'used_tool'; toolName: string; minCount?: number }
  | { type: 'did_not_use_tool'; toolName: string }
  | { type: 'no_fabricated_urls'; knownUrls: string[] }
  | { type: 'no_fabricated_dois'; knownDois: string[] }
  | { type: 'has_limitation_statement' }
  | { type: 'tool_budget_respected' }
  | { type: 'has_confidence_labels' }
  | { type: 'response_min_length'; minLength: number }
  | { type: 'no_empty_claims' }

// ── Sonuç ──────────────────────────────────────────────────────────────

export interface SmokeTestResult {
  scenario: string
  agentType: string
  toolCallCount: number
  toolsUsed: Record<string, number>
  responseLength: number
  responsePreview: string
  assertions: SmokeAssertionResult
  durationMs: number
}

// ── Mock Agent Loop Runner ─────────────────────────────────────────────

/**
 * Mock tool executor — kayıtlı araç adlarını tanısa da
 * tüm sonuçları mock mapping'den alır.
 */
export function createMockToolExecutor(
  mapping: MockToolMapping,
  callLog: Array<{ toolName: string; args: Record<string, string>; result: string }>,
): (name: string, args: Record<string, string>) => Promise<string> {
  return async (name: string, args: Record<string, string>): Promise<string> => {
    const entry = mapping[name]
    if (entry === undefined) {
      const result = `Tool "${name}" not found in mock mapping.`
      callLog.push({ toolName: name, args, result })
      return result
    }
    const result = typeof entry === 'function' ? entry(args) : entry
    callLog.push({ toolName: name, args, result })
    return result
  }
}

/**
 * Mock agent loop — history'yi izler, mock tool call'ları enjekte eder,
 * sonunda sabit bir "final response" üretir.
 */
export function createMockAgentLoop(
  mockTools: MockToolMapping,
  finalResponse: string,
): (history: Message[], config: import('./types.js').AgentConfig) => Promise<AgentResult> {
  return async (history, config) => {
    const callLog: Array<{ toolName: string; args: Record<string, string>; result: string }> = []
    const toolsUsed: Record<string, number> = {}
    let toolCallCount = 0
    const mockExecute = createMockToolExecutor(mockTools, callLog)

    // Simüle edilmiş tool call döngüsü:
    // Agent'ın system prompt'una göre hangi araçları çağırması bekleniyorsa
    // mock mapping'den al ve history'ye yaz.
    const maxCalls = config.maxToolCalls ?? 30
    const availableTools = new Set(
      config.tools.map((t: any) => t.function?.name).filter(Boolean) as string[]
    )

    // Mock mapping'deki araçları sırayla çağır (simülasyon)
    for (const [toolName] of Object.entries(mockTools)) {
      if (toolCallCount >= maxCalls) break
      if (!availableTools.has(toolName)) continue

      const args: Record<string, string> = { query: 'mock query' }
      const result = await mockExecute(toolName, args)

      // History'ye tool call + sonucu ekle
      const toolCallId = `call_${toolCallCount}`
      history.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      } as any)
      history.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: result,
      } as any)

      toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1
      toolCallCount++
    }

    // Final response ekle
    history.push({ role: 'assistant', content: finalResponse })

    return {
      finalResponse,
      toolCallCount,
      toolsUsed,
      history,
    }
  }
}

// ── Assertion Engine ───────────────────────────────────────────────────

export function runAssertions(
  result: AgentResult,
  scenario: SmokeTestScenario,
): SmokeAssertionResult {
  const failures: AssertionFailure[] = []
  const response = result.finalResponse

  const normalizeDoi = (value: string): string => value.trim().replace(/[)\].,;:]+$/g, '').toLowerCase()

  for (const assertion of scenario.assertions) {
    switch (assertion.type) {
      case 'used_tool': {
        const count = result.toolsUsed[assertion.toolName] ?? 0
        const min = assertion.minCount ?? 1
        if (count < min) {
          failures.push({
            rule: `used_tool(${assertion.toolName}, min=${min})`,
            expected: `>= ${min}`,
            actual: String(count),
          })
        }
        break
      }

      case 'did_not_use_tool': {
        const count = result.toolsUsed[assertion.toolName] ?? 0
        if (count > 0) {
          failures.push({
            rule: `did_not_use_tool(${assertion.toolName})`,
            expected: '0',
            actual: String(count),
          })
        }
        break
      }

      case 'no_fabricated_urls': {
        const urlRegex = /https?:\/\/[^\s|)\]"'<>]+/gi
        const responseUrls = response.match(urlRegex) ?? []
        for (const url of responseUrls) {
          const isKnown = assertion.knownUrls.some(known => url === known || url.startsWith(known + '/') || url.startsWith(known + '?'))
          if (!isKnown) {
            failures.push({
              rule: 'no_fabricated_urls',
              expected: 'URL in known set',
              actual: url.slice(0, 80),
            })
          }
        }
        break
      }

      case 'no_fabricated_dois': {
        const doiRegex = /10\.\d{4,}\/[^\s]+/gi
        const responseDois = response.match(doiRegex) ?? []
        for (const doi of responseDois) {
          const normalizedDoi = normalizeDoi(doi)
          if (!assertion.knownDois.some(known => normalizeDoi(known) === normalizedDoi)) {
            failures.push({
              rule: 'no_fabricated_dois',
              expected: 'DOI in known set',
              actual: doi.slice(0, 60),
            })
          }
        }
        break
      }

      case 'has_limitation_statement': {
        const limitationPatterns = [
          /unverified/i, /could not verify/i, /unknown/i, /no data/i,
          /not found/i, /inaccessible/i, /needs verification/i,
          /insufficient evidence/i, /unsubstantiated/i, /limitation/i,
        ]
        const hasLimitation = limitationPatterns.some(p => p.test(response))
        if (!hasLimitation) {
          failures.push({
            rule: 'has_limitation_statement',
            expected: 'At least one limitation/unverified marker',
            actual: 'None found in response',
          })
        }
        break
      }

      case 'tool_budget_respected': {
        if (result.toolCallCount > scenario.maxToolBudget) {
          failures.push({
            rule: 'tool_budget_respected',
            expected: `<= ${scenario.maxToolBudget}`,
            actual: String(result.toolCallCount),
          })
        }
        break
      }

      case 'has_confidence_labels': {
        const confidencePatterns = [/✅/, /⚠️/, /❓/]
        const hasLabels = confidencePatterns.some(p => p.test(response))
        if (!hasLabels) {
          failures.push({
            rule: 'has_confidence_labels',
            expected: 'At least one confidence label (✅, ⚠️, ❓)',
            actual: 'None found',
          })
        }
        break
      }

      case 'response_min_length': {
        if (response.length < assertion.minLength) {
          failures.push({
            rule: `response_min_length(${assertion.minLength})`,
            expected: `>= ${assertion.minLength} chars`,
            actual: `${response.length} chars`,
          })
        }
        break
      }

      case 'no_empty_claims': {
        // "Found X platforms" ama tool 0 döndüyse → empty claim
        const claimPatterns = [
          /found \d+ platform/i,
          /discovered \d+ account/i,
          /\d+ social media/i,
        ]
        const hasNumericClaim = claimPatterns.some(p => p.test(response))
        // Eğer hiçbir tool çalışmadıysa ve numeric claim varsa → fail
        if (hasNumericClaim && result.toolCallCount === 0) {
          failures.push({
            rule: 'no_empty_claims',
            expected: 'No numeric claims without tool evidence',
            actual: 'Numeric claim found with 0 tool calls',
          })
        }
        break
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  }
}

// ── Senaryo Çalıştırıcı ────────────────────────────────────────────────

export async function runSmokeScenario(
  scenario: SmokeTestScenario,
  agentRunner: (query: string, context?: string, depth?: string, existingHistory?: Message[]) => Promise<{ response: string; history: Message[] }>,
): Promise<SmokeTestResult> {
  const start = Date.now()

  const agentResult = await agentRunner(
    scenario.query,
    scenario.context,
    scenario.depth,
  )

  // AgentResult formatına dönüştür (tool call bilgisi response'dan çıkarılır)
  const toolStatsMatch = agentResult.response.match(/\[META\].*?:\s*(.*?)\s*\(total:\s*(\d+)\)/)
  const toolCallCount = toolStatsMatch ? parseInt(toolStatsMatch[2], 10) : 0
  const responseBody = agentResult.response
    .replace(/\n?---\n?\*\*\[META\][\s\S]*$/m, '')
    .replace(/\n?\*\*\[META\][\s\S]*$/m, '')
    .trim()

  const result: AgentResult = {
    finalResponse: responseBody,
    toolCallCount,
    toolsUsed: {},
    history: agentResult.history,
  }

  // Tools used bilgisini response'dan çıkar
  if (toolStatsMatch) {
    const toolPart = toolStatsMatch[1]
    const toolEntries = toolPart.match(/(\w+)×(\d+)/g)
    if (toolEntries) {
      for (const entry of toolEntries) {
        const match = entry.match(/(\w+)×(\d+)/)
        if (match) {
          result.toolsUsed[match[1]] = parseInt(match[2], 10)
        }
      }
    }
  }

  const assertions = runAssertions(result, scenario)

  return {
    scenario: scenario.name,
    agentType: scenario.agentType,
    toolCallCount: result.toolCallCount,
    toolsUsed: result.toolsUsed,
    responseLength: result.finalResponse.length,
    responsePreview: result.finalResponse.slice(0, 300),
    assertions,
    durationMs: Date.now() - start,
  }
}

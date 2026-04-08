import OpenAI from 'openai'

const MODEL = 'minimax/minimax-m2.7'

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

export interface LLMResponse {
  text: string
}

export async function llmGenerate(prompt: string): Promise<LLMResponse> {
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
  })

  const text = completion.choices[0]?.message?.content || ''
  return { text }
}

export async function llmGenerateJSON<T>(prompt: string): Promise<T | null> {
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: 'You must respond ONLY with valid JSON. No markdown, no explanation, no extra text.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  })

  const text = completion.choices[0]?.message?.content || ''
  try {
    return JSON.parse(text) as T
  } catch {
    // JSON_object format desteği yoksa raw parse
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as T
    }
    return null
  }
}

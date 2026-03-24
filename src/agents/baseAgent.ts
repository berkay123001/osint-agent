import OpenAI from 'openai';
import chalk from 'chalk';
import { sanitizeHistoryForProvider, normalizeAssistantMessage, normalizeToolContent } from '../lib/chatHistory.js';
import type { Message, AgentConfig, AgentResult } from './types.js';

const DEFAULT_MODEL = 'qwen/qwen3.5-flash-02-23';
const SUPERVISOR_MODEL = 'qwen/qwen3.5-plus-02-15';
export { DEFAULT_MODEL, SUPERVISOR_MODEL };
const MAX_TOOL_CALLS_PER_TURN = 30;

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

/**
 * Qwen3 modelleri <think>...</think> etiketleri arasında reasoning yapar.
 * Bu etiketleri temizleyip salt kullanıcıya dönecek içeriği bırakır.
 */
function stripThinkingTokens(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export async function runAgentLoop(
  history: Message[],
  config: AgentConfig
): Promise<AgentResult> {
  let toolCallCount = 0;
  let emptyRetries = 0;
  const toolsUsed: Record<string, number> = {};
  
  while (true) {
    const toolChoice: 'auto' | 'none' = toolCallCount >= MAX_TOOL_CALLS_PER_TURN ? 'none' : 'auto';
    if (toolChoice === 'none') {
      console.log(chalk.yellow(`\n   ⚠️  [${config.name}] Maksimum araç çağrısı aşıldı, özet isteniyor...`));
    }

    console.log(chalk.gray(`\n   ⚙️  [${config.name}] Düşünüyor...`));
    const response = await client.chat.completions.create({
      model: config.model ?? DEFAULT_MODEL,
      messages: sanitizeHistoryForProvider(history),
      tools: config.tools.length > 0 ? config.tools : undefined,
      tool_choice: config.tools.length > 0 ? toolChoice : undefined,
      max_tokens: 4096,
    });

    if (!response || !response.choices || !response.choices[0]) {
      throw new Error(`Geçersiz API yanıtı alındı: ${JSON.stringify(response)}`);
    }

    const message = response.choices[0].message;
    history.push(normalizeAssistantMessage(message));

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const rawContent = typeof message.content === 'string' ? message.content : '';
      const cleanContent = stripThinkingTokens(rawContent);
      
      const refusalText = typeof message.refusal === 'string' && message.refusal.trim().length > 0
        ? message.refusal
        : '';

      // Model sadece <think> döndürüp boş bıraktıysa, bir kez daha dene
      if (cleanContent.length === 0 && toolCallCount > 0 && emptyRetries < 1) {
        emptyRetries++;
        console.log(chalk.yellow(`\n   🔄 [${config.name}] Model boş yanıt döndürdü, tekrar deneniyor...`));
        history.push({
          role: 'user',
          content: 'Lütfen topladığın tüm verileri analiz edip kullanıcıya detaylı bir Markdown raporu olarak sun. Boş yanıt dönme.'
        });
        continue;
      }

      const finalText = cleanContent.length > 0
        ? cleanContent
        : (refusalText || 'Araçlar çalıştı ama model boş yanıt döndürdü.');
        
      return {
        finalResponse: finalText,
        toolCallCount,
        toolsUsed,
      };
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function') continue;
      let result = '';
      const toolName = toolCall.function.name;
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, string>;
        result = await config.executeTool(toolName, args);
      } catch (error) {
        result = `Tool hatası (${toolName}): ${(error as Error).message}`;
      }
      history.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: normalizeToolContent(result),
      });
      toolsUsed[toolName] = (toolsUsed[toolName] ?? 0) + 1;
      toolCallCount++;
    }
  }
}

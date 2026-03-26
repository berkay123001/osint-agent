import OpenAI from 'openai';
import chalk from 'chalk';
import { sanitizeHistoryForProvider, normalizeAssistantMessage, normalizeToolContent } from '../lib/chatHistory.js';
import type { Message, AgentConfig, AgentResult } from './types.js';

const DEFAULT_MODEL = 'qwen/qwen3.5-plus-02-15';
const SUPERVISOR_MODEL = 'qwen/qwen3.5-plus-02-15';
export { DEFAULT_MODEL, SUPERVISOR_MODEL };
const DEFAULT_MAX_TOOL_CALLS = 30;

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
  let correctionRetries = 0;
  const toolsUsed: Record<string, number> = {};
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  
  while (true) {
    const toolChoice: 'auto' | 'none' = toolCallCount >= maxToolCalls ? 'none' : 'auto';
    if (toolChoice === 'none') {
      console.log(chalk.yellow(`\n   ⚠️  [${config.name}] Maksimum araç çağrısı aşıldı, özet isteniyor...`));
    }

    console.log(chalk.gray(`\n   \u2699\ufe0f  [${config.name}] Düşünüyor...`));
    
    // Upstream API hatalarını (502, geçersiz JSON argümanlar) yakala ve yönet
    let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      response = await client.chat.completions.create({
        model: config.model ?? DEFAULT_MODEL,
        messages: sanitizeHistoryForProvider(history),
        tools: config.tools.length > 0 ? config.tools : undefined,
        tool_choice: config.tools.length > 0 ? toolChoice : undefined,
        max_tokens: 4096,
      });
    } catch (apiError: unknown) {
      const msg = apiError instanceof Error ? apiError.message : String(apiError);
      // Alibaba/OpenRouter'dan gelen geçici hatalar için bir kez retry
      if (msg.includes('502') || msg.includes('529') || msg.includes('InternalError')) {
        console.log(chalk.yellow(`\n   🔄 [${config.name}] API geçici hata (${msg.slice(0, 60)}...), 3s bekleyip tekrar deneniyor...`));
        await new Promise(resolve => setTimeout(resolve, 3000));
        response = await client.chat.completions.create({
          model: config.model ?? DEFAULT_MODEL,
          messages: sanitizeHistoryForProvider(history),
          tools: config.tools.length > 0 ? config.tools : undefined,
          tool_choice: config.tools.length > 0 ? toolChoice : undefined,
          max_tokens: 4096,
        });
      } else {
        throw apiError;
      }
    }

    // OpenRouter bazen hata durumunda choices olmaksızın obje döndürür
    const respAny = response as unknown as Record<string, unknown>;
    if (!response?.choices?.[0]) {
      if (respAny['error']) {
        const upstreamErr = JSON.stringify(respAny['error']);
        // Geçersiz JSON argümanı hatası → modele düzeltme fırsatı ver (maks 3 deneme)
        if (upstreamErr.includes('function.arguments') || upstreamErr.includes('InvalidParameter')) {
          correctionRetries++;
          console.log(chalk.yellow(`\n   ⚠️  [${config.name}] Model geçersiz JSON üretmişti, düzeltme isteniyor... (deneme ${correctionRetries}/3)`));
          if (correctionRetries >= 3) {
            correctionRetries = 0;
            history.push({
              role: 'user',
              content:
                'JSON argümanı 3 kez düzeltilemedi. ' +
                'Eğer generate_report çağırıyordun: SADECE subject ve reportType gönder; additionalFindings\'i tamamen çıkar — içerik zaten dahili olarak taşınıyor. ' +
                'Eğer başka bir araç çağırıyordun: argümanları çok kısa tut veya aracı iptal edip text yanıt ver.',
            });
          } else {
            history.push({
              role: 'user',
              content: 'Önceki araç çağrısında JSON formatı hatalıydı. Lütfen araç argümanlarını geçerli JSON formatında yeniden üret.',
            });
          }
          continue;
        }
        throw new Error(`Upstream API hatası: ${upstreamErr}`);
      }
      throw new Error(`Geçersiz API yanıtı: choices yok. Yanıt: ${JSON.stringify(response)}`);
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

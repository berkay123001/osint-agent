import OpenAI from 'openai';
import { sanitizeHistoryForProvider, normalizeAssistantMessage, normalizeToolContent } from '../lib/chatHistory.js';
import { logger } from '../lib/logger.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Message, AgentConfig, AgentResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = 'qwen/qwen3.6-plus-preview:free';
const SUPERVISOR_MODEL = 'qwen/qwen3.6-plus-preview:free';
export { DEFAULT_MODEL, SUPERVISOR_MODEL };

// Alibaba DataInspectionFailed hatası (PII içerik filtresi) durumunda fallback modeller
const FALLBACK_MODELS = [
  'google/gemini-2.0-flash-001',
  'deepseek/deepseek-chat-v3-0324',
];

const DEFAULT_MAX_TOOL_CALLS = 30;
const DEFAULT_MAX_TOKENS = 32768; // Qwen3 thinking tokens için geniş bütçe

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

/**
 * Qwen3 modelleri <think/> etiketleri arasında reasoning yapar.
 * Bu etiketleri temizleyip salt kullanıcıya dönecek içeriği bırakır.
 */
function stripThinkingTokens(text: string): string {
  return text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
}

export async function runAgentLoop(
  history: Message[],
  config: AgentConfig
): Promise<AgentResult> {
  let toolCallCount = 0;
  let emptyRetries = 0;
  let correctionRetries = 0;
  let totalCorrectionAttempts = 0; // Global cap — sonsuz döngüyü önler
  let forceTextRetries = 0; // Metin zorlama deneme sayacı
  const toolsUsed: Record<string, number> = {};
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  // Tool call deduplication: aynı tool+args kombinasyonu önceden çağrıldıysa cache'den dön
  const callCache = new Map<string, string>();
  // Per-tool hard limiti: tek bir tool'un bütün bütçeyi yemesini engeller
  const PER_TOOL_LIMITS: Record<string, number> = { search_academic_papers: 8 };
  const perToolCount: Record<string, number> = {};
  while (true) {
    const toolsDisabled = toolCallCount >= maxToolCalls;
    const toolChoice: 'auto' | 'none' = toolsDisabled ? 'none' : 'auto';
    if (toolsDisabled) {
      logger.warn('AGENT', `[${config.name}] Maksimum araç çağrısı aşıldı, özet isteniyor...`);
    }

    logger.agentThinking(config.name);

    // Upstream API hatalarını (502, geçersiz JSON argümanlar) yakala ve yönet
    let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      response = await client.chat.completions.create({
        model: config.model ?? DEFAULT_MODEL,
        messages: sanitizeHistoryForProvider(history),
        tools: config.tools.length > 0 ? config.tools : undefined,
        tool_choice: config.tools.length > 0 ? toolChoice : undefined,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
    } catch (apiError: unknown) {
      const msg = apiError instanceof Error ? apiError.message : String(apiError);
      const currentModel = config.model ?? DEFAULT_MODEL;

      // Alibaba content filter — PII içerik algılandınca fallback modele geç
      if (msg.includes('DataInspectionFailed')) {
        const fallbackModel = FALLBACK_MODELS[0]; // Gemini
        logger.warn('AGENT', `[${config.name}] Alibaba içerik filtresi → ${fallbackModel} modeline geçiliyor...`);
        response = await client.chat.completions.create({
          model: fallbackModel,
          messages: sanitizeHistoryForProvider(history),
          tools: config.tools.length > 0 ? config.tools : undefined,
          tool_choice: config.tools.length > 0 ? toolChoice : undefined,
          max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        });
      }
      // Diğer geçici hatalar (502, rate limit) için aynı modelde retry
      else if (msg.includes('502') || msg.includes('529') || msg.includes('InternalError')) {
        logger.warn('AGENT', `[${config.name}] API geçici hata (${msg.slice(0, 60)}...), 3s bekleyip tekrar deneniyor...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        response = await client.chat.completions.create({
          model: currentModel,
          messages: sanitizeHistoryForProvider(history),
          tools: config.tools.length > 0 ? config.tools : undefined,
          tool_choice: config.tools.length > 0 ? toolChoice : undefined,
          max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        });
      }
      else {
        throw apiError;
      }
    }

    // OpenRouter bazen hata durumunda choices olmaksızın obje döndürür
    const respAny = response as unknown as Record<string, unknown>;
    if (!response?.choices?.[0]) {
      if (respAny['error']) {
        const upstreamErr = JSON.stringify(respAny['error']);
        // Gerçek hata içeriğini logla — neyin kırıldığını anlamak için
        logger.error('AGENT', `[${config.name}] OpenRouter upstream hatası: ${upstreamErr.slice(0, 500)}`);

        // Alibaba içerik filtresi → fallback modele geç
        if (upstreamErr.includes('DataInspectionFailed')) {
          const fallbackModel = FALLBACK_MODELS[0];
          logger.warn('AGENT', `[${config.name}] Alibaba DataInspection → ${fallbackModel} fallback deneniyor...`);
          response = await client.chat.completions.create({
            model: fallbackModel,
            messages: sanitizeHistoryForProvider(history),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          });
          // Fallback sonrası tekrar kontrol et
          if (!response?.choices?.[0]) {
            throw new Error(`Model hatası (fallback de başarısız): ${upstreamErr.slice(0, 200)}`);
          }
        }
        // Geçersiz JSON argümanı hatası → modele düzeltme fırsatı ver (maks 3 deneme)
        else if (upstreamErr.includes('function.arguments') || upstreamErr.includes('InvalidParameter')) {
          // Araçlar devre dışıyken veya 3 düzeltme sonrası model hâlâ araç çağırıyorsa
          if (toolsDisabled || totalCorrectionAttempts >= 3) {
            forceTextRetries++
            if (forceTextRetries > 1) {
              // 2. denemede bile başarısız → temiz bir API çağrısı yap (session file'lardan zengin context ile)
              logger.warn('AGENT', `[${config.name}] Model araç çağırmakta ısrarcı — session file'dan context ile temiz metin yanıtı deneniyor.`)

              // Session dosyalarından zengin context oku (2000 char sınırı yerine)
              let contextSnippet = ''
              const sessionDir = path.resolve(__dirname, '../../.osint-sessions')
              const sessionFiles = [
                'academic-last-session.md',
                'identity-last-session.md',
                'media-last-session.md',
                'academic-knowledge.md',
                'identity-knowledge.md',
                'media-knowledge.md',
              ]
              for (const f of sessionFiles) {
                try {
                  const content = await readFile(path.join(sessionDir, f), 'utf-8')
                  if (content.length > 100) {
                    // Her session file'dan en fazla 3000 char al, toplamda max 8000
                    const slice = content.length > 3000 ? content.slice(0, 3000) + '\n[...kısaltıldı]' : content
                    contextSnippet += `\n\n--- ${f} ---\n${slice}`
                    if (contextSnippet.length > 8000) break
                  }
                } catch { /* dosya yoksa atla */ }
              }

              // Session file boşsa history'den al
              if (contextSnippet.length < 200) {
                const toolResults = history
                  .filter(m => m.role === 'tool' && typeof m.content === 'string')
                  .map(m => (m.content as string))
                contextSnippet = toolResults.join('\n---\n')
                if (contextSnippet.length > 6000) {
                  contextSnippet = contextSnippet.slice(0, 6000) + '\n[...kısaltıldı]'
                }
              }

              const lastUserMsg = [...history].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && !(m.content as string).startsWith('ARAÇ ÇAĞRISI') && !(m.content as string).startsWith('JSON'))
              const userQuestion = lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : 'Kullanıcı sorusu'

              try {
                const cleanResponse = await client.chat.completions.create({
                  model: config.model ?? DEFAULT_MODEL,
                  messages: [
                    { role: 'system', content: 'Sen OSINT araştırma asistanısın. Sana verilen araştırma verilerini analiz edip Markdown formatında özetle. Hiçbir araç çağırma — sadece düz metin yaz.' },
                    { role: 'user', content: `Kullanıcı şunu sordu: "${userQuestion}"\n\nAşağıda araştırma verileri var. Bunları kullanarak detaylı bir Markdown raporu oluştur:\n\n${contextSnippet}` },
                  ],
                  // tools parametresi yok — model araç çağıramaz
                  max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
                })
                const text = cleanResponse.choices?.[0]?.message?.content?.trim()
                if (text) {
                  const cleaned = stripThinkingTokens(text)
                  if (cleaned.length > 50) {
                    return { finalResponse: cleaned, toolCallCount, toolsUsed }
                  }
                }
              } catch (cleanErr) {
                logger.error('AGENT', `[${config.name}] Temiz API çağrısı da başarısız: ${(cleanErr as Error).message}`)
              }
              return {
                finalResponse: 'Model yanıt üretilemedi. Toplanan veriler session dosyasına kaydedildi — `read_session_file` ile erişebilirsiniz.',
                toolCallCount,
                toolsUsed,
              }
            }
            logger.warn('AGENT', `[${config.name}] JSON hatası + araç devre dışı — metin yanıt zorlanıyor (${forceTextRetries}/1).`)
            // Bozuk history'yi düzelt: tool mesajı sonrası assistant placeholder ekle
            const lastMsgForce = history[history.length - 1];
            if (lastMsgForce && (lastMsgForce.role === 'tool' || lastMsgForce.role === 'user')) {
              if (lastMsgForce.role === 'tool') {
                history.push({ role: 'assistant', content: 'Araç çağrısı başarısız, text yanıt veriliyor.' });
              }
              history.push({ role: 'user', content: 'Araç çağırma. Topladığın tüm verileri doğrudan metin olarak sun.' });
            }
            config = { ...config, tools: [] }
            continue
          }

          correctionRetries++;
          totalCorrectionAttempts++;
          logger.warn('AGENT', `[${config.name}] Model geçersiz JSON üretmişti, düzeltme isteniyor... (deneme ${correctionRetries}/3, toplam: ${totalCorrectionAttempts})`);

          // KRİTİK: Eğer history'nin son mesajı 'tool' ise, correction user mesajı öncesinde
          // bir placeholder assistant mesajı ekle. Aksi halde:
          //   tool → user  (GEÇERSİZ FORMAT — OpenRouter/model bozuk yanıt üretiyor)
          //   tool → assistant → user  (DOĞRU FORMAT)
          const lastMsg = history[history.length - 1];
          if (lastMsg && lastMsg.role === 'tool') {
            history.push({
              role: 'assistant',
              content: 'Araç çağrısı geçersiz JSON üretti, düzeltiliyor.',
            });
          }

          // Global cap: 3 toplam denemeden sonra zorla metin yanıt al
          if (totalCorrectionAttempts >= 3) {
            logger.error('AGENT', `[${config.name}] JSON düzeltme 3 kez başarısız — araç çağrısı devre dışı bırakılıyor.`);
            history.push({
              role: 'user',
              content:
                'ARAÇ ÇAĞRISI DEVRE DIŞI. Topladığın tüm bilgileri kullanarak doğrudan Markdown metin olarak yanıt ver. ' +
                'Herhangi bir araç çağırma — sadece metin yaz.',
            });
            toolCallCount = maxToolCalls + 1;
            correctionRetries = 0;
            continue;
          }

          if (correctionRetries >= 2) {
            correctionRetries = 0;
            history.push({
              role: 'user',
              content:
                'ARAÇ ÇAĞRISI BAŞARISIZ. Araç çağırmayı bırak ve topladığın verileri doğrudan Markdown metin olarak özetle. ' +
                'Hiçbir araç çağırma — save_finding, generate_report dahil HIÇBIR ŞEY. Sadece düz metin yaz.',
            });
          } else {
            history.push({
              role: 'user',
              content: 'Önceki araç çağrısında JSON formatı hatalıydı. ' +
                'Tek bir araç çağır ve argümanları çok kısa tut. ' +
                'Çok fazla araç çağırmaya çalışıyorsan VAZGEÇ ve sonuçları metin olarak yaz.',
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

      // Model sadece <think/> döndürüp boş bıraktıysa, bir kez daha dene
      if (cleanContent.length === 0 && toolCallCount > 0 && emptyRetries < 1) {
        emptyRetries++;
        logger.warn('AGENT', `[${config.name}] Model boş yanıt döndürdü, tekrar deneniyor...`);
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
        // Normalize cache key: argümanları sıralayarak key üret (sıra farkı cache miss'i engeller)
        const sortedArgs = Object.keys(args).sort().reduce<Record<string, string>>((acc, k) => { acc[k] = args[k]; return acc; }, {});
        const cacheKey = `${toolName}:${JSON.stringify(sortedArgs)}`;

        // Per-tool hard limit kontrolü
        perToolCount[toolName] = (perToolCount[toolName] ?? 0) + 1;
        const toolLimit = PER_TOOL_LIMITS[toolName];
        if (toolLimit && perToolCount[toolName] > toolLimit) {
          logger.warn('AGENT', `[${config.name}] ${toolName} hard limiti aşıldı (${toolLimit}). Atlanıyor.`);
          result = `[TOOL_LIMIT] ${toolName} bu oturumda ${toolLimit} kez çağrıldı — limit doldu. Elindeki verilerle devam et, rapor yaz.`;
        } else if (callCache.has(cacheKey)) {
          logger.warn('AGENT', `[${config.name}] Duplikat tool çağrısı engellendi: ${toolName} (aynı argümanlar)`);
          result = `[DUPLICATE_CALL] Bu sorgu daha önce çağrıldı ve sonuç zaten history'de. Farklı bir sorgu dene ya da bir sonraki faza geç.\n\n[cached: ${(callCache.get(cacheKey) ?? '').slice(0, 500)}...]`;
        } else {
          result = await config.executeTool(toolName, args);
          callCache.set(cacheKey, result);
        }
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

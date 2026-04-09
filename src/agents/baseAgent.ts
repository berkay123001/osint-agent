import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { sanitizeHistoryForProvider, normalizeAssistantMessage, normalizeToolContent } from '../lib/chatHistory.js';
import { logger } from '../lib/logger.js';
import { emitProgress } from '../lib/progressEmitter.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Message, AgentConfig, AgentResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = 'kwaipilot/kat-coder-pro-v2';
const SUPERVISOR_MODEL = 'qwen/qwen3.6-plus';
export { DEFAULT_MODEL, SUPERVISOR_MODEL };

// Fallback modeller — content filter (PII) VEYA rate limit durumunda sirayla denenir
const FALLBACK_MODELS = [
  'kwaipilot/kat-coder-pro-v2',
  'google/gemini-2.0-flash-001',
  'deepseek/deepseek-chat-v3-0324',
  'qwen/qwen3-235b-a22b:free',
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
  config: AgentConfig,
  _clientOverride?: OpenAI,
  _retryDelayMs?: number
): Promise<AgentResult> {
  const _client = _clientOverride ?? client;
  const _delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, _retryDelayMs ?? ms));
  let toolCallCount = 0;
  let emptyRetries = 0;
  let correctionRetries = 0;
  let totalCorrectionAttempts = 0; // Global cap — sonsuz döngüyü önler
  let forceTextRetries = 0; // Metin zorlama deneme sayacı
  let toolsDisabledMessageSent = false; // Araç bütçesi dolunca özet isteği yalnızca bir kez gönderilir
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
    if (toolsDisabled && !toolsDisabledMessageSent) {
      toolsDisabledMessageSent = true;
      logger.warn('AGENT', `[${config.name}] Maksimum araç çağrısı aşıldı, nihai rapor isteniyor...`);
      // Modelin bağlamı kaybedip selamlama döndürmesini önlemek için açık yönlendirme
      history.push({
        role: 'user',
        content:
          'TÜM ARAÇLAR TAMAMLANDI. Yukarıda çalıştırılan araçların sonuçlarını kullanarak ' +
          'nihai Markdown raporunu ŞİMDİ yaz. ' +
          'Yeni araç çağırma — sadece mevcut bulgulardan oluşan tam ve detaylı final rapor sun. ' +
          'Selamlama veya "nasıl yardımcı olabilirim" YAZMA.',
      });
    }

    logger.agentThinking(config.name);

    // OpenAI SDK: create() metodu 2 overload'a sahip:
    //   1) stream:false → ChatCompletion döner
    //   2) stream:true  → Stream<ChatCompletionChunk> döner
    // TypeScript her iki durumu da kapsayan union tip çıkarımı yapar: Stream | ChatCompletion
    // Biz stream:true kullanmadığımız için her zaman ChatCompletion gelir,
    // ama TS bunu bilemez → .choices erişimi derleme hatası verir (Stream'de .choices yok).
    // Çözüm: `any` tipi ile TS tip kontrolünü atlıyoruz + her çağrıda `as ChatCompletion` cast.
    let response: ChatCompletion | undefined;
    try {
      response = (await _client.chat.completions.create({
        model: config.model ?? DEFAULT_MODEL,
        messages: sanitizeHistoryForProvider(history),
        tools: config.tools.length > 0 ? config.tools : undefined,
        tool_choice: config.tools.length > 0 ? toolChoice : undefined,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      }) as ChatCompletion);
    } catch (apiError: unknown) {
      const msg = apiError instanceof Error ? apiError.message : String(apiError);
      const currentModel = config.model ?? DEFAULT_MODEL;

      // Alibaba content filter — PII içerik algılandınca fallback modele geç
      if (msg.includes('DataInspectionFailed') || msg.includes('inappropriate content')) {
        const fallbackModel = FALLBACK_MODELS[0]; // Gemini
        logger.warn('AGENT', `[${config.name}] Alibaba içerik filtresi → ${fallbackModel} modeline geçiliyor...`);
        try {
          response = (await _client.chat.completions.create({
            model: fallbackModel,
            messages: sanitizeHistoryForProvider(history),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          }) as ChatCompletion);
        } catch (fallbackErr) {
          // Fallback model de reddedirse → graceful degradation, crash etme
          logger.warn('AGENT', `[${config.name}] Fallback model de başarısız — içerik filtresi atlanamıyor.`);
          return {
            finalResponse: '⚠️ Bu sorgu içerik filtresine takıldı. Soruyu farklı bir şekilde ifade etmeyi veya konuyu değiştirmeyi dene.',
            toolsUsed,
            toolCallCount,
          };
        }
      }
      // OpenRouter rate limit — exponential backoff + fallback model zinciri
      else if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests')) {
        // 1. deneme: ayni model, 5s bekle
        const waitMs = 5000;
        logger.warn('AGENT', `[${config.name}] Rate limit (429) — ${waitMs / 1000}s bekleyip tekrar deneniyor...`);
        await _delay(waitMs);
        try {
          response = (await _client.chat.completions.create({
            model: currentModel,
            messages: sanitizeHistoryForProvider(history),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          }) as ChatCompletion);
        } catch (retryErr) {
          // 2. deneme: fallback modelleri sirayla dene
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (retryMsg.includes('429') || retryMsg.toLowerCase().includes('rate limit')) {
            for (const fbModel of FALLBACK_MODELS) {
              if (fbModel === currentModel) continue; // ayni modeli atla
              logger.warn('AGENT', `[${config.name}] 429 devam — fallback deneniyor: ${fbModel}`);
              await _delay(2000);
              try {
                response = (await _client.chat.completions.create({
                  model: fbModel,
                  messages: sanitizeHistoryForProvider(history),
                  tools: config.tools.length > 0 ? config.tools : undefined,
                  tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                  max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
                }) as ChatCompletion);
                logger.info('AGENT', `[${config.name}] Fallback basarili: ${fbModel}`);
                break; // basarili → donguden cik
              } catch {
                // bu fallback de basarisiz → sonrakini dene
                continue;
              }
            }
            if (!response?.choices?.[0]) {
              throw new Error(`Tum modeller rate limit (429) — biraz bekle ve tekrar dene.`);
            }
          } else {
            throw retryErr;
          }
        }
      }
        // Diğer geçici hatalar (502, 504, 529) için aynı modelde retry
      else if (msg.includes('502') || msg.includes('504') || msg.includes('529') || msg.includes('InternalError') || msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('timeout')) {
        logger.warn('AGENT', `[${config.name}] API geçici hata (${msg.slice(0, 60)}...), 3s bekleyip tekrar deneniyor...`);
        await _delay(3000);
        response = (await _client.chat.completions.create({
          model: currentModel,
          messages: sanitizeHistoryForProvider(history),
          tools: config.tools.length > 0 ? config.tools : undefined,
          tool_choice: config.tools.length > 0 ? toolChoice : undefined,
          max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        }) as ChatCompletion);
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

        // 429 rate limit → fallback model zinciri dene (response body içinde gelen 429)
        if (upstreamErr.includes('429') || upstreamErr.toLowerCase().includes('rate limit') || upstreamErr.toLowerCase().includes('too many requests')) {
          const currentModel = config.model ?? DEFAULT_MODEL;
          for (const fbModel of FALLBACK_MODELS) {
            if (fbModel === currentModel) continue;
            logger.warn('AGENT', `[${config.name}] Response-body 429 → fallback deneniyor: ${fbModel}`);
            await _delay(2000);
            try {
              response = (await _client.chat.completions.create({
                model: fbModel,
                messages: sanitizeHistoryForProvider(history),
                tools: config.tools.length > 0 ? config.tools : undefined,
                tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
              }) as ChatCompletion);
              if (response?.choices?.[0]) {
                logger.info('AGENT', `[${config.name}] Fallback başarılı: ${fbModel}`);
                break;
              }
            } catch {
              continue;
            }
          }
          if (!response?.choices?.[0]) {
            throw new Error(`Tüm modeller rate limit (429) — biraz bekle ve tekrar dene.`);
          }
        }
        // Alibaba içerik filtresi → fallback modele geç
        else if (upstreamErr.includes('DataInspectionFailed')) {
          const fallbackModel = FALLBACK_MODELS[0];
          logger.warn('AGENT', `[${config.name}] Alibaba DataInspection → ${fallbackModel} fallback deneniyor...`);
          response = (await _client.chat.completions.create({
            model: fallbackModel,
            messages: sanitizeHistoryForProvider(history),
            tools: config.tools.length > 0 ? config.tools : undefined,
            tool_choice: config.tools.length > 0 ? toolChoice : undefined,
            max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          }) as ChatCompletion);
          // Fallback sonrası tekrar kontrol et
          if (!response?.choices?.[0]) {
            throw new Error(`Model hatası (fallback de başarısız): ${upstreamErr.slice(0, 200)}`);
          }
        }
        // Geçersiz JSON argümanı hatası → modele düzeltme fırsatı ver (maks 3 deneme)
        // 504 upstream timeout / operation aborted → fallback model zinciri dene
        else if (upstreamErr.includes('504') || upstreamErr.toLowerCase().includes('aborted') || upstreamErr.toLowerCase().includes('timeout')) {
          const currentModel504 = config.model ?? DEFAULT_MODEL;
          logger.warn('AGENT', `[${config.name}] 504/timeout upstream hatası → fallback model zinciri deneniyor...`);
          let recovered = false;
          for (const fbModel of FALLBACK_MODELS) {
            if (fbModel === currentModel504) continue;
            await _delay(3000);
            try {
              response = (await _client.chat.completions.create({
                model: fbModel,
                messages: sanitizeHistoryForProvider(history),
                tools: config.tools.length > 0 ? config.tools : undefined,
                tool_choice: config.tools.length > 0 ? toolChoice : undefined,
                max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
              }) as ChatCompletion);
              if (response?.choices?.[0]) {
                logger.info('AGENT', `[${config.name}] 504 sonrası fallback başarılı: ${fbModel}`);
                recovered = true;
                break;
              }
            } catch { continue; }
          }
          if (!recovered || !response?.choices?.[0]) {
            throw new Error(`504 upstream timeout — tüm fallback modeller başarısız. Biraz bekleyip tekrar dene.`);
          }
        }
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
                const cleanResponse = (await _client.chat.completions.create({
                  model: config.model ?? DEFAULT_MODEL,
                  messages: [
                    { role: 'system', content: 'Sen OSINT araştırma asistanısın. Sana verilen araştırma verilerini analiz edip Markdown formatında özetle. Hiçbir araç çağırma — sadece düz metin yaz.' },
                    { role: 'user', content: `Kullanıcı şunu sordu: "${userQuestion}"\n\nAşağıda araştırma verileri var. Bunları kullanarak detaylı bir Markdown raporu oluştur:\n\n${contextSnippet}` },
                  ],
                  // tools parametresi yok — model araç çağıramaz
                  max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
                }) as ChatCompletion)
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
                finalResponse: 'Model yanıt üretilemedi. Toplanan veriler session dosyasına kaydedildi — `.osint-sessions/` klasörüne bakabilirsin.',
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

      // Thinking model <think>...</think> içine her şeyi yazıp final cevabı boş bırakabilir.
      // stripThinkingTokens() bunları siler → cleanContent = "".
      // Çözüm: artan agresiflikte 3 retry:
      //   1. Nazikçe raporla iste
      //   2. Araçları kapat, sadece metin iste
      //   3. Yeni bir temiz API çağrısı yap (system prompt + sadece son tool sonuçları)
      if (cleanContent.length === 0 && emptyRetries < 3) {
        emptyRetries++;
        logger.warn('AGENT', `[${config.name}] Model boş yanıt döndürdü (deneme ${emptyRetries}/3)...`);

        if (emptyRetries === 1) {
          history.push({
            role: 'user',
            content: 'ÖNEMLI: Yukarıdaki araç sonuçlarını kullanarak şimdi kapsamlı bir Markdown raporu yaz. ' +
              'Cevabını DOĞRUDAN <think> etiketi DIŞINDA yaz. Düşünme bloğu değil, nihai rapor istiyorum.'
          });
        } else if (emptyRetries === 2) {
          // Araçları tamamen kapat, sadece metin yanıtı iste
          config = { ...config, tools: [] };
          history.push({
            role: 'user',
            content: 'Araç çağırmayı bırak. Yukarıda topladığın tüm bilgileri SADECE DÜZ METİN olarak özetle. ' +
              'Markdown başlıkları, listeler kullan. <think> etiketleri kullanma — sadece final cevap yaz.'
          });
        } else {
          // 3. deneme: history'den tool sonuçlarını alıp temiz çağrı yap
          const toolResults = history
            .filter(m => m.role === 'tool' && typeof m.content === 'string')
            .map(m => m.content as string)
            .join('\n---\n')
            .slice(0, 8000);
          try {
            const cleanResp = (await _client.chat.completions.create({
              model: config.model ?? DEFAULT_MODEL,
              messages: [
                { role: 'system', content: 'Araştırma verilerini Markdown formatında özetleyen bir asistansın. Sadece final raporu yaz, <think> kullanma.' },
                { role: 'user', content: `Araştırma verileri:\n${toolResults}\n\nBu verileri kullanarak detaylı bir Markdown raporu oluştur.` },
              ],
              max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
            }) as ChatCompletion);
            const text = cleanResp.choices?.[0]?.message?.content?.trim() ?? '';
            const cleaned = stripThinkingTokens(text);
            if (cleaned.length > 50) {
              return { finalResponse: cleaned, toolCallCount, toolsUsed };
            }
          } catch { /* temiz çağrı da başarısız → aşağıdaki fallback mesajını döndür */ }
        }
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
          // Kısa bir arg özeti oluştur (log paneline yazar)
          const argSummary = Object.entries(args)
            .slice(0, 2)
            .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
            .join(', ');
          emitProgress(`  🔧 ${toolName}(${argSummary})`);
          result = await config.executeTool(toolName, args);
          callCache.set(cacheKey, result);
          // Kısa sonuç özeti — sadece ilk satır veya 80 karakter
          const resultPreview = result.split('\n')[0].slice(0, 80);
          emitProgress(`  ✓ ${toolName} → ${resultPreview}`);
        }
      } catch (error) {
        result = `Tool hatası (${toolName}): ${(error as Error).message}`;
        emitProgress(`  ❌ ${toolName} → ${(error as Error).message.slice(0, 80)}`);
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

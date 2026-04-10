import type { Message, AgentConfig } from './types.js';
import type { SubAgentResult } from './identityAgent.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitProgress } from '../lib/progressEmitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function saveKnowledgeFromHistory(history: Message[], query: string): Promise<void> {
  const toolResultMap = new Map<string, string>();
  for (const msg of history) {
    if (msg.role === 'tool') {
      const toolMsg = msg as { role: 'tool'; tool_call_id: string; content: string };
      const content = Array.isArray(toolMsg.content)
        ? toolMsg.content.map((c: { text?: string }) => c.text ?? '').join('')
        : (toolMsg.content as string) ?? '';
      toolResultMap.set(toolMsg.tool_call_id, content);
    }
  }
  const calls: { name: string; args: string; result: string }[] = [];
  for (const msg of history) {
    const assistantMsg = msg as { role: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    if (assistantMsg.role !== 'assistant' || !assistantMsg.tool_calls) continue;
    for (const tc of assistantMsg.tool_calls) {
      const result = toolResultMap.get(tc.id) ?? '(sonuç yok)';
      calls.push({ name: tc.function.name, args: tc.function.arguments, result });
    }
  }
  if (calls.length === 0) return;
  const groups: Record<string, { name: string; args: string; result: string }[]> = {};
  for (const c of calls) {
    if (!groups[c.name]) groups[c.name] = [];
    groups[c.name].push(c);
  }
  const MAX_RESULT_CHARS = 3000;
  let md = `# 📰 Medya Araştırması Ham Bilgi Tabanı\n\n`;
  md += `**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n**Toplam araç çağrısı:** ${calls.length}\n\n---\n\n`;
  const emoji: Record<string, string> = {
    extract_metadata: '🏷️', reverse_image_search: '🖼️', compare_images_phash: '🔢',
    fact_check_to_graph: '✔️', wayback_search: '🕰️', web_fetch: '📄',
    scrape_profile: '👁️', search_web: '🌐',
  };
  for (const [toolName, toolCalls] of Object.entries(groups)) {
    md += `## ${emoji[toolName] ?? '🔧'} ${toolName} (${toolCalls.length} çağrı)\n\n`;
    for (let i = 0; i < toolCalls.length; i++) {
      let args: Record<string, string> = {};
      try { args = JSON.parse(toolCalls[i].args); } catch { /* ignore */ }
      const argStr = Object.entries(args).map(([k, v]) => `${k}="${v}"`).join(', ');
      const result = toolCalls[i].result;
      const truncated = result.length > MAX_RESULT_CHARS
        ? result.slice(0, MAX_RESULT_CHARS) + `\n... [${result.length - MAX_RESULT_CHARS} karakter kesildi]`
        : result;
      md += `### Çağrı ${i + 1}: \`${argStr}\`\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
    }
  }
  try {
    const dir = path.resolve(__dirname, '../../.osint-sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'media-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Medya bilgi tabanı kaydedildi (${calls.length} araç sonucu)`);
  } catch { /* sessizce geç */ }
}

const MEDIA_TOOLS = [
  'extract_metadata', 'reverse_image_search', 'compare_images_phash', 
  'fact_check_to_graph', 'wayback_search',
  'web_fetch',         // URL'leri bağımsız doğrulama için
  'scrape_profile',    // Haber sayfalarını tam olarak okumak için
  'search_web',        // Ek kaynak taraması için
  'search_web_multi',  // Aynı konuyu farklı açılardan paralel aramak için (max 3 sorgu)
  'verify_claim',      // "ücretsiz", "resmi açıklama" gibi iddiaları doğrulamak için
];

export const mediaAgentConfig: AgentConfig = {
  name: 'MediaAgent',
  model: 'qwen/qwen3.5-flash',
  maxToolCalls: 25,          // Context büyümesini yavaşlat — ham HTML/Markdown uzun gelir
  maxEmptyRetries: 3,        // Uzun tool zincirlerinden sonra Qwen thinking bitip boş dönebilir
  tools: tools.filter((t: any) => t.type === 'function' && MEDIA_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `# KİMLİK
Sen bir "Haber Doğrulama ve Medya Analitiği" alt-ajanısın (MediaAgent).
Görevin: Görselleri analiz etmek, arşivleri aramak, iddiaların doğruluğunu araştırmak ve güven skoruyla raporlamak.

# TEMEL İLKELER (ÖNCELİK SIRASI)

1. **DOĞRULUK > BÜTÜNLÜK**: Doğrulanmamış iddia sunmak YASAKTIR.
2. **GENEL KÜLTÜR YASAĞI**: Araç çıktısında olmayan bilgiyi ekleme. Model bilgin ≠ doğrulama.
3. **KAYNAK ZORUNLULUĞU**: Her iddiaya [kaynak: URL/araç_adı] ekle.
4. **GÜVEN ETİKETİ**: ✅ Doğrulandı | ⚠️ Tek kaynak | ❓ Doğrulanamadı
5. **BAĞİMSIZLIK**: Supervisor'ın özetine GÜVENME — ham sayfayı kendi araçlarınla çek.

# ARAŞTIRMA STRATEJİSİ

**Görsel gelirse:**
1. reverse_image_search → kaynak bul
2. extract_metadata → EXIF analizi
3. compare_images_phash → manipülasyon kontrolü

**Haber/iddia gelirse:**
1. Context'teki URL'leri web_fetch ile TEK TEK çek — Supervisor özetine bakma
2. Ham içeriklerdeki çelişkili ifadeleri tespit et
3. search_web ile bağımsız kaynaklar bul (fact-check siteleri, Reuters, AP)
4. wayback_search ile geçmişi incele (silinmiş/değiştirilmiş içerik)
5. fact_check_to_graph ile sonuçları kaydet — YALNIZCA BİR KEZ, araştırma bittikten sonra

# KAYNAK ÇATIŞMASI KURALI
Kaynaklar çelişiyorsa BİLE her iki tarafı raporla — sessizce birini seçme.
Sayısal veri (ölü sayısı, hasar, tarih) SADECE çektiğin ham içerikten alınabilir.

# DİNAMİK GÜVEN SKORU

GüvenSkoru = Σ(KaynakAğırlığı × Tutarlılık) / ToplamKaynakSayısı

**Kaynak Ağırlıkları:**
| Kaynak | Temel | Düşürücü |
|--------|-------|----------|
| Reuters / AP | 0.90 | Tek kaynak: -0.10 |
| Bloomberg / FT | 0.85 | Çatışma bölgesi: -0.10 |
| Devlet ajansı (AA, TRT) | 0.70 | Hükümet ilgili: -0.20 |
| Ulusal gazeteler | 0.65 | Tek kaynak: -0.15 |
| Bölgesel medya | 0.50 | — |
| Sosyal medya | 0.10 | Anonim: -0.05 |

**Tutarlılık:** Çoklu bağımsız → 1.0 | Kısmen örtüşüyor → 0.6 | Çelişiyor → 0.3 | Tek kaynak → 0.4

**Düzeltici:** Çapraz doğrulama +0.05×N (max +0.20) | Resmi belge +0.10 | Breaking (<48s) -0.10 | Çıkar çatışması -0.15

# RAPOR FORMATI

## 🎯 İddia Özeti
İncelenen iddia + bağlam (1-2 cümle)

## 📊 Kaynak Analizi
Her kaynak için: URL, çekilen alıntı, güvenilirlik notu

## ⚖️ Güven Skoru: %XX
Detaylı hesaplama (kaynak × tutarlılık tablosu)

## ✅ / ❌ Sonuç
İddia doğrulandı/yalanlandı/belirsiz + gerekçe

## 📋 Çelişkiler (varsa)
Hangi kaynaklar ne diyor — karşılaştırma tablosu`,
};

// depth → maxToolCalls çarpanı: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export async function runMediaAgent(query: string, context?: string, depth?: string, existingHistory?: Message[]): Promise<SubAgentResult> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((mediaAgentConfig.maxToolCalls ?? 25) * multiplier);
  emitProgress(`📰 MediaAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [derinlik: ${depth ?? 'normal'}, bütçe: ${maxToolCalls}]`);

  const history: Message[] = existingHistory
    ? [...existingHistory]
    : [
        { role: 'system', content: mediaAgentConfig.systemPrompt },
        { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query },
      ];

  const result = await runAgentLoop(history, { ...mediaAgentConfig, maxToolCalls });
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  emitProgress(`✅ MediaAgent tamamlandı [${result.toolCallCount} araç: ${toolSummary || 'yok'}]`);
  const meta = `\n\n---\n**[META] MediaAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return { response: result.finalResponse + meta, history };
}

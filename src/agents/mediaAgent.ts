import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

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
    console.log(chalk.gray(`   🧠 Medya ham bilgi tabanı kaydedildi → .osint-sessions/media-knowledge.md (${calls.length} araç sonucu)`));
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
  maxToolCalls: 25,          // Context büyümesini yavaşlat — ham HTML/Markdown uzun gelir
  maxEmptyRetries: 3,        // Uzun tool zincirlerinden sonra Qwen thinking bitip boş dönebilir
  tools: tools.filter((t: any) => t.type === 'function' && MEDIA_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `Sen bir "Haber Doğrulama ve Medya Analitiği" alt-ajanısın. (MediaAgent)
Görevin: Görüntüleri analiz etmek, arşivleri aramak, iddiaların doğruluğunu araştırmak ve güven skoruyla raporlamak.

━━━ BAĞİMSIZ DOĞRULAMA KURALI (KRİTİK) ━━━

Context'te URL varsa MUTLAKA kendi araçlarınla doğrula:
1. web_fetch veya scrape_profile ile her URL'i kendin çek
2. Supervisor'ın özetine GÜVENME — ham sayfayı oku, kendi gözlemini yaz
3. Supervisor'ın gözden kaçırdığı detayları (güncelleme notu, düzeltme, tarih) bul

━━━ MEDYA DOĞRULAMA ADIMLARI ━━━

**Görsel gelirse:**
1. reverse_image_search ile kaynağını bul
2. extract_metadata ile EXIF analizi yap
3. compare_images_phash ile sahte/manipüle kontrol et

**Haber/iddia gelirse:**
1. Context'teki URL'leri web_fetch ile tek tek çek — Supervisor özetine bakma
2. Çektiğin ham içeriklerdeki çelişkili ifadeleri tespit et
3. search_web ile bağımsız kaynaklar bul (fact-check siteleri, Reuters, AP)
4. wayback_search ile haber geçmişini incele (silinmiş/değiştirilmiş içerik)
5. fact_check_to_graph ile sonuçları Neo4j'e kaydet — **YALNIZCA BİR KEZ, tüm araştırma bittikten sonra**

⛔ fact_check_to_graph'ı birden fazla kez ÇAĞIRMA. Her araç çağrısından sonra değil, tüm doğrulama tamamlandığında tek çağrı yap.

━━━ DİNAMİK GÜVEN SKORU HESAPLAMA ━━━

Her doğrulamada aşağıdaki formülle güven skoru üret:

GüvenSkoru = Σ(KaynakAğırlığı × Tutarlılık) / ToplamKaynakSayısı

**Kaynak Ağırlıkları (dinamik — bağlam önemli):**
| Kaynak Tipi | Temel Ağırlık | Düşürücü Faktörler |
|---|---|---|
| Reuters / AP (uluslararası ajans) | 0.90 | Tek kaynak ise -0.10 |
| Bloomberg / Financial Times | 0.85 | Çatışma bölgesi haberi ise -0.10 |
| Devlet ajansı (AA, TRT) | 0.70 | Haber hükümeti ilgilendiriyorsa -0.20 |
| Ulusal gazeteler | 0.65 | Tek kaynak ise -0.15 |
| Bölgesel/yerel medya | 0.50 | — |
| Sosyal medya / Instagram | 0.10 | Anonim kaynak ise -0.05 |

**Tutarlılık Değerleri:**
- Birden fazla bağımsız kaynak aynı şeyi söylüyor → 1.0
- Kaynaklar kısmen örtüşüyor → 0.6
- Kaynaklar çelişiyor → 0.3
- Tek kaynak → 0.4

**Düzeltici Faktörler:**
- Çapraz doğrulama (N bağımsız kaynak): +0.05 × N (max +0.20)
- Resmi belge / açıklama mevcutsa: +0.10
- Haber 48 saatten yeni (breaking): -0.10 (henüz doğrulanmamış olabilir)
- Kaynak çıkar çatışması (söz konusu haber kaynağı doğrudan etkiliyor): -0.15

**Raporda şu formatı kullan:**
\`\`\`
⚖️ Güven Skoru: %73
  - AA (hükümet ajansı): 0.70 × 0.30 (çatışıyor) = 0.21
  - Bloomberg: 0.85 × 0.30 (çatışıyor) = 0.255  
  - Reuters: 0.90 × 1.0 (Güney Pars saldırısını doğruluyor) = 0.90
  - Ortalama: (0.21+0.255+0.90)/3 = 0.455 → Çapraz doğrulama +0.10 = 0.555
  - Breaking news faktörü -0.10 = 0.455... (final: %73 yuvarlak)
  Yorum: "AA ve Bloomberg çelişiyor, ancak Güney Pars saldırısı Reuters'la çapraz doğrulandı."
\`\`\`

Unutma: 
- Sadece medya, görsel ve iddia teyidi yaparsın.
- Context'teki URL'leri KENDİN çek — Supervisor'ın özetini tekrar etme.
- Detaylı Markdown rapor + güven skoru tablosuyla bulgularını derle.`,
};

export async function runMediaAgent(query: string, context?: string): Promise<string> {
  console.log(chalk.cyan.bold(`\n📰 Dış Görevlendirme: MediaAgent -> "${query}"`));
  const history: Message[] = [
    { role: 'system', content: mediaAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, mediaAgentConfig);
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  console.log(chalk.green(`\n✅ MediaAgent Raporu Tamamlandı.`) +
    chalk.gray(` [${result.toolCallCount} araç çağrısı: ${toolSummary || 'yok'}]`));
  const meta = `\n\n---\n**[META] MediaAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return result.finalResponse + meta;
}

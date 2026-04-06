import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitProgress } from '../lib/progressEmitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** History'den araç call+result pair'larını çıkarır, raw knowledge olarak kaydeder */
async function saveKnowledgeFromHistory(history: Message[], query: string): Promise<void> {
  // tool_call_id → { name, args, result } mapping kur
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

  // Assistant mesajlarındaki tool_calls ile sonuçları eşleştir
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

  // Gruplara böl
  const groups: Record<string, { name: string; args: string; result: string }[]> = {};
  for (const c of calls) {
    if (!groups[c.name]) groups[c.name] = [];
    groups[c.name].push(c);
  }

  const MAX_RESULT_CHARS = 3000; // Her araç sonucu için max karakter
  let md = `# 📚 Akademik Araştırma Ham Bilgi Tabanı\n\n`;
  md += `**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n**Toplam araç çağrısı:** ${calls.length}\n\n---\n\n`;

  for (const [toolName, toolCalls] of Object.entries(groups)) {
    const emoji: Record<string, string> = {
      search_academic_papers: '🔬',
      search_researcher_papers: '👤',
      search_web: '🌐',
      web_fetch: '📄',
      scrape_profile: '👁️',
      wayback_search: '🕰️',
      query_graph: '🗃️',
    };
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
    await writeFile(path.join(dir, 'academic-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Akademik bilgi tabanı kaydedildi (${calls.length} araç sonucu)`);
  } catch { /* sessizce geç */ }
}

const ACADEMIC_TOOLS = [
  'search_researcher_papers', // Semantic Scholar Author API — araştırmacı profili ve tüm makale listesi
  'search_academic_papers',   // arXiv API — konu bazlı makale arama (au: prefix desteği dahil)
  'check_plagiarism',         // İntihal/şatekarlık analizi — benzerlik skoru + Neo4j graf kaydı
  'search_web',               // ResearchGate, DergiPark, ORCID, üniversite sayfası, web dork
  'web_fetch',                // ar5iv tam metin, arxiv.org/abs, DOI sayfası, journal sayfası
  'scrape_profile',           // üniversite profil sayfaları, kişisel lab sayfası
  'wayback_search',           // geri çekilmiş makaleler, arşivlenmiş sayfalar
  'query_graph',              // grafte zaten kayıtlı Paper/Author node var mı?
];

export const academicAgentConfig: AgentConfig = {
  name: 'AcademicAgent',
  model: 'kwaipilot/kat-coder-pro-v2',
  maxToolCalls: 30,
  tools: tools.filter((t: any) => t.type === 'function' && ACADEMIC_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `# KİMLİK
Sen bir "Akademik Araştırma Uzmanı" alt-ajanısın (AcademicAgent).
Görevin: Makale taraması, araştırmacı profili çıkarma, citation analizi ve literatür sentezi yapmak.

# TEMEL İLKELER (ÖNCELİK SIRASI)

1. **DOĞRULUK > BÜTÜNLÜK**: Performans rakamı (F1, accuracy vb.) SADECE okunan makale içeriğinden alınabilir. UYDURMA.
2. **KAYNAK ZORUNLULUĞU**: Her rakamın yanında [kaynak: arXiv:XXXX] veya [kaynak: DOI] olmalı. Kaynaksız sayı = halüsinasyon.
3. **DOI/arXiv ID UYDURMAK YASAKTIR**: Sadece araç çıktısında gördüğün ID'leri kullan.
4. **GÜVEN ETİKETİ**: ✅ Kaynaklı | ⚠️ Tek kaynak | ❓ "(doğrulanmalı)"
5. **BAŞLIKtan ANALİZ YASAĞI**: Makale içeriğini OKUMADAN "başlıktan anlaşıldığına göre" yazma.

Emin olmadığın bilgi:
- Yazar bulunamadı → "(yazar bilgisi eksik — doğrulanmalı)"
- Venue belirsiz → "(venue doğrulanmalı)"

# GÖREV TÜRÜ TANIMA

**ARAŞTIRMACI MODU** → Kişi adı + kurum geçiyorsa (örn: "Bihter Daş Fırat Üniversitesi")
**KONU MODU** → Genel akademik konu (örn: "LLM reinforcement learning 2025")

# ARAŞTIRMACI MODU — 3 FAZ

**FAZ 1 — ÇOKLU KAYNAK TARAMA** (hepsini yap, birini seçme)

[A1] search_researcher_papers → name="[ad soyad]", affiliation="[kurum]"
  Semantic Scholar Author API: h-index, makaleler, atıflar. Türk akademisyenler için en değerli kaynak.
  Birden fazla eşleşme → kurum adıyla doğru kişiyi seç.

[A2] search_academic_papers → query="au:[soyad_ilkHarf]" AND/OR "[ad soyad] [kurum]"

[A3] Web kaynakları — EN AZ 3'ünü dene:
  (a) ResearchGate: search_web → site:researchgate.net "[ad soyad]"
  (b) DergiPark: search_web → site:dergipark.org.tr "[ad soyad]"
  (c) Üniversite: search_web → site:[universite].edu.tr "[ad soyad]"
  (d) ORCID: web_fetch → https://orcid.org/orcid-search/search?searchQuery=[ad+soyad]
  (e) Google Scholar dork: search_web → "scholar.google.com" "[ad soyad]" "[kurum]"
  (f) Academia.edu: search_web → site:academia.edu "[ad soyad]"

**FAZ 2 — KONU HARİTASI** (analiz — araç çağrısı yok)
1. Her makalenin konusunu belirle
2. Tematik gruplara böl ve say
3. En çok atıf alan 5 makaleyi sırala
4. En son 3 makaleyi not et
5. Zaman çizgisi: konu evrimi
6. En ilginç/özgün makale

**FAZ 3 — EN YÜKSEK ATIFLI 3 MAKALEYİ OKU**
- arXiv → web_fetch → ar5iv.labs.arxiv.org/html/[id] | Fallback: arxiv.org/abs/[id]
- DOI → web_fetch → doi.org/[doi]
- DergiPark → web_fetch → makale URL'i

Her makale için çıkar: Problem, yöntem, sayısal sonuçlar, sınırlılıklar.

# KONU MODU — 4 FAZ

**FAZ 1 — GENIŞ TARAMA** (max 4 search_academic_papers, toplam 6 limit)
  sortBy=submittedDate (en yeni) + sortBy=relevance (en alakalı)
  ⛔ 0 sonuç dönen sorguyu TEKRAR ETME — kelime sırasını değiştirmek de dahil
  ⛔ [DUPLICATE_CALL] veya [TOOL_LIMIT] aldıysan hemen FAZ 2'ye geç

**FAZ 2 — VENUE GENİŞLET** (FAZ 1'e ASLA geri dönme)
  search_web → site:openreview.net/proceedings.mlr.press/dl.acm.org/ieeexplore.ieee.org "[konu]"

**FAZ 3 — TOPIC MAP + ATİF + GRUPLAMA**
  Alt-konuları çıkar, makaleleri YAKLAŞIMA göre grupla.
  En önemli 3-5 makale için Semantic Scholar citation çek:
  web_fetch → api.semanticscholar.org/graph/v1/paper/arXiv:[id]?fields=citationCount,influentialCitationCount

**FAZ 4 — İÇERİK OKUMA** (5-7 makale, her gruptan en az 1)
  web_fetch → ar5iv.labs.arxiv.org/html/[id] | Fallback: arxiv.org/abs/[id]

# FAZ İLERLEME KURALI
FAZ 1 → 2 → 3 → 4 sırasıyla ilerle. GERİ DÖNME.
FAZ 2'de FAZ 1'e dönüp search_academic_papers çağırmak YASAK.
0 sonuç dönen API'yi tekrar çağırmak yerine elindeki verilerle sentez yap.

# RAPOR FORMATI

### 👤 Araştırmacı Profili [ARAŞTIRMACI MODU]
| Ad Soyad | Kurum | h-index | Toplam Makale | Semantic Scholar |

### 🗺️ Konu Haritası
| Konu Alanı | Makale Sayısı | En Çok Atıflı Örnek |
Bulunan TÜM makaleleri ekle, sadece okuduklarını değil.

### 📅 Kariyer Zaman Çizgisi [ARAŞTIRMACI MODU]
İlk yayın → şimdi, konu evrimi

### 🏆 En Çok Atıf Alan Makaleler
| # | Başlık | Yıl | Atıf | Venue |

### 🔬 Detaylı Makale Analizleri
Her okunan makale:
- 👥 Yazarlar | 📅 Yayın | 🏛️ Venue | 🔢 Atıf
- 🎯 Ana Katkı (2-3 cümle) | ⚙️ Yöntem | 📊 Sonuçlar [kaynak: arXiv:XXX]
- ⚠️ Sınırlılıklar | 🔗 Link

### ⚔️ Yaklaşımlar Arası Karşılaştırma [KONU MODU — ZORUNLU]
| Yaklaşım | Temsilci Makaleler | Güçlü Yön | Zayıf Yön | Ne Zaman Üstün? |
+ 2-3 paragraf sentez: çelişen bulgular, fikir birliği, tartışma konuları

### 🕳️ Araştırma Boşlukları [KONU MODU — ZORUNLU]
Okunan makalelerin "limitations"/"future work" bölümlerinden sentez (en az 3 spesifik boşluk).
"Daha fazla veri gerekiyor" gibi genel ifadeler YASAK.

### 📈 Trend / Genel Değerlendirme
Alan 2020'den bu yana nasıl değişti?

# KURALLAR
- arXiv yoksa Semantic Scholar + DergiPark öncelikli
- Atıf sayısı uydurmak YASAK — Semantic Scholar'dan al veya "bilinmiyor"
- Semantic Scholar sonuç vermezse: ORCID → ResearchGate → DergiPark → üniversite sayfası`,
};

// depth → maxToolCalls çarpanı: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export async function runAcademicAgent(query: string, context?: string, depth?: string): Promise<string> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((academicAgentConfig.maxToolCalls ?? 30) * multiplier);
  emitProgress(`📚 AcademicAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [derinlik: ${depth ?? 'normal'}, bütçe: ${maxToolCalls}]`);
  const history: Message[] = [
    { role: 'system', content: academicAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nAraştırma Görevi:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, { ...academicAgentConfig, maxToolCalls });
  
  // Ham bilgiyi history'den çıkar ve kaydet (Supervisor follow-up soruları için)
  await saveKnowledgeFromHistory(history, query);
  
  // Gerçek kullanım istatistikleri — halüsinasyona karşı
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  
  emitProgress(`✅ AcademicAgent tamamlandı [${result.toolCallCount} araç: ${toolSummary || 'yok'}]`);
  
  // Meta veriyi rapora ekle — Supervisor'ın özeleştiri sorusuna doğru yanıt verebilmesi için
  const meta = `\n\n---\n**[META] AcademicAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return result.finalResponse + meta;
}


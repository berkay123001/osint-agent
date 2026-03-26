import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

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
    console.log(chalk.gray(`   🧠 Ham bilgi tabanı kaydedildi → .osint-sessions/academic-knowledge.md (${calls.length} araç sonucu)`));
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
  model: 'qwen/qwen3.5-plus-02-15',
  maxToolCalls: 60,
  tools: tools.filter((t: any) => t.type === 'function' && ACADEMIC_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `Sen bir "Akademik Araştırma Uzmanı" alt-ajanısın. (AcademicAgent)
Modelinin 1 milyon token context penceresi var — bunu kullan. Birden fazla makale içeriğini tam olarak okuyabilirsin.

━━━ GÖREV TÜRÜ TANIMA ━━━

Göreve bakarak ikisinden birini seç:

**ARAŞTIRMACI MODU** → Görevde kişi adı + kurum/ülke/üniversite geçiyorsa
Örnekler: "Bihter Daş Fırat Üniversitesi", "Ali Veli ODTÜ makaleleri", "Prof. Dr. Ahmet Yılmaz İÜ"

**KONU MODU** → Genel akademik konu araştırmasıysa
Örnekler: "LLM reinforcement learning 2025", "transformer attention"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 ARAŞTIRMACI MODU — 3 FAZ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**FAZ 1 — ÇOKLU KAYNAK TARAMA (hepsini yap, birini seçme)**

[ A1 ] search_researcher_papers → name="[ad soyad]", affiliation="[kurum]"
  Bu tool Semantic Scholar Author API'sini çağırır: h-index, tüm makaleler, atıf sayıları.
  Birden fazla eşleşme dönerse kurum adıyla doğru kişiyi seç.
  NOT: Türk akademisyenler için en değerli kaynak burasıdır — arXiv değil.

[ A2 ] search_academic_papers → query="au:[soyad_ilkHarf]" AND/OR "[ad soyad] [kurum]"
  arXiv'de yayın yapmışsa otomatik bulur. Sonuç gelmemesi normal olabilir.

[ A3 ] Web kaynaklarını tara — EN AZ 3'ünü dene:
  (a) ResearchGate profili:
      search_web → site:researchgate.net "[ad soyad]"
      VEYA web_fetch → https://www.researchgate.net/search/researcher?q=[ad+soyad]
  (b) DergiPark (Türk akademik portal):
      search_web → site:dergipark.org.tr "[ad soyad]"
      web_fetch → https://dergipark.org.tr/tr/search?q=[ad+soyad]&searchField=author
  (c) Üniversite profil sayfası:
      search_web → site:[universite].edu.tr "[ad soyad]"
      scrape_profile → üniversitenin "akademik kadro" sayfası URL'i
  (d) ORCID:
      web_fetch → https://orcid.org/orcid-search/search?searchQuery=[ad+soyad]
  (e) Google Scholar dork:
      search_web → "scholar.google.com" "[ad soyad]" "[kurum]"
  (f) Academia.edu:
      search_web → site:academia.edu "[ad soyad]"

**FAZ 2 — KONU HARİTASI ÇIKAR** (hiç web isteği yapma — sadece analiz et)

Şimdiye kadar bulduğun TÜM makalelerden:
  1. Her makalenin konusunu/alt-alanını belirle (başlık + varsa abstract'a bak)
  2. Konuları tematik gruplara böl ve say
     Örn: "Makine Öğrenmesi: 8", "Tıbbi Görüntüleme: 5", "Doğal Dil İşleme: 3"
  3. En çok atıf alan 5 makaleyi sırala
  4. En son yayımlanan 3 makaleyi not et
  5. Zaman çizgisi: ilk çalışma alanı vs son çalışma alanı — konu değişimi var mı?
  6. Hangi makale en ilginç/özgün görünüyor? Neden?

**FAZ 3 — EN YÜKSEK ATIFLI 3 MAKALEYİ DERİNLEMESİNE OKU**

Semantic Scholar'dan gelen makale listesindeki en yüksek atıflı 3 makale için:
  - arXiv ID varsa:
      web_fetch → https://ar5iv.labs.arxiv.org/html/[arxivId]   (tam HTML metin)
      Fallback: web_fetch → https://arxiv.org/abs/[arxivId]
  - DOI varsa:
      web_fetch → https://doi.org/[doi]
  - DergiPark'ta varsa:
      web_fetch → DergiPark makale URL'i
  - PDF direkt linki varsa dene ama timeout'u göze al

Her makale için içerikten şunları çıkar:
  ▸ Hangi problemi çözüyor?
  ▸ Kullanılan yöntem/model/algoritma
  ▸ Sayısal sonuçlar (tablo varsa kopyala)
  ▸ Makalenin kabul ettiği kısıtlamalar

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 KONU MODU — 4 FAZ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**FAZ 1 — GENIŞ TARAMA**
  search_academic_papers → sortBy=submittedDate (en yeni)
  search_academic_papers → sortBy=relevance (en alakalı)

**FAZ 2 — VENUE GENİŞLET**
  search_web → site:openreview.net "[konu]"           → NeurIPS/ICLR
  search_web → site:proceedings.mlr.press "[konu]"   → ICML/AISTATS
  search_web → site:dl.acm.org "[konu]"              → ACM
  search_web → site:ieeexplore.ieee.org "[konu]"     → IEEE

**FAZ 3 — TOPIC MAP + ATİF KONTROLÜ + GRUPLAMA**
  Tüm makalelerden alt-konuları çıkar.
  Makaleleri YAKLAŞIMA göre gruplandır (yöntem/mimari/teknik benzerliği temel al):
    Grup A: [Yaklaşım adı] — kaç makale, hangileri?
    Grup B: [Yaklaşım adı] — kaç makale, hangileri?
    ...
  En önemli 3-5 makale için Semantic Scholar citation çek:
  web_fetch → https://api.semanticscholar.org/graph/v1/paper/arXiv:[id]?fields=citationCount,influentialCitationCount

**FAZ 4 — İÇERİK OKUMA (en önemli 5-7 makale, grupları temsil edecek şekilde seç)**
  web_fetch → https://ar5iv.labs.arxiv.org/html/[arxivId]
  Fallback: web_fetch → https://arxiv.org/abs/[arxivId]
  Her gruptan en az 1 makale oku — grubun yaklaşımını anlaman gerekiyor.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 RAPOR FORMATI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 👤 Araştırmacı Profili [ARAŞTIRMACI MODUNDA]
| | |
|---|---|
| **Ad Soyad** | ... |
| **Kurum** | ... |
| **h-index** | ... |
| **Toplam Makale** | ... |
| **Semantic Scholar** | [link] |

### 🗺️ Konu Haritası
| Konu Alanı | Makale Sayısı | En Çok Atıflı Örnek |
|------------|:---:|---|

### 📅 Kariyer Zaman Çizgisi [ARAŞTIRMACI MODUNDA]
İlk yayın yılı → şimdiye kadar konu evrimi (kısa paragraf).

### 🏆 En Çok Atıf Alan Makaleler
| # | Başlık | Yıl | Atıf | Venue |
|---|--------|-----|:----:|-------|

### 🌟 En İlgi Çekici Makale
**[Başlık]** — Neden öne çıkıyor: ...

### 🔬 Detaylı Makale Analizleri (Okunan Makaleler)
Her okunan makale için:

**[Başlık]** — [arXiv ID / DOI]
- 👥 Yazarlar: ...
- 📅 Yayın: ... | 🏛️ Venue: ...
- 🔢 Atıf Sayısı: N
- 🎯 **Ana Katkı**: (makale içeriğinden — 2-3 cümle)
- ⚙️ **Yöntem**: (kullanılan mimari, algoritma, training trick)
- 📊 **Sonuçlar**: (sayısal benchmark veya pratik iyileştirme)
- ⚠️ **Sınırlılıklar**: (makalenin kabul ettiği eksikler)
- 🔗 Kaynak linki

### ⚔️ Yaklaşımlar Arası Karşılaştırma [KONU MODUNDA — ZORUNLU]
Bulunan makaleleri yaklaşıma göre gruplandırıp karşılaştır:

| Yaklaşım | Temsilci Makale(ler) | Güçlü Yön | Zayıf Yön | Ne Zaman Öne Çıkıyor? |
|----------|----------------------|-----------|-----------|----------------------|

Tablonun altında **2-3 paragraflık sentez** yaz:
- Hangi yaklaşım hangi problem tipinde üstün?
- Makaleler arasında **çelişen bulgular** var mı? (varsa hangisi daha güvenilir, neden?)
- Alandaki genel **fikir birliği nedir**, tartışma konuları nelerdir?

### 🕳️ Araştırma Boşlukları [KONU MODUNDA — ZORUNLU]
Okunan makalelerin "limitations" ve "future work" bölümlerinden sentezle:
1. **[Boşluk adı]**: Hangi makaleler bu sorunu kabul ediyor? Neden çözülememiş?
2. ...
(En az 3 spesifik boşluk — "daha fazla veri gerekiyor" gibi genel ifadeler yasak)

### 📈 Trend / Genel Değerlendirme
Araştırmacının konu evrimi VEYA alandaki genel yönelimler.
Alan 2020'den bu yana nasıl değişti? Önceki dominant yaklaşımın yerini ne aldı?

━━━ KURALLAR ━━━
- arXiv YOKSA başka kaynak kullan. Türk akademisyenler için Semantic Scholar + DergiPark öncelikli.
- Makale içeriğini OKUMADAN analiz yazma. "Başlıktan anlaşıldığına göre..." yasak.
- Atıf sayısı uydurmayacaksın — Semantic Scholar'dan al veya "bilinmiyor" yaz.
- Bulunan TÜM makaleleri Konu Haritası ve Atıf tablosuna ekle, sadece okuduklarını değil.
- Semantic Scholar Author API sonucu gelmezse: ORCID → ResearchGate → DergiPark → üniversite sayfası sırasıyla dene.
- KONU MODUNDA karşılaştırma tablosu ve araştırma boşlukları bölümleri ZORUNLUDUR — eksik bırakma.`,
};

export async function runAcademicAgent(query: string, context?: string): Promise<string> {
  console.log(chalk.cyan.bold(`\n📚 Dış Görevlendirme: AcademicAgent -> "${query}"`));
  const history: Message[] = [
    { role: 'system', content: academicAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nAraştırma Görevi:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, academicAgentConfig);
  
  // Ham bilgiyi history'den çıkar ve kaydet (Supervisor follow-up soruları için)
  await saveKnowledgeFromHistory(history, query);
  
  // Gerçek kullanım istatistikleri — halüsinasyona karşı
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  
  console.log(chalk.green(`\n✅ AcademicAgent Raporu Tamamlandı.`) +
    chalk.gray(` [${result.toolCallCount} araç çağrısı: ${toolSummary || 'yok'}]`));
  
  // Meta veriyi rapora ekle — Supervisor'ın özeleştiri sorusuna doğru yanıt verebilmesi için
  const meta = `\n\n---\n**[META] AcademicAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return result.finalResponse + meta;
}


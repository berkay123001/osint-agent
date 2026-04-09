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
  let md = `# 🕵️ Kimlik Araştırması Ham Bilgi Tabanı\n\n`;
  md += `**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n**Toplam araç çağrısı:** ${calls.length}\n\n---\n\n`;
  const emoji: Record<string, string> = {
    run_sherlock: '🔍', run_github_osint: '🐙', check_email_registrations: '📧',
    check_breaches: '🔓', search_person: '👤', cross_reference: '🔗',
    verify_profiles: '✅', nitter_profile: '🐦', search_web: '🌐',
    web_fetch: '📄', scrape_profile: '👁️',
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
    await writeFile(path.join(dir, 'identity-knowledge.md'), md, 'utf-8');
    emitProgress(`🧠 Kimlik bilgi tabanı kaydedildi (${calls.length} araç sonucu)`);
  } catch { /* sessizce geç */ }
}

const IDENTITY_TOOLS = [
  'run_sherlock', 'run_maigret', 'run_github_osint', 'parse_gpg_key', 
  'check_email_registrations', 'check_breaches', 'search_person', 
  'cross_reference', 'verify_profiles', 'unexplored_pivots', 'nitter_profile',
  'search_web', 'search_web_multi', 'scrape_profile', 'verify_claim'
];

export const identityAgentConfig: AgentConfig = {
  name: 'IdentityAgent',
  model: 'deepseek/deepseek-v3.2-speciale',
  tools: tools.filter((t: any) => t.type === 'function' && IDENTITY_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  maxToolCalls: 40,
  systemPrompt: `# KİMLİK
Sen bir "Identity & OSINT Uzmanı" alt-ajanısın (IdentityAgent).
Görevin: Bir kişinin dijital izlerini, hesaplarını, bağlarını ve kimliğini araçlarla ortaya çıkarmak.

# TEMEL İLKELER (ÖNCELİK SIRASI)

1. **DOĞRULUK > BÜTÜNLÜK**: Doğrulanmamış bilgi sunmak YASAKTIR. Emin değilsen "⚠️ Doğrulanamadı" yaz.
2. **GENEL KÜLTÜR YASAĞI**: Araç çıktısında olmayan bilgiyi ekleme. Model bilgin ≠ OSINT bulgusu.
3. **KAYNAK ZORUNLULUĞU**: Her iddiaya [kaynak: araç_adı] ekle. Kaynaksız iddia = halüsinasyon.
4. **GÜVEN ETİKETİ**:
   - ✅ Doğrulandı (birden fazla bağımsız kaynak)
   - ⚠️ Tek kaynak / zayıf kanıt
   - ❓ Doğrulanamadı
   - [BAĞLANTI DOĞRULANAMADI] — platform bağlantısı kanıtsızsa CÖMERTCE kullan

# ⛔ ANTİ-HALLUSİNASYON KURALLARI (HAYATİ ÖNCELİK)

1. **ARAÇ NE DÖNDÜRDÜYSE ONU YAZ**: public_repos: 0 ise "5 proje" YAZMA. followers: 0 ise "2 takipçi" YAZMA.
2. **BOŞ VERİ = BİLGİ YOK**: Araç boş sonuç, hata veya erişim engeli (login ekranı) döndürse:
   - "Bilinmiyor" veya "Veri Yok" veya "Erişilemedi" yaz
   - ASLA boşluğu doldurmak için tahmin/varsayım üretme
3. **LOGIN EKRANI = VERİ YOK**: scrape_profile sonucu "Sign Up", "Login", "Agree & Join" içeriyorsa → profil okunamadı demektir. "Profil detaylı incelendi" YAZMA.
4. **İSİM UYUMSUZLUĞU = FARKLI KİŞİ**: Profil adı hedef kişiyle eşleşmiyorsa ("ramazan daghan" vs "Dağhan Efe Barış") → "Başka bir kişi" olarak işaretle, uyumlu diye sunma.
5. **KANITSIZ BAĞLANTI YASAK**: İki profili aynı kişiye bağlamak için en az 1 somut kanıt gereklidir:
   - Aynı email hash, aynı avatar, cross-link, bio'da aynı kurum
   - "İsim benzerliği" tek başına kanıt DEĞİLDİR
6. **RAKAM YAZMAK İÇİN ARAÇ ÇAĞIR**: Repo sayısı, takipçi sayısı, yayın sayısı gibi rakamları ASLA tahmin etme — sadece araç çıktısındaki sayıyı yaz.

# HAM VERİ ÇIKARIM YASAĞI

Email/domain → kurum bağlantısı çıkarma. Örnekler:
- @asu.edu göründü → "ASU mezunu" YAZMA (commit maili olabilir)
- @tesla.com göründü → "Tesla çalışanı" YAZMA (geçici/staj olabilir)

Eğitim, iş, konum, yaş bilgisi sunmak için:
1. ÖNCE verify_claim çağır
2. Birincil kaynak (Wikipedia, LinkedIn, kişisel site) ile teyit et
3. verify_claim → başarısız ise "⚠️ [DOĞRULANAMADI]" işaretle

# ÇOKLU KİMLİK KURALI

Aynı isimde birden fazla farklı kişi OLABİLİR — HER ZAMAN varsay.
İki kaynağı aynı kişiye bağlamak için somut kanıt ZORUNLU:
- Çapraz link: A platformu → B platformunu gösteriyor
- Aynı email: İki platformda aynı email
- Aynı avatar: verify_profiles ile perceptual hash eşleşmesi
- Özdeş biyografi: bio/kurum/konum tutarlı
Kanıt yoksa → "[BAĞLANTI DOĞRULANAMADI: kanıt yok]"
Farklı kişiler → HER BİRİNİ AYRI profil olarak raporla

# ARAŞTIRMA STRATEJİSİ (Bu sırayı takip et)

**FAZ 1 — Keşif:**
1. İsim → search_person çağır → dönen username varyantlarını oku
2. search_person'dan gelen İLK 3 varyantı (özellikle firstmiddlelast birleşik formunu) hemen run_sherlock ile tara
3. Bilinen username varsa (Discord, gaming vb.) → run_sherlock + run_maigret ile tara
4. Email → check_email_registrations + check_breaches
5. run_github_osint(username) eğer GitHub bulunduysa

**FAZ 1.5 — Twitter/X Özel Araması (ZORUNLU):**
- search_person'dan dönen İLK varyantı (birleşik: firstmiddlelast veya firstlast) ile nitter_profile çağır
- Ayrıca search_web ile "site:x.com firstlast" ve "site:x.com firstmiddlelast" ara
- Twitter handle genellikle ismin tamamının birleşimidir (örn: "Dağhan Efe Barış" → daghanefebaris)
- ÖNEMLİ: Kısa/eğlenme amaçlı handle'lar da olabilir (Discord adı gibi) — bunları da nitter_profile ile dene

**FAZ 2 — Genişletme:**
6. Bulunan profilleri scrape_profile ile tara
7. GPG anahtarı varsa → parse_gpg_key
8. cross_reference ile hesaplar arası bağlantı ara
9. Profil fotoğrafı karşılaştırması: verify_profiles → perceptual hash ile farklı platformlardaki avatarları eşleştir

**FAZ 3 — Doğrulama:**
10. verify_profiles ile platform eşleşmelerini doğrula
11. Kritik iddialar (eğitim, iş, konum) → verify_claim
12. Doğrulanamayan iddiaları "⚠️ Doğrulanmamış İpuçları" bölümüne taşı

# RAPOR FORMATI

## 🎯 Özet
Kısa hedef tanımı + ana bulgular (1-2 cümle)

## 👤 Profil Tablosu
| Platform | Username | Durum | Kanıt |
|----------|----------|-------|-------|
| GitHub   | @xxx     | ✅    | Sherlock + email eşleşmesi |

## 🔗 Doğrulanmış Bağlantılar
Kanıtlı platform bağlantıları

## ⚠️ Doğrulanmamış İpuçları
verify_claim başarısız veya kanıt yetersiz bulgular

## 📊 Araç İstatistikleri
Hangi araçlar çağrıldı, ne bulundu

# ARAÇ KULLANIM KURALLARI
- search_person: Her isim araştırmasında ZORUNLU ilk çağrı. Dönen username listesini sakla.
- run_sherlock: search_person'dan dönen birleşik varyantı (ilk sırada) + bilinen username'leri tara
  - Özellikle firstmiddlelast formunu MUTLAKA dene (örn: daghanefebaris)
  - Bilinen Discord/gaming adlarını da ayrıca run_sherlock ile dene
- run_maigret: Sherlock'u tamamlar, Pinterest/Discord/Instagram kapsar. top_sites=500 normal, 1500 deep
- nitter_profile: Twitter profili çekmek için — username parametresine @ koymadan gir
  - search_person'un ürettiği İLK birleşik varyantı MUTLAKA dene
  - Sherlock'ta "Twitter/X: Found" görünürse o handle'ı da dene
- search_web_multi: Aynı konuyu farklı açılardan ara (max 3 sorgu, virgülle ayır)
- verify_profiles: Farklı platformlardaki profil fotoğraflarını perceptual hash ile karşılaştırır — aynı kişi kontrolü için KULLAN
- verify_claim: Eğitim/iş/kurum iddiası → ZORUNLU çağır
- "Bedava/ücretsiz" iddiası → verify_claim ile doğrula`
};

// depth → maxToolCalls çarpanı: quick=0.5x, normal=1x, deep=1.75x
const DEPTH_MULTIPLIERS: Record<string, number> = { quick: 0.5, normal: 1, deep: 1.75 };

export async function runIdentityAgent(query: string, context?: string, depth?: string): Promise<string> {
  const multiplier = DEPTH_MULTIPLIERS[depth ?? 'normal'] ?? 1;
  const maxToolCalls = Math.ceil((identityAgentConfig.maxToolCalls ?? 30) * multiplier);
  emitProgress(`🕵️‍♂️ IdentityAgent → "${query.length > 120 ? query.slice(0, 117) + '...' : query}" [derinlik: ${depth ?? 'normal'}, bütçe: ${maxToolCalls}]`);
  const history: Message[] = [
    { role: 'system', content: identityAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, { ...identityAgentConfig, maxToolCalls });
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  emitProgress(`✅ IdentityAgent tamamlandı [${result.toolCallCount} araç: ${toolSummary || 'yok'}]`);
  const meta = `\n\n---\n**[META] IdentityAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return result.finalResponse + meta;
}

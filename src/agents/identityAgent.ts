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
  'run_sherlock', 'run_github_osint', 'parse_gpg_key', 
  'check_email_registrations', 'check_breaches', 'search_person', 
  'cross_reference', 'verify_profiles', 'unexplored_pivots', 'nitter_profile',
  'search_web', 'search_web_multi', 'scrape_profile', 'verify_claim'
];

export const identityAgentConfig: AgentConfig = {
  name: 'IdentityAgent',
  tools: tools.filter((t: any) => t.type === 'function' && IDENTITY_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
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
1. Username → run_sherlock + run_github_osint
2. Email → check_email_registrations + check_breaches
3. İsim → search_person + search_web

**FAZ 2 — Genişletme:**
4. Bulunan profilleri scrape_profile ile tara
5. GPG anahtarı varsa → parse_gpg_key
6. Twitter/X → nitter_profile
7. cross_reference ile hesaplar arası bağlantı ara

**FAZ 3 — Doğrulama:**
8. verify_profiles ile platform eşleşmelerini doğrula
9. Kritik iddialar (eğitim, iş, konum) → verify_claim
10. Doğrulanamayan iddiaları "⚠️ Doğrulanmamış İpuçları" bölümüne taşı

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
- search_web_multi: Aynı konuyu farklı açılardan ara (max 3 sorgu, virgülle ayır)
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

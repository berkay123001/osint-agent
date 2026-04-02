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
    console.log(chalk.gray(`   🧠 Kimlik ham bilgi tabanı kaydedildi → .osint-sessions/identity-knowledge.md (${calls.length} araç sonucu)`));
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
  systemPrompt: `Sen bir "Identity & OSINT Uzmanı" alt-ajanısın. (IdentityAgent)
Görevin: Bir kişinin dijital izlerini, hesaplarını, bağlarını ve kimliğini ortaya çıkarmak.

Öncelikli Stratejin:
1. Username ile başlayıp Sherlock ve Github OSINT kullan.
2. Email bulursan MUTLAKA check_email_registrations ve check_breaches ile pivot yap.
3. Sonuçları verify_profiles ile onayla.

🚨 KRİTİK — ÇOKLU KİMLİK KURALI:
Aynı isimde birden fazla farklı kişi OLABİLİR. Bunu her zaman varsay.
- Bir platform (örn. GitHub) kişiliğini bulduğunda, diğer platform (YouTube, web sitesi) ile aynı kişi olduğunu ASLA otomatik kabul etme.
- İki kaynağı aynı kişiye bağlamak için somut kanıt gerekir:
  * Çapraz link: A platformu B platformunu kendisi gösteriyor olmalı
  * Aynı email: İki platformda aynı email kullanılıyor olmalı
  * Aynı avatar: verify_profiles ile perceptual hash eşleşmesi
  * Özdeş biyografi: İki platformdaki bio/kurum/konum bilgisi tutarlı
- Kanıt YOKSA raporda şunu yaz: "[BAĞLANTI DOĞRULANAMADI: kanıt yok]"
- Birden fazla farklı kişiyi tespit edersen HER BİRİNİ AYRI profil olarak raporla.

Unutma: 
- Görevin KİMLİK/HESAP tespiti ve analizi yapmaktır.
- Elde ettiğin her veriyi çapraz kontrol et.
- Aynı konuyu farklı açılardan aramak için search_web_multi kullan (virgülle ayrılmış max 3 sorgu).
- "Bedava", "ücretsiz", "kayıt gerektirmez" gibi iddialar varsa verify_claim ile doğrula.
- Ortaya çıkan graf bağlantılarını ve bulguları Markdown kullanarak eksiksiz raporla.`
};

export async function runIdentityAgent(query: string, context?: string): Promise<string> {
  console.log(chalk.cyan.bold(`\n🕵️‍♂️ Dış Görevlendirme: IdentityAgent -> "${query}"`));
  const history: Message[] = [
    { role: 'system', content: identityAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, identityAgentConfig);
  await saveKnowledgeFromHistory(history, query);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  console.log(chalk.green(`\n✅ IdentityAgent Raporu Tamamlandı.`) +
    chalk.gray(` [${result.toolCallCount} araç çağrısı: ${toolSummary || 'yok'}]`));
  const meta = `\n\n---\n**[META] IdentityAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return result.finalResponse + meta;
}

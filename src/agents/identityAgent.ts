import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';

const IDENTITY_TOOLS = [
  'run_sherlock', 'run_github_osint', 'parse_gpg_key', 
  'check_email_registrations', 'check_breaches', 'search_person', 
  'cross_reference', 'verify_profiles', 'unexplored_pivots', 'nitter_profile'
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
- Ortaya çıkan graf bağlantılarını ve bulguları Markdown kullanarak eksiksiz raporla.`
};

export async function runIdentityAgent(query: string, context?: string): Promise<string> {
  console.log(chalk.cyan.bold(`\n🕵️‍♂️ Dış Görevlendirme: IdentityAgent -> "${query}"`));
  const history: Message[] = [
    { role: 'system', content: identityAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, identityAgentConfig);
  console.log(chalk.green(`\n✅ IdentityAgent Raporu Tamamlandı.`));
  return result.finalResponse;
}

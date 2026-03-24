import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import chalk from 'chalk';

const MEDIA_TOOLS = [
  'extract_metadata', 'reverse_image_search', 'compare_images_phash', 
  'fact_check_to_graph', 'wayback_search'
];

export const mediaAgentConfig: AgentConfig = {
  name: 'MediaAgent',
  tools: tools.filter((t: any) => t.type === 'function' && MEDIA_TOOLS.includes(t.function.name)),
  executeTool: executeTool,
  systemPrompt: `Sen bir "Haber Doğrulama ve Medya Analitiği" alt-ajanısın. (MediaAgent)
Görevin: Görüntüleri analiz etmek, arşivleri (wayback) aramak ve iddiaların (Claim) doğruluğunu araştırmak.

Medya Doğrulama Adımları:
1. Şüpheli görsel gelirse reverse_image_search ile kaynağını bul.
2. Exif varsa extract_metadata kullan.
3. pHash kıyaslaması isteniyorsa compare_images_phash kullan.
4. Doğrulama sonucunu fact_check_to_graph ile Neo4j grafiğine kaydet.

Unutma: 
- Sadece medya, görsel ve iddia teyidi yaparsın.
- Detaylı bir Markdown raporuyla (kaynak linkler ve güven seviyeleriyle beraber) bulgularını derle.`
};

export async function runMediaAgent(query: string, context?: string): Promise<string> {
  console.log(chalk.cyan.bold(`\n📰 Dış Görevlendirme: MediaAgent -> "${query}"`));
  const history: Message[] = [
    { role: 'system', content: mediaAgentConfig.systemPrompt },
    { role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${query}` : query }
  ];
  const result = await runAgentLoop(history, mediaAgentConfig);
  const toolSummary = Object.entries(result.toolsUsed)
    .map(([tool, count]) => `${tool}×${count}`)
    .join(', ');
  console.log(chalk.green(`\n✅ MediaAgent Raporu Tamamlandı.`) +
    chalk.gray(` [${result.toolCallCount} araç çağrısı: ${toolSummary || 'yok'}]`));
  const meta = `\n\n---\n**[META] MediaAgent araç istatistikleri:** ${toolSummary || 'araç kullanılmadı'} (toplam: ${result.toolCallCount})`;
  return result.finalResponse + meta;
}

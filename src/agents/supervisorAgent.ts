import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { runIdentityAgent } from './identityAgent.js';
import { runMediaAgent } from './mediaAgent.js';
import { runAcademicAgent } from './academicAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import type OpenAI from 'openai';
import chalk from 'chalk';

const SUPERVISOR_TOOLS = [
  'query_graph', 'list_graph_nodes', 'graph_stats', 'clear_graph', 
  'search_web', 'web_fetch', 'scrape_profile', 'remove_false_positive',
  'generate_report', 'check_plagiarism',
];

const supervisorNativeTools = tools.filter((t: any) => t.type === 'function' && SUPERVISOR_TOOLS.includes(t.function.name));

const supervisorMetaTools: OpenAI.Chat.ChatCompletionTool[] = [
  ...supervisorNativeTools,
  {
    type: 'function',
    function: {
      name: 'ask_identity_agent',
      description: 'Kişi, username, email veya profil araştırması gerektiğinde Identity uzmanına başvurur.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Identity uzmanına verilecek tam görev/komut (Örn: "torvalds github hesabını incele")' },
          context: { type: 'string', description: 'Ek bağlam (Öncesinde bilinenler vs.)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_media_agent',
      description: 'Görsel doğrulama, exif analizi, tersine görsel arama, yalan haber/iddia doğrulama gerektiğinde Media uzmanına başvurur. Haber/iddia doğrulamada MediaAgent Supervisor\'ın özetine değil HAM VERİYE dayanır — context\'e mutlaka ham URL listesi ve alıntı geç.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Media uzmanına verilecek görev/komut (Örn: "Şu görselin kaynağını bul" veya "İran gaz kesintisi iddiasını doğrula — aşağıdaki URL\'leri kendi araçlarınla tara")' },
          context: { type: 'string', description: 'HAM VERİ paketi — Supervisor\'ın topladığı URL\'ler, ham alıntılar ve çelişkili noktalar. Örnek format: "URL1: https://... | Alıntı: \'Bakan: akış devam ediyor\'\nURL2: https://... | Alıntı: \'Bloomberg: ihracat durduruldu\'\nÇELİŞKİ: Türk resmi kaynaklar vs uluslararası medya"\nMediaAgent bu URL\'leri kendi web_fetch/scrape araçlarıyla bağımsız olarak doğrular. ÖZET DEĞİL — HAM URL VER.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_academic_agent',
      description: 'Akademik konu araştırması, makale/yayın taraması, araştırmacı profili, citation analizi gerektiğinde Akademik Araştırma uzmanına başvurur. Örn: "LLM\'lerde RL eğitimi üzerine en güncel makaleler", "Attention is All You Need sonrası ne çalışılıyor?"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Akademik araştırma görevi (Örn: "reinforcement learning from human feedback 2025 makaleleri")' },
          context: { type: 'string', description: 'Ek bağlam (araştırmacı ismi, kurum vb.)' }
        },
        required: ['query']
      }
    }
  }
];

async function supervisorExecuteTool(name: string, args: Record<string, string>): Promise<string> {
  if (name === 'ask_identity_agent') {
    const r = await runIdentityAgent(args.query, args.context);
    return `${r}\n\n---\n⚠️ [AGENT_DONE] Bu ajan görevi tamamladı. Aynı görevi TEKRAR devretme — yukarıdaki raporu kullanıcıya sun.`;
  } else if (name === 'ask_media_agent') {
    const r = await runMediaAgent(args.query, args.context);
    return `${r}\n\n---\n⚠️ [AGENT_DONE] Bu ajan görevi tamamladı. Aynı görevi TEKRAR devretme — yukarıdaki raporu kullanıcıya sun.`;
  } else if (name === 'ask_academic_agent') {
    const r = await runAcademicAgent(args.query, args.context);
    return `${r}\n\n---\n⚠️ [AGENT_DONE] Bu ajan görevi tamamladı. Aynı görevi TEKRAR devretme — yukarıdaki raporu kullanıcıya sun.`;
  } else {
    // Normal araçlar (graf, search_web vs.) için ortak registry kullan
    return await executeTool(name, args);
  }
}

export const supervisorAgentConfig: AgentConfig = {
  name: 'Supervisor',
  model: 'qwen/qwen3.5-plus-02-15',
  tools: supervisorMetaTools,
  executeTool: supervisorExecuteTool,
  systemPrompt: `Sen OSINT Dijital Müfettiş sisteminin Şef (Supervisor) Ajanısın.
Kullanıcıyla doğrudan sen muhatap olursun.

⚠️ KRİTİK KURAL: ASLA boş yanıt dönme. Her zaman topladığın verileri analiz edip kullanıcıya detaylı bir Markdown raporu sun.

KARAR AĞACI — Kullanıcının isteğine göre hemen şunu yap:
1. Kişi/username/email araştırması → HEMEN ask_identity_agent çağır. Kendi başına sadece search_web yapma.
2. Görsel/video/haber doğrulama → Önce search_web ile ilgili haberleri ve URL'leri topla. Sonra ask_media_agent çağır — context field'ına topladığın URL'leri ve ham alıntıları yaz. ASLA sadece özet geçme.
3. Akademik araştırma (makale, konu, yayın, araştırmacı, citation) → HEMEN ask_academic_agent çağır.
4. Graf sorgusu (bağlantılar, istatistik) → query_graph, list_graph_nodes, graph_stats kullan.
5. Rapor isteği ("rapor oluştur", "rapor ver", "raporu kaydet") → HEMEN generate_report çağır.
6. Genel soru → Araç kullanmadan doğrudan yanıt ver.

📋 HABER DOĞRULAMA İÇİN BRIEF FORMATI — ask_media_agent çağırırken context'i şöyle doldur:
"""
TOPLADIĞIM URL'LER:
- [kaynak 1 adı]: [URL] | Ham alıntı: "[sayfadan kopyaladığın cümle]"
- [kaynak 2 adı]: [URL] | Ham alıntı: "[sayfadan kopyaladığın cümle]"

ÇELİŞKİ NOKTASI: [Hangi iki kaynak/iddia birbirine zıt?]
DOĞRULANMASI GEREKEN İDDİA: [Net soru]
"""
MediaAgent bu URL'leri kendi araçlarıyla bağımsız olarak kontrol edecek.
🚨 ÇOKLU KİMLİK UYARISI:
Aynı ad-soyadda birden fazla kişi bulunursa (örn. hem akademisyen hem öğrenci), bunları ASLA otomatik olarak birleştirme.
- IdentityAgent raporunda "[BAĞLANTI DOĞRULANAMADI]" ifadesi varsa bunu kullanıcıya açıkça belirt.
- Hangi bulgunun kime ait olduğunu net tablolarla ayır.
- Emin olamıyorsan "Bu iki hesabın aynı kişiye ait olduğu DOĞRULANAMADI" de.
Kendi Kullanabileceğin Temel Araçlar:
- Graf araçları (query_graph, list_graph_nodes, graph_stats vb.)
- search_web, web_fetch, scrape_profile

Uzmanlardan gelen raporları değerlendir, analiz et ve kullanıcıya harika bir Markdown formatında (emojiler, listeler, tablolar kullanarak) özetleyerek sun.

🚫 ALT AJAN TAMAMLANDI KURALI:
Bir alt ajandan "[AGENT_DONE]" etiketi içeren yanıt aldıktan sonra KESİNLİKLE:
- Ek search_web veya web_fetch çağırma
- Aynı konuyu kendin araştırma
- Yeni araç çağrısı yapma
Sadece aldığın raporu Markdown formatında kullanıcıya sun ve bırak. Süpervizörün görevi koordinasyon ve sentezdir, tekrar araştırma değil.
Asla doğrudan API/JSON dökümü gösterme. Cevabın net, okunabilir ve profesyonel olsun.
ASLA BOŞTA BIRAKMA — her zaman bir yanıt üret.

🔁 DÖNGÜ YASAĞI — KRİTİK:
- Alt-ajanlar (ask_identity_agent, ask_media_agent, ask_academic_agent) yalnızca BİR KEZ çağrılır.
- Ajan yanıt döndürdükten sonra — sonuç yetersiz görünse bile — TEKRAR aynı ajanı çağırma.
- [AGENT_DONE] etiketi gördüğünde o araştırma kapanmıştır. Mevcut raporla kullanıcıya yanıt ver.
- Başka bir konuyu araştırmak gerekiyorsa farklı bir alt-ajan veya kendi araçlarını kullan.`
};

function formatAgentOutput(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^##\s/.test(line)) return chalk.cyan.bold(line.replace(/^##\s/, ''));
      if (/^#\s/.test(line)) return chalk.cyan.bold.underline(line.replace(/^#\s/, ''));
      if (/^[-*]\s/.test(line)) return chalk.white('  • ') + line.slice(2);
      line = line.replace(/\*\*(.*?)\*\*/g, (_, m) => chalk.yellow.bold(m));
      line = line.replace(/`([^`]+)`/g, (_, m) => chalk.green(m));
      line = line.replace(/(https?:\/\/[^\s]+)/g, (url) => chalk.blue.underline(url));
      return line;
    })
    .join('\n');
}

export async function runSupervisor(history: Message[]): Promise<void> {
  try {
    const result = await runAgentLoop(history, supervisorAgentConfig);
    const formatted = formatAgentOutput(result.finalResponse);
    console.log(`\n${chalk.magenta.bold('🤖 Şef (Supervisor):')}\n${formatted}\n`);
    return;
  } catch (error) {
    console.error(chalk.red(`Supervisor Hatası:`), error);
  }
}

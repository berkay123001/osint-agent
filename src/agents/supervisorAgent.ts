import type { Message, AgentConfig } from './types.js';
import { runAgentLoop } from './baseAgent.js';
import { runIdentityAgent } from './identityAgent.js';
import { runMediaAgent } from './mediaAgent.js';
import { runAcademicAgent } from './academicAgent.js';
import { tools, executeTool, setReportContentBuffer } from '../lib/toolRegistry.js';
import type OpenAI from 'openai';
import { logger } from '../lib/logger.js';
import chalk from 'chalk';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { obsidianWrite } from '../tools/obsidianTool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Sub-agent yanıtlarını kısaltır.
 * - 4000 karakter altı: dokunma
 * - 4000+ karakter: ilk 3500 karakter + "kesildi" notu + dosya yolu
 * Supervisor detayları read_session_file ile okuyabilir.
 */
const MAX_SUB_AGENT_RESPONSE = 30000;
const KEEP_FIRST = 29000;

function truncateSubAgentResponse(response: string, agentLabel: string): string {
  if (response.length <= MAX_SUB_AGENT_RESPONSE) return response
  const truncated = response.slice(0, KEEP_FIRST)
  const lines = truncated.split('\n')
  // Son tamamlanmamış satırı at
  if (truncated.length === KEEP_FIRST) lines.pop()
  return lines.join('\n') +
    `\n\n---\n✂️ **[${agentLabel} yanıtı ${((response.length / 1024).toFixed(1))}KB — kısaltıldı]**\n` +
    `📄 Tam rapor için \`read_session_file\` aracını kullan.\n` +
    `⚠️ [AGENT_DONE] Bu ajan görevi tamamladı. Aynı görevi TEKRAR devretme.`
}

/**
 * Sub-agent yanıtlarını kısaltır (önceki tanımlamayla birleştirildi).
 */
const SUPERVISOR_TOOLS = [
  'query_graph', 'list_graph_nodes', 'graph_stats', 'clear_graph', 
  'search_web', 'search_web_multi', 'web_fetch', 'scrape_profile', 'verify_claim',
  'remove_false_positive', 'mark_false_positive',
  'generate_report', 'check_plagiarism',
  'obsidian_write', 'obsidian_append', 'obsidian_read', 'obsidian_daily', 'obsidian_list', 'obsidian_search', 'obsidian_write_profile',
  'save_finding', 'batch_save_findings', 'save_ioc', 'link_entities',
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
          context: { type: 'string', description: 'Ek bağlam (Öncesinde bilinenler vs.)' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Araştırma derinliği. quick=tek varlık/hızlı doğrulama (0.5x araç bütçesi), normal=standart (1x), deep=çok varlıklı/karmaşık araştırma (1.75x). Birden fazla kişi/username/email varsa deep kullan.' }
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
          context: { type: 'string', description: 'HAM VERİ paketi — Supervisor\'ın topladığı URL\'ler, ham alıntılar ve çelişkili noktalar. Örnek format: "URL1: https://... | Alıntı: \'Bakan: akış devam ediyor\'\nURL2: https://... | Alıntı: \'Bloomberg: ihracat durduruldu\'\nÇELİŞKİ: Türk resmi kaynaklar vs uluslararası medya"\nMediaAgent bu URL\'leri kendi web_fetch/scrape araçlarıyla bağımsız olarak doğrular. ÖZET DEĞİL — HAM URL VER.' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Araştırma derinliği. quick=tek iddia/görsel (0.5x), normal=standart (1x), deep=çok kaynak/karmaşık fact-check (1.75x). Birden fazla bağımsız iddia veya 3+ URL incelemelerde deep kullan.' }
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
          context: { type: 'string', description: 'Ek bağlam (araştırmacı ismi, kurum vb.)' },
          depth: { type: 'string', enum: ['quick', 'normal', 'deep'], description: 'Araştırma derinliği. quick=tek makale/hızlı özet (0.5x), normal=standart literatür taraması (1x), deep=kapsamlı citation ağı/çoklu araştırmacı analizi (1.75x).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_session_file',
      description: 'Sub-agent oturum dosyalarını disk\'ten okur. Belirli bir agent filtreleyebilir veya ham bilgi tabanını okuyabilirsin. Alt ajan raporunda detay eksikse veya kullanıcı follow-up soruyorsa kullan — agent\'ı tekrar çağırma.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['academic', 'identity', 'media', 'all'],
            description: 'Hangi agent\'ın oturum dosyası okunacak? Varsayılan: all (tüm agentlar)'
          },
          include_knowledge: {
            type: 'boolean',
            description: 'Ham araç çağrısı sonuçlarını (knowledge base) da dahil et? Varsayılan: false (sadece rapor)'
          }
        },
        required: []
      }
    }
  }
];

/**
 * Sub-agent sonucunu programatik olarak Obsidian'a kaydeder.
 * Supervisor'ın LLM tool call yapmasına gerek kalmaz — JSON crash riskini ortadan kaldırır.
 */
async function saveToObsidianDirect(agentLabel: string, query: string, result: string): Promise<void> {
  try {
    const safeName = query
      .replace(/[Ğğ]/g, 'G').replace(/[Üü]/g, 'U').replace(/[Şş]/g, 'S')
      .replace(/[İı]/g, 'I').replace(/[Öö]/g, 'O').replace(/[Çç]/g, 'C')
      .replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 60).trim() || 'arastirma'
    const date = new Date().toISOString().slice(0, 10)
    const obsidianPath = `02 - Literatür Araştırması/${date}-${safeName}.md`
    const header = `# ${agentLabel} Literatür Araştırması\n\n**Sorgu:** ${query}\n**Tarih:** ${new Date().toISOString()}\n\n---\n\n`
    await obsidianWrite(obsidianPath, header + result, true)
    logger.info('OBSIDIAN', `📝 Sub-agent sonucu direkt Obsidian'a yazıldı → ${obsidianPath}`)
  } catch (e) {
    logger.warn('OBSIDIAN', `Sub-agent Obsidian yazma atlanadı: ${(e as Error).message}`)
  }
}

async function supervisorExecuteTool(name: string, args: Record<string, string>): Promise<string> {
  if (name === 'ask_identity_agent') {
    const r = await runIdentityAgent(args.query, args.context, args.depth);
    setReportContentBuffer(r);
    try {
      const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
      await mkdir(sessionDir, { recursive: true });
      const header = `# Kimlik Araştırması Oturum Dosyası\n\n**Sorgu:** ${args.query}\n**Tarih:** ${new Date().toISOString()}\n\n---\n\n`;
      await writeFile(path.join(sessionDir, 'identity-last-session.md'), header + r, 'utf-8');
    } catch { /* sessizce geç */ }
    saveToObsidianDirect('IdentityAgent', args.query, r)
    return truncateSubAgentResponse(r, 'IdentityAgent');
  } else if (name === 'ask_media_agent') {
    const r = await runMediaAgent(args.query, args.context, args.depth);
    setReportContentBuffer(r);
    try {
      const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
      await mkdir(sessionDir, { recursive: true });
      const header = `# Medya Araştırması Oturum Dosyası\n\n**Sorgu:** ${args.query}\n**Tarih:** ${new Date().toISOString()}\n\n---\n\n`;
      await writeFile(path.join(sessionDir, 'media-last-session.md'), header + r, 'utf-8');
    } catch { /* sessizce geç */ }
    saveToObsidianDirect('MediaAgent', args.query, r)
    return truncateSubAgentResponse(r, 'MediaAgent');
  } else if (name === 'ask_academic_agent') {
    const r = await runAcademicAgent(args.query, args.context, args.depth);
    setReportContentBuffer(r);
    try {
      const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
      await mkdir(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'academic-last-session.md');
      const header = `# Akademik Araştırma Oturum Dosyası\n\n**Sorgu:** ${args.query}\n**Tarih:** ${new Date().toISOString()}\n\n---\n\n`;
      await writeFile(sessionFile, header + r, 'utf-8');
    } catch { /* sessizce geç */ }
    saveToObsidianDirect('AcademicAgent', args.query, r)
    return truncateSubAgentResponse(r, 'AcademicAgent');
  } else if (name === 'read_session_file') {
    try {
      const sessionDir = path.resolve(__dirname, '../../.osint-sessions');
      const { readFile } = await import('fs/promises');
      const agentFilter = (args.agent as string) || 'all';
      const includeKnowledge = args.include_knowledge === 'true';

      const allFiles = [
        { key: 'academic', label: 'AcademicAgent Raporu', report: 'academic-last-session.md', knowledge: 'academic-knowledge.md' },
        { key: 'identity', label: 'IdentityAgent Raporu', report: 'identity-last-session.md', knowledge: 'identity-knowledge.md' },
        { key: 'media', label: 'MediaAgent Raporu', report: 'media-last-session.md', knowledge: 'media-knowledge.md' },
      ];

      const filtered = agentFilter === 'all'
        ? allFiles
        : allFiles.filter(f => f.key === agentFilter);

      const parts: string[] = [];
      for (const f of filtered) {
        const readTasks = [readFile(path.join(sessionDir, f.report), 'utf-8')];
        if (includeKnowledge) readTasks.push(readFile(path.join(sessionDir, f.knowledge), 'utf-8'));

        const results = await Promise.allSettled(readTasks);
        if (results[0].status === 'fulfilled') {
          parts.push(`# ${f.label}\n\n${results[0].value}`);
        }
        if (includeKnowledge && results[1]?.status === 'fulfilled') {
          parts.push(results[1].value);
        }
      }
      if (parts.length === 0) {
        const hint = agentFilter === 'all' ? '' : ` (${agentFilter} agent için)`;
        return `⚠️ Henüz kaydedilmiş araştırma oturumu yok${hint}. Önce bir sub-agent çağırın.`;
      }
      return parts.join('\n\n---\n\n');
    } catch {
      return '⚠️ Henüz kaydedilmiş araştırma oturumu yok.';
    }
  } else {
    // Normal araçlar (graf, search_web vs.) için ortak registry kullan
    return await executeTool(name, args);
  }
}

export const supervisorAgentConfig: AgentConfig = {
  name: 'Supervisor',
  model: 'qwen/qwen3.6-plus:free',
  maxTokens: 32768, // Büyük sub-agent raporları + thinking tokens için geniş bütçe
  maxToolCalls: 40, // Kapsamlı OSINT araştırmalarında arama + Neo4j yazma + rapor toplamı
  tools: supervisorMetaTools,
  executeTool: supervisorExecuteTool,
  systemPrompt: `# KİMLİK
Sen OSINT Dijital Müfettiş sisteminin Şef (Supervisor) Ajanısın. Kullanıcıyla doğrudan sen muhatap olursun.

# TEMEL İLKELER (ÖNCELİK SIRASI — 1 EN YÜKSEK)

1. **DOĞRULUK > BÜTÜNLÜK**: Yanlış bilgi vermektense eksik bırak. Emin olmadığın iddiayı SUNMA.
2. **GENEL KÜLTÜR YASAĞI**: Senin eğitim verinden gelen bilgiyi OSINT bulgusu gibi sunma. Yalnızca araç çıktılarındaki veriyi raporla.
3. **KAYNAK ZORUNLULUĞU**: Rapordaki her somut iddiaya [kaynak: araç_adı] veya [kaynak: sub-agent] ekle. Kaynağı yoksa o satır rapordan ÇIKARILIR.
4. **GÜVEN ETİKETİ**: Her iddia yanına şunlardan birini koy:
   - ✅ Doğrulandı (birden fazla bağımsız kaynak)
   - ⚠️ Tek kaynak (doğrulama bekliyor)
   - ❓ Doğrulanamadı (kaynak bulunamadı)
5. **BOŞ YANIT DÖNME**: Araçlar çalıştıysa mutlaka bir sonuç raporla — ama uydurarak değil, elindeki gerçek veriden.

# KARAR AĞACI — Kullanıcı isteğine göre hemen uygula

<rules>
0. SESSION KONTROLÜ: Kullanıcı önceki araştırmaya atıfta bulunuyorsa ("daha önce", "az önce", "peki ya") → ÖNCE read_session_file çağır. Varsa direkt cevap ver.
1. Kişi/username/email → ask_identity_agent çağır
2. Görsel/video/haber doğrulama → Önce search_web ile URL topla, sonra ask_media_agent çağır (context'e ham URL + alıntı yaz)
3. Akademik araştırma → ask_academic_agent çağır
   ⚠️ FOLLOW-UP: Daha önce çağrıldıysa → history'deki [AGENT_DONE] raporundan cevap ver, yetmezse read_session_file
4. Graf sorgusu → query_graph, list_graph_nodes, graph_stats
5. Rapor isteği → generate_report çağır (otomatik Obsidian sync)
6. "Ne yapabilirsin?" → Sistem özelliklerini say
7. Genel soru → Araç kullanmadan yanıt ver
</rules>

# SUB-AGENT SONRASI PROTOKOL (ZORUNLU — her sub-agent sonucunda uygula)

⛔ Sub-agent tool sonucu döndükten sonra ASLA "araştırma başlatıldı", "ajan çalışıyor", "bekleyin" YAZMA. Tool sonucu = agent TAMAMLANDI.

**ADIM 1 — SELF-REVIEW** (araç çağrısı gerektirmez):
Raporu yazmadan ÖNCE sub-agent çıktısını denetle:
1. HER somut iddia için: "Bu bilgiyi hangi araç/bulgu verdi?"
   - Sub-agent çıktısında açıkça geçiyorsa → kaynağıyla sun
   - Kendi genel kültüründen eklediysen → SİL veya "⚠️ Genel bilgi — OSINT kaynağı yok" işaretle
   - Email/domain'den kurum çıkardıysan → SİL ("@asu.edu göründü" ≠ "ASU mezunu")
2. Kaynak gösteremediğin satırları rapordan SİL — "muhtemel" / "biliniyor" diye sunma
3. Tablolardaki her satırı kontrol et — sub-agent raporunda yoksa senin uydurman, SİL

**ADIM 2 — ÇAPRAZ DOĞRULAMA** (EN FAZLA 3 verify_claim çağrısı):
Self-review'de şüpheli bulduğun kritik iddiaları verify_claim ile doğrula:
- Eğitim geçmişi (üniversite, derece, yıl)
- İş/kurum bağlantıları (şirket, pozisyon)
- Somut kişisel bilgiler (konum, ilişkiler)
Sonuç: ✅ → kalsın | ⚠️ → "[DOĞRULANAMADI]" işaretle | ❌ → rapordan SİL
⚠️ verify_claim "aynı araştırmayı tekrar etmek" DEĞİLDİR — döngü yasağına dahil değildir.

**ADIM 3 — RAPOR YAZ** (Markdown formatında):
Self-review ve doğrulama sonrası temizlenmiş raporu kullanıcıya sun.
Alt ajan raporundaki zengin içeriği koru — spesifik sayılar, isimler, linkler, metrikler.
Kullanıcı detay isterse read_session_file ile genişlet.

# ARAÇ ÇAĞIRMA KURALLARI

<tool_rules>
## Sub-agent kuralları:
- Her sub-agent (ask_identity_agent, ask_media_agent, ask_academic_agent) yalnızca BİR KEZ çağrılır
- [AGENT_DONE] etiketi gördüğünde o araştırma kapanmıştır — tekrar çağırma
- Sub-agent döndükten sonra ASLA aynı kişi/konu hakkında search_web YAPMA (agent zaten araştırdı)

## Sub-agent sonrası İZİN VERİLEN araçlar:
- verify_claim (en fazla 3 kez — doğrulama için)
- save_finding, save_ioc (TEK TEK — evidence max 200 karakter)
- link_entities (graf bağlantısı için)
- generate_report (rapor oluşturma)
- query_graph, graph_stats (graf sorgusu)
- read_session_file (session verisi okuma)

## Sub-agent sonrası YASAK araçlar:
- search_web, search_web_multi, web_fetch, scrape_profile (bunlar sub-agent'ın işi)
- Aynı sub-agent'ı ikinci kez çağırmak
</tool_rules>

# ÇOKLU KİMLİK UYARISI
Aynı ad-soyadda birden fazla kişi bulunursa ASLA otomatik birleştirme.
- "[BAĞLANTI DOĞRULANAMADI]" varsa kullanıcıya açıkça belirt
- Hangi bulgunun kime ait olduğunu tablolarla ayır

# HABER DOĞRULAMA BRIEF FORMATI
ask_media_agent çağırırken context'i şöyle doldur:
"""
TOPLADIĞIM URL'LER:
- [kaynak adı]: [URL] | Ham alıntı: "[cümle]"
ÇELİŞKİ NOKTASI: [Hangi iddialar zıt?]
DOĞRULANMASI GEREKEN İDDİA: [Net soru]
"""

# NEO4J GRAF YAZMA

<neo4j>
✅ Kaydet: email-username kanıtı → save_finding | Doğrulanmış hesap → link_entities (SAME_AS) | C2/phishing → save_ioc | Kesin kurum bağlantısı → save_finding
✅ Etiketle: Node doğrulandı → mark_false_positive(ml_label=verified) | Node alakasız → mark_false_positive(ml_label=false_positive)
✅ Sil: Tamamen gürültü → remove_false_positive
❌ Kaydetme: Geçici arama sonuçları | Spekülatif bulgular | Doğrulanamayan iddialar
save_ioc type: Akademik framework'ler (BloodHound vb.) → Tool veya Framework kullan (Campaign değil)
</neo4j>

# OBSİDİAN ENTEGRASYONU

<obsidian>
Vault: /home/berkayhsrt/Agent_Knowladges/OSINT/OSINT-Agent/
- 04 - Araştırma Raporları/ → generate_report otomatik sync
- 06 - Günlük/ → obsidian_daily
- 07 - Notlar/ → kullanıcı tercihleri
- 08 - Profiller/ → [[username]] wikilink ile profil notları

Ne zaman: Kullanıcı tercih belirtti → obsidian_daily | Kritik bulgu → obsidian_daily | "Kaydet/hatırla" → obsidian_write | Kişi araştırıldı → 08 - Profiller/[username].md
"Obsidian entegrasyonun var mı?" → "Evet! generate_report raporları otomatik olarak Obsidian vault'a sync eder."
</obsidian>

# SİSTEM ÖZELLİKLERİ
- 🔍 Kimlik/Username/Email OSINT (Sherlock, Holehe, GitHub, breach)
- 📚 Akademik araştırma (arXiv + Semantic Scholar)
- 🖼️ Görsel/haber doğrulama (EXIF, reverse image, fact-check)
- 📊 Neo4j graf veritabanı sorguları
- 📝 Markdown rapor + Obsidian otomatik sync
- 💾 Oturum belleği (.osint-sessions/)

# SUNUM KURALLARI
- Markdown formatı: emojiler + tablolar + listeler
- Sub-agent raporundaki spesifik veriyi koru ama ÖNCE doğrula (ADIM 1-2)
- Doğrulanmamış veriyi ⚠️ ile işaretle
- ASLA API/JSON dökümü gösterme
- Profesyonel, okunabilir, net`
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
    logger.info('AGENT', `\n🤖 Şef (Supervisor):\n${formatted}\n`);
    return;
  } catch (error) {
    logger.error('AGENT', `Supervisor Hatası: ${error instanceof Error ? error.message : String(error)}`);
  }
}

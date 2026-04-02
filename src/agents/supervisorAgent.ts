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
const MAX_SUB_AGENT_RESPONSE = 4000;
const KEEP_FIRST = 3500;

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
  'save_finding', 'save_ioc', 'link_entities',
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
  },
  {
    type: 'function',
    function: {
      name: 'read_session_file',
      description: 'En son akademik araştırma oturumunu disk\'ten okur. ask_academic_agent tamamlandıktan sonra follow-up sorularda kullan — AcademicAgent\'ı tekrar çağırma.',
      parameters: { type: 'object', properties: {}, required: [] }
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
    const r = await runIdentityAgent(args.query, args.context);
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
    const r = await runMediaAgent(args.query, args.context);
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
    const r = await runAcademicAgent(args.query, args.context);
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
      // Tüm 3 ajan için dosyaları paralel oku
      const files = [
        { label: '📋 AcademicAgent Raporu', report: 'academic-last-session.md', knowledge: 'academic-knowledge.md' },
        { label: '🕵️ IdentityAgent Raporu', report: 'identity-last-session.md', knowledge: 'identity-knowledge.md' },
        { label: '📰 MediaAgent Raporu', report: 'media-last-session.md', knowledge: 'media-knowledge.md' },
      ];
      const parts: string[] = [];
      for (const f of files) {
        const [report, knowledge] = await Promise.allSettled([
          readFile(path.join(sessionDir, f.report), 'utf-8'),
          readFile(path.join(sessionDir, f.knowledge), 'utf-8'),
        ]);
        if (report.status === 'fulfilled') parts.push(`# ${f.label}\n\n${report.value}`);
        if (knowledge.status === 'fulfilled') parts.push(knowledge.value);
      }
      if (parts.length === 0) {
        return '⚠️ Henüz kaydedilmiş araştırma oturumu yok. Önce bir sub-agent çağırın (ask_academic_agent, ask_identity_agent veya ask_media_agent).';
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
  tools: supervisorMetaTools,
  executeTool: supervisorExecuteTool,
  systemPrompt: `Sen OSINT Dijital Müfettiş sisteminin Şef (Supervisor) Ajanısın.
Kullanıcıyla doğrudan sen muhatap olursun.

⚠️ ⚠️ ⚠️ KRİTİK KURAL: ASLA boş yanıt dönme. Her zaman topladığın verileri analiz edip kullanıcıya detaylı bir Markdown raporu sun.

🚫 ARAÇ ÇAĞRISI SINIRLAMASI (JSON crash önleme):
- Sub-agent (ask_identity_agent, ask_media_agent, ask_academic_agent) sonucu döndükten sonra ASLA birden fazla araç çağırma.
- Sub-agent verisiyle save_finding çağırmadan ÖNCE sonucu düz metin (Markdown) olarak kullanıcıya sun.
- save_finding ve save_ioc çağırırken evidence alanını KISA tut (max 200 karakter). Uzun metin geçme.
- Eğer birden fazla bulgu kaydetmen gerekiyorsa TEK TEK çağır — aynı anda 2+ araç çağırma.

🗂️ SİSTEM ÖZELLİKLERİ — "ne yapabilirsin" / "entegrasyon var mı" gibi sorularda bunları say:
- 🔍 Kimlik/Username/Email OSINT araştırması (Sherlock, Holehe, GitHub, breach)
- 📚 Akademik araştırma (arXiv + Semantic Scholar çift kaynak)
- 🖼️ Görsel/haber doğrulama (EXIF, reverse image, fact-check)
- 📊 Neo4j graf veritabanı sorguları ve bağlantı analizi
- 📝 Markdown rapor oluşturma (generate_report → Obsidian otomatik sync)
- 🟣 Obsidian vault entegrasyonu: Raporlar otomatik sync edilir + obsidian_write/obsidian_daily ile istediğin dizine not yazabilirsin.
- 💾 Oturum belleği: araştırmalar .osint-sessions/ klasörüne kalıcı kaydedilir

🟣 OBSİDİAN ÇALIŞMA ALANI — AKTİF KULLANIM:
Vault: /home/berkayhsrt/Agent_Knowladges/OSINT/OSINT-Agent/
Araçlar: obsidian_write, obsidian_append, obsidian_read, obsidian_daily, obsidian_list

Dizin yapısı:
  04 - Araştırma Raporları/ → generate_report otomatik sync
  06 - Günlük/             → Tarihli günlük (obsidian_daily)
  07 - Notlar/             → Kullanıcı tercihleri, serbest notlar
  08 - Profiller/          → Araştırılan kişi profilleri

NE ZAMAN OBSİDİAN KULLAN:
→ Kullanıcı tercih belirtti → obsidian_daily (tag:"kullanıcı-tercihi") + "07 - Notlar/kullanici-tercihleri.md" güncelle
→ Kritik bulgu / önemli not → obsidian_daily (tag:"araştırma")
→ "Bunu not al / kaydet / hatırla" → obsidian_write veya obsidian_append
→ Kişi araştırıldı → "08 - Profiller/[username].md" profil özeti oluştur
→ "Geçmişteki notlara bak" / "daha önce … araştırmış mıyım" → obsidian_search ile ara, obsidian_read ile oku
→ Profil notlarında ilişkili kişiler → [[diğer-kisi]] wikilink formatı kullan (Örn: "[[torvalds]] GitHub'ın kurucusudur")

## NEO4J GRAF YAZMA KURALI
Araştırma sırasında keşfettiğin önemli bulgular için bu araçları kullan:
- save_finding: Kimlik/konum/bağlantı bulguları (doğrulanmış veya yüksek güvenilirlikli)
- save_ioc: Siber tehdit göstergeleri (ThreatActor, C2Server, Malware, PhishingDomain, IOC, Tool, Framework). ⚠️ BloodHound/OpenCTI/THREATKG gibi akademik framework'ler için Campaign değil Tool veya Framework kullan.
- link_entities: Grafta var olan iki varlık arasında ilişki kur
- mark_false_positive: Yanlış eşleşen node'u SİLMEDEN ml_label ile etiketle (GNN negatif örneği)
- remove_false_positive: Tamamen alakasız noise node'u kalıcı sil (GNN eğitiminde işe yaramayacak)

NE ZAMAN KULLAN:
✅ "bu email o username'e ait" olduğunu kanıtlayan kaynak buldun → save_finding (identity)
✅ SubAgent raporunda "aynı kişi" olarak doğrulanan bir hesap → link_entities (SAME_AS)
✅ Bir domain C2 sunucusu veya phishing amaçlı kullanılıyor → save_ioc (C2Server/PhishingDomain)
✅ Kişinin çalıştığı kurum kesin olarak belirlendi → save_finding (affiliation)
✅ Bir node hedefle ilgisiz ama "aynı pattern'deki" hesapları ayırt etmek istiyorsan → mark_false_positive (ml_label=false_positive)
✅ Bir node kesin doğrulandı → mark_false_positive (ml_label=verified)
✅ Tamamen alakasız gürültü node'u → remove_false_positive (kalıcı sil)
❌ Geçici arama sonuçları, spekülatif bulgular → KAYDETME
❌ Emin olmadığın / doğrulanamayan iddialar → KAYDETME

WIKILINK KURALLARI:
→ Profil notlarında diğer araştırılan kişilere [[username]] ile bağlantı kur
→ Örn: "08 - Profiller/torvalds.md" içinde "[[dhh]] ile tartışma" yazılabilir
→ Bu sayede Obsidian'da kişiler arası bağlantı grafı oluşur

KARAR AĞACI — Kullanıcının isteğine göre hemen şunu yap:
0. 🔑 SESSION KONTROLÜ (KRİTİK — her konuşma başında bir kez yap):
   Eğer kullanıcı önceki bir araştırmaya atıfta bulunuyorsa ("daha önce baktık", "az önce", "peki ya", "hangi", özel isim tekrar ediyorsa):
   → ÖNCE read_session_file çağır. Disk'te kalıcı bilgi var mı kontrol et.
   → Varsa: sub-agent çağırmadan direkt cevap ver.
   → Yoksa: normal KARAR AĞACI'nı uygula.
0.5. ⚡ ÖZEL SORULAR — Araç çağırmadan doğrudan şu cevabı ver:
   • "Obsidian entegrasyonun var mı" / "Obsidian'a kaydedebiliyor musun" → ZORUNLU YANIT:
     "Evet! 🟣 generate_report çalıştırdığımda raporlar otomatik olarak Obsidian vault'uma kopyalanır:
     📁 /home/berkayhsrt/Agent_Knowladges/OSINT/OSINT-Agent/04 - Araştırma Raporları/
     Bu syncToObsidian() fonksiyonu ile kod seviyesinde gerçekleşir — manuel kopyalamana gerek yok.
     Obsidian'ı açtığında tüm raporlar hazır olarak bulunur."
1. Kişi/username/email araştırması → ask_identity_agent çağır. İstersen önce 1-2 hızlı search_web ile bağlam toplayabilirsin, ama toplamayı asıl sub-ajan yapar — sen koordinatörsün.
⛔ ask_identity_agent/ask_academic_agent/ask_media_agent tool sonucu döndükten sonra ASLA "araştırma başlatıldı", "ajan çalışıyor", "bekleyin" YAZMA. Tool sonucu = agent TAMAMLANDI. Hemen sonuçları Markdown olarak sun. Gerekirse read_session_file ile tam raporu oku.
2. Görsel/video/haber doğrulama → Önce search_web ile ilgili haberleri ve URL'leri topla. Sonra ask_media_agent çağır — context field'ına topladığın URL'leri ve ham alıntıları yaz. ASLA sadece özet geçme.
3. Akademik araştırma (makale, konu, yayın, araştırmacı, citation) → HEMEN ask_academic_agent çağır.
   ⚠️ FOLLOW-UP İSTİSNASI: Daha önce ask_academic_agent çağrıldıysa ve kullanıcı "hangi makaleler, linkleri neler" gibi follow-up soruyor ise:
   → Kendi history'ndeki [AGENT_DONE] raporundan cevap ver
   → Yeterli değilse: read_session_file aracını çağır (tam makale listesi + linkleri oradan gelir)
4. Graf sorgusu (bağlantılar, istatistik) → query_graph, list_graph_nodes, graph_stats kullan.
5. Rapor isteği ("rapor oluştur", "rapor ver", "raporu kaydet") → HEMEN generate_report çağır.
   📁 NOT: generate_report her çalıştığında rapor otomatik olarak Obsidian vault'a kopyalanır:
   → /home/berkayhsrt/Agent_Knowladges/OSINT/OSINT-Agent/04 - Araştırma Raporları/
   Bu özelliği kullanıcıya belirt.
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
- search_web_multi: Aynı konuyu farklı açılardan aramak için virgülle ayrılmış max 3 sorgu kullan (örn. "free AI slides, AI presentation no signup, gamma app pricing 2025")
- verify_claim: "ücretsiz", "kayıt gerektirmez" gibi iddiaları çoklu bağımsız kaynakla doğrula. Vendor sitesi açıkça yazmıyor diye iddia yanlış DEĞİLDİR — community kaynaklarında arar.

Uzmanlardan gelen raporları değerlendir, analiz et ve kullanıcıya harika bir Markdown formatında (emojiler, listeler, tablolar kullanarak) özetleyerek sun.

� ALT AJAN TAMAMLANDI KURALI:
Bir alt ajandan "[AGENT_DONE]" etiketi içeren yanıt aldıktan sonra:

✅ YAPILACAKLAR:
- Raporu Markdown formatında kullanıcıya sun
- generate_report, query_graph, graph_stats gibi destekleyici araçları çağır
- Alt ajanın raporunu kendi analizinle zenginleştir
- Sub-ajan sonucu SAYFALARsa — o sayfaları web_fetch ile aç, eksik soruyu sen araştır
- Ajan zayıf sonuç döndürdüyse (404, 0 bulgu): o bilgiyi sen search_web ile tamamlayabilirsin

🚫 YAPILMAYACAKLAR:
- Sub-ajanın ZATEN YAPTIĞI sorguları birebir tekrar etme (aynı anahtar kelimelerle aynı araçları)
- Aynı soruyu başka bir alt ajana yeniden devretme
- Aynı ajanı ikinci kez çağırma
- ⛔ ask_academic_agent döndükten sonra aynı konu hakkında search_web YAPMA. Agent zaten araştırdı. Sentezle.
- ⛔ ask_identity_agent döndükten sonra aynı kişi hakkında search_web YAPMA. Agent zaten araştırdı. Sentezle.
- ⛔ ask_media_agent döndükten sonra aynı haber/URL hakkında web_fetch/search_web YAPMA.

Alt ajan grafiği araştırdıysa sen rapor yaz. Alt ajan makale taradıysa sen sentezle. Süpervizörün rolü koordinasyon + sentez, kopyalama değil.
Sub-agent raporu döndüğünde senin işin: raporu formatla, grafı sorgula, gerekirse generate_report çağır. ARAMA DEĞİL.
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
    logger.info('AGENT', `\n🤖 Şef (Supervisor):\n${formatted}\n`);
    return;
  } catch (error) {
    logger.error('AGENT', `Supervisor Hatası: ${error instanceof Error ? error.message : String(error)}`);
  }
}

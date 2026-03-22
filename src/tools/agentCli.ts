/**
 * agentCli.ts — Copilot'un ajanla konuşmasını sağlayan CLI aracı
 * ──────────────────────────────────────────────────────────────────
 * Kullanım:
 *   npx tsx src/tools/agentCli.ts "mesaj buraya"       ← tek mesaj gönder
 *   npx tsx src/tools/agentCli.ts --reset              ← oturumu sıfırla
 *   npx tsx src/tools/agentCli.ts --history            ← geçmişi göster
 *   npx tsx src/tools/agentCli.ts --last               ← son yanıtı göster
 *
 * Oturum .osint-sessions/cli-session.json dosyasında saklanır.
 * Copilot bu aracı run_in_terminal ile çağırarak çok turlu konuşma sürdürür.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { runSupervisor } from '../agents/supervisorAgent.js';
import { closeNeo4j } from '../lib/neo4j.js';
import type { Message } from '../agents/types.js';

const SESSION_DIR  = path.join(process.cwd(), '.osint-sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'cli-session.json');

// ── Oturum yönetimi ──────────────────────────────────────────────────────────
interface CliSession {
  createdAt: string;
  lastActive: string;
  turns: number;
  history: Message[];
}

function loadSession(): CliSession {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as CliSession;
    }
  } catch { /* corrupt file → fresh start */ }
  return { createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), turns: 0, history: [] };
}

function saveSession(session: CliSession): void {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
}

function deleteSession(): void {
  try { if (fs.existsSync(SESSION_FILE)) fs.rmSync(SESSION_FILE); } catch { /* no-op */ }
}

// ── Çıktı formatlayıcı (renksiz — terminale ham metin) ───────────────────────
function plain(text: string): string {
  // ANSI escape kodlarını temizle — Copilot'un okuması için
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

// ── Ana mantık ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // --reset
  if (args[0] === '--reset') {
    deleteSession();
    console.log('[CLI] Oturum sıfırlandı.');
    process.exit(0);
  }

  const session = loadSession();

  // --history
  if (args[0] === '--history') {
    const userMsgs  = session.history.filter(m => m.role === 'user');
    const agentMsgs = session.history.filter(m => m.role === 'assistant');
    console.log(`[SESSION]`);
    console.log(`  Tur sayısı  : ${session.turns}`);
    console.log(`  Soru sayısı : ${userMsgs.length}`);
    console.log(`  Yanıt sayısı: ${agentMsgs.length}`);
    console.log(`  Başlangıç   : ${new Date(session.createdAt).toLocaleString('tr-TR')}`);
    console.log(`  Son aktiflik: ${new Date(session.lastActive).toLocaleString('tr-TR')}`);
    if (userMsgs.length > 0) {
      const lastQ = userMsgs[userMsgs.length - 1];
      const preview = typeof lastQ.content === 'string' ? lastQ.content.slice(0, 100) : '[karmaşık]';
      console.log(`  Son soru    : "${preview}"`);
    }
    process.exit(0);
  }

  // --last (son yanıtı göster)
  if (args[0] === '--last') {
    const lastAssistant = [...session.history].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) {
      console.log('[CLI] Henüz yanıt yok.');
    } else {
      const content = typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : JSON.stringify(lastAssistant.content);
      console.log('[LAST_AGENT_RESPONSE]');
      console.log(plain(content));
      console.log('[/LAST_AGENT_RESPONSE]');
    }
    process.exit(0);
  }

  // Normal mesaj gönderimi
  const message = args.join(' ').trim();
  if (!message) {
    console.error('[CLI] Hata: Mesaj boş. Kullanım: npx tsx src/tools/agentCli.ts "sorunuz"');
    process.exit(1);
  }

  // Session güncelle & ajanı çalıştır
  session.history.push({ role: 'user', content: message });
  session.turns += 1;
  session.lastActive = new Date().toISOString();

  let agentResponse = '';

  // runSupervisor çıktıyı console'a yazar; ama biz yanıtı da yakalamak istiyoruz.
  // Bunun için history'yi doğrudan izliyoruz.
  await runSupervisor(session.history);

  // runSupervisor history'ye assistant mesajı push eder
  const lastMsg = session.history[session.history.length - 1];
  if (lastMsg && lastMsg.role === 'assistant') {
    agentResponse = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg.content);
  }

  // Kaydet
  saveSession(session);

  // Copilot'un parse edebileceği format
  console.log('\n[AGENT_RESPONSE]');
  console.log(plain(agentResponse));
  console.log('[/AGENT_RESPONSE]');
  console.log(`[META] turn=${session.turns} history=${session.history.length} msg`);

  await closeNeo4j();
  process.exit(0);
}

main().catch((e: Error) => {
  console.error('[CLI_ERROR]', e.message);
  process.exit(1);
});

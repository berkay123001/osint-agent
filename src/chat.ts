import 'dotenv/config';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { closeNeo4j } from './lib/neo4j.js';
import { runSupervisor } from './agents/supervisorAgent.js';
import { DEFAULT_MODEL, SUPERVISOR_MODEL } from './agents/baseAgent.js';
import type { Message } from './agents/types.js';

// ── Oturum kalıcılığı ────────────────────────────────────────────────────────
const SESSION_DIR = path.join(process.cwd(), '.osint-sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'last-session.json');

interface SessionData {
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  history: Message[];
}

function loadSession(): SessionData | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

function saveSession(history: Message[]): void {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const data: SessionData = {
      createdAt: existingSession?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: history.length,
      history,
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // sessizce geç — kalıcılık kritik değil
  }
}

function deleteSession(): void {
  try { if (fs.existsSync(SESSION_FILE)) fs.rmSync(SESSION_FILE); } catch { /* no-op */ }
}

// ── Başlatma banneri ─────────────────────────────────────────────────────────
const border   = chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const border2  = chalk.gray('┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄');

console.log(border);
console.log(chalk.bold.white('🕵️  OSINT Dijital Müfettiş') + chalk.magenta(' — Multi-Agent'));
console.log(border2);
console.log(chalk.gray('  Supervisor : ') + chalk.green(SUPERVISOR_MODEL));
console.log(chalk.gray('  Alt ajan   : ') + chalk.green(DEFAULT_MODEL));
console.log(border2);
console.log(chalk.gray('  Özel komutlar:'));
console.log(chalk.gray('    ') + chalk.cyan('!reset') + chalk.gray(' — oturumu temizle, sıfırdan başla'));
console.log(chalk.gray('    ') + chalk.cyan('!history') + chalk.gray(' — geçmiş mesaj sayısını göster'));
console.log(chalk.gray('    ') + chalk.cyan('exit') + chalk.gray(' — çık (oturum kaydedilir)'));
console.log(border);

// ── Oturum yükleme ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let history: Message[] = [];
let existingSession = loadSession();

async function askResume(): Promise<boolean> {
  if (!existingSession) return false;
  const msgCount = existingSession.messageCount;
  const lastDate = new Date(existingSession.lastActiveAt).toLocaleString('tr-TR');
  return new Promise((resolve) => {
    console.log(chalk.yellow(`\n💾 Kayıtlı oturum bulundu:`));
    console.log(chalk.gray(`   Tarih    : ${lastDate}`));
    console.log(chalk.gray(`   Mesajlar : ${msgCount} mesaj`));
    if (msgCount > 0) {
      const last = existingSession!.history.slice(-2).find(m => m.role === 'user');
      if (last) {
        const preview = typeof last.content === 'string'
          ? last.content.slice(0, 80)
          : '[karmaşık mesaj]';
        console.log(chalk.gray(`   Son soru : "${preview}${last.content && typeof last.content === 'string' && last.content.length > 80 ? '…' : ''}"`));
      }
    }
    rl.question(chalk.bold.yellow('\n  Kaldığın yerden devam etsem mi? [E/h] '), (ans) => {
      resolve(ans.trim().toLowerCase() !== 'h');
    });
  });
}

(async () => {
  const resume = await askResume();
  if (resume && existingSession) {
    history = existingSession.history;
    const resumeCount = history.filter(m => m.role === 'user').length;
    console.log(chalk.green(`\n✅ Oturum devam ediyor — ${resumeCount} önceki soru yüklendi.\n`));
  } else {
    deleteSession();
    existingSession = null;
    console.log(chalk.gray('\nYeni oturum başlatıldı.\n'));
  }

  console.log(chalk.gray('Örnek: ') + chalk.cyan('"torvalds GitHub hesabını araştır"'));
  console.log(chalk.gray('       ') + chalk.cyan('"Bu haber doğru mu: [URL]"'));
  console.log(border + '\n');

  prompt();
})();

// ── Ana soru döngüsü ─────────────────────────────────────────────────────────
function prompt() {
  if (!process.stdin.readable) return;
  rl.question(chalk.bold.green('\nSen: '), async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    // Özel komutlar
    if (input.toLowerCase() === 'exit') {
      saveSession(history);
      console.log(chalk.gray('\n💾 Oturum kaydedildi. Görüşürüz!'));
      await closeNeo4j();
      rl.close();
      process.exit(0);
    }

    if (input.toLowerCase() === '!reset') {
      deleteSession();
      history = [];
      existingSession = null;
      console.log(chalk.yellow('🔄 Oturum sıfırlandı. Yeni konuşma başlıyor.\n'));
      prompt();
      return;
    }

    if (input.toLowerCase() === '!history') {
      const userMsgs = history.filter(m => m.role === 'user').length;
      const agentMsgs = history.filter(m => m.role === 'assistant').length;
      console.log(chalk.cyan(`\n📋 Oturum geçmişi: ${userMsgs} soru, ${agentMsgs} yanıt (toplam ${history.length} mesaj)\n`));
      prompt();
      return;
    }

    try {
      history.push({ role: 'user', content: input });
      await runSupervisor(history);
      // Her başarılı yanıttan sonra kaydet
      saveSession(history);
    } catch (e) {
      console.error(chalk.red('\n❌ Hata:'), (e as Error).message);
    }

    prompt();
  });
}

rl.on('close', async () => {
  saveSession(history);
  console.log(chalk.gray('\nOturum kaydedildi.'));
  await closeNeo4j();
  process.exit(0);
});

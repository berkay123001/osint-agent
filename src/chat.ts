import 'dotenv/config';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from './lib/logger.js';
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

// ── Başlatma banneri ──────────────────────────────────────────────────────
function printBanner() {
  const g  = chalk.gray
  const c  = chalk.bold.cyan
  const y  = chalk.bold.yellow
  const d  = chalk.dim

  const art = [
    '',
    g('        ╔═════════════════════════╗'),
    g('        ║   ') + c('G . U . A . R . D') + g('    ║'),
    g('        ╚═══════════╦═════════════╝'),
    g('                    /█\\'),
    g('                   /███\\'),
    g('                  /█████\\'),
    g('                 /███████\\'),
    g('                ───────────'),
    '',
  ]

  art.forEach(line => console.log(line))
  console.log(g('  Supervisor : ') + chalk.green(SUPERVISOR_MODEL))
  console.log(g('  Alt ajan   : ') + chalk.green(DEFAULT_MODEL))
  console.log()
  console.log(
    g('  Komutlar: ') +
    chalk.cyan('/reset') + g(' · ') +
    chalk.cyan('/history') + g(' · ') +
    chalk.cyan('exit')
  )
  console.log(g('  ─────────────────────────────────────────────────────────'))
  console.log()
}

printBanner()

// ── Oturum yükleme ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let history: Message[] = [];
let existingSession = loadSession();

async function askResume(): Promise<boolean> {
  if (!existingSession) return false;
  const msgCount = existingSession.messageCount;
  const lastDate = new Date(existingSession.lastActiveAt).toLocaleString('tr-TR');
  return new Promise((resolve) => {
    console.log(chalk.yellow(`\n  💾 Kayıtlı oturum:`))
    console.log(chalk.dim(`     ${lastDate}  ·  ${msgCount} mesaj`))
    if (msgCount > 0) {
      const last = existingSession!.history.slice(-2).find(m => m.role === 'user');
      if (last) {
        const preview = typeof last.content === 'string'
          ? last.content.slice(0, 70)
          : '[karmaşık mesaj]';
        const ellipsis = typeof last.content === 'string' && last.content.length > 70 ? '…' : ''
        console.log(chalk.dim(`     Son: "${preview}${ellipsis}"`))
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
    console.log(chalk.green(`  ✔ Oturum devam ediyor — ${resumeCount} önceki soru yüklendi.\n`));
  } else {
    deleteSession();
    existingSession = null;
    console.log(chalk.dim('  Yeni oturum başlatıldı.\n'));
  }

  console.log(chalk.dim('  Örnek: ') + chalk.cyan('"torvalds GitHub hesabını araştır"'))
  console.log(chalk.dim('         ') + chalk.cyan('"Bu haber doğru mu: [URL]"'))
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────\n'))

  prompt();
})();

// ── Ana soru döngüsü ─────────────────────────────────────────────────────────
function prompt() {
  if (!process.stdin.readable) return;
  rl.question(chalk.bold.green('\n  ❯ '), async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    // Özel komutlar
    if (input.toLowerCase() === 'exit') {
      saveSession(history);
      console.log(chalk.dim('\n  💾 Oturum kaydedildi. Görüşürüz!'));
      await closeNeo4j();
      rl.close();
      process.exit(0);
    }

    if (input.toLowerCase() === '/reset') {
      deleteSession();
      history = [];
      existingSession = null;
      console.log(chalk.yellow('  🔄 Oturum sıfırlandı. Yeni konuşma başlıyor.\n'));
      prompt();
      return;
    }

    if (input.toLowerCase() === '/history') {
      const userMsgs = history.filter(m => m.role === 'user').length;
      const agentMsgs = history.filter(m => m.role === 'assistant').length;
      console.log(chalk.cyan(`\n  📋 ${userMsgs} soru · ${agentMsgs} yanıt · ${history.length} mesaj\n`));
      prompt();
      return;
    }

    try {
      history.push({ role: 'user', content: input });
      await runSupervisor(history);
      // Her başarılı yanıttan sonra kaydet
      saveSession(history);
    } catch (e) {
      console.log(chalk.red(`\n  ❌ Hata: ${(e as Error).message}`));
    }

    prompt();
  });
}

rl.on('close', async () => {
  saveSession(history);
  console.log(chalk.dim('  Oturum kaydedildi.'));
  await closeNeo4j();
  process.exit(0);
});

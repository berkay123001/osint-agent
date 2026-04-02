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
const SESSION_PREFIX = 'session-';

interface SessionData {
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  history: Message[];
}

/** Tüm kayıtlı oturumları tarih sırasına göre (en yeni ilk) listeler */
function listSessions(): { filename: string; data: SessionData }[] {
  try {
    if (!fs.existsSync(SESSION_DIR)) return [];
    const files = fs.readdirSync(SESSION_DIR)
      .filter(f => f.startsWith(SESSION_PREFIX) && f.endsWith('.json'))
      .sort()
      .reverse(); // en yeni ilk
    return files.map(filename => {
      try {
        const raw = fs.readFileSync(path.join(SESSION_DIR, filename), 'utf-8');
        return { filename, data: JSON.parse(raw) as SessionData };
      } catch {
        return null;
      }
    }).filter((s): s is { filename: string; data: SessionData } => s !== null);
  } catch {
    return [];
  }
}

/** Mevcut aktif oturum dosyasını döner */
function currentSessionFile(): string {
  return path.join(SESSION_DIR, `${SESSION_PREFIX}active.json`);
}

function loadActiveSession(): SessionData | null {
  try {
    const file = currentSessionFile();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

function saveSession(history: Message[]): void {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const data: SessionData = {
      createdAt: activeSessionMeta?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: history.length,
      history,
    };
    fs.writeFileSync(currentSessionFile(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // sessizce geç — kalıcılık kritik değil
  }
}

/** Aktif oturumu tarih damgalı dosyaya arşivler */
function archiveSession(history: Message[]): void {
  try {
    if (history.length === 0) return;
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const createdAt = activeSessionMeta?.createdAt ?? new Date().toISOString();
    const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveFile = path.join(SESSION_DIR, `${SESSION_PREFIX}${timestamp}.json`);
    const data: SessionData = {
      createdAt,
      lastActiveAt: new Date().toISOString(),
      messageCount: history.length,
      history,
    };
    fs.writeFileSync(archiveFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* sessizce geç */ }
}

function deleteActiveSession(): void {
  try { const f = currentSessionFile(); if (fs.existsSync(f)) fs.rmSync(f); } catch { /* no-op */ }
}

// ── Başlatma banneri ──────────────────────────────────────────────────────
function printBanner() {
  const g  = chalk.gray
  const c  = chalk.bold.cyan
  const y  = chalk.bold.yellow
  const d  = chalk.dim

  const art = [
    '',
    g('        ╔════════════════════════╗'),
    g('        ║   ') + c('G . U . A . R . D') + g('   ║'),
    g('        ╚════════════════════════╝'),
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
    chalk.cyan('/resume') + g(' · ') +
    chalk.cyan('exit')
  )
  console.log(g('  ─────────────────────────────────────────────────────────'))
  console.log()
}

printBanner()

// ── Oturum yükleme ───────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let history: Message[] = [];
let activeSessionMeta: { createdAt: string } | null = null;
let existingSession = loadActiveSession();

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

// ── /resume komutu ───────────────────────────────────────────────────────────
function handleResume(): void {
  const sessions = listSessions();

  // Mevcut aktif oturumu da listeye ekle
  const active = loadActiveSession();
  const allSessions: { filename: string; data: SessionData; isActive: boolean }[] = [];
  if (active && active.messageCount > 0) {
    allSessions.push({ filename: '(aktif)', data: active, isActive: true });
  }
  for (const s of sessions) {
    allSessions.push({ ...s, isActive: false });
  }

  if (allSessions.length === 0) {
    console.log(chalk.yellow('\n  📭 Kayıtlı oturum bulunamadı.\n'));
    prompt();
    return;
  }

  console.log(chalk.cyan('\n  📂 Kayıtlı oturumlar:\n'));

  for (let i = 0; i < allSessions.length; i++) {
    const s = allSessions[i];
    const date = new Date(s.data.lastActiveAt).toLocaleString('tr-TR');
    const userMsgs = s.data.history.filter(m => m.role === 'user').length;
    const last = s.data.history.slice(-2).find(m => m.role === 'user');
    const tag = s.isActive ? chalk.green(' [aktif]') : '';
    const num = chalk.bold.white(`${i + 1}.`);

    process.stdout.write(`  ${num} ${chalk.dim(date)} · ${userMsgs} soru${tag}\n`);

    if (last && typeof last.content === 'string') {
      const preview = last.content.slice(0, 60);
      const ellipsis = last.content.length > 60 ? '…' : '';
      console.log(chalk.dim(`     "${preview}${ellipsis}"`));
    }
  }

  console.log();
  rl.question(chalk.bold.yellow('  Devam etmek istediğiniz oturum numarası (iptal: 0): '), (ans) => {
    const idx = parseInt(ans.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > allSessions.length) {
      console.log(chalk.dim('\n  İptal edildi.\n'));
      prompt();
      return;
    }

    const chosen = allSessions[idx - 1];

    // Mevcut oturumu arşivle (eğer farklı bir oturuma geçiliyorsa)
    if (!chosen.isActive && history.length > 0) {
      archiveSession(history);
      console.log(chalk.dim('  💾 Mevcut oturum arşivlendi.'));
    }

    // Seçilen oturumu yükle
    history = chosen.data.history;
    activeSessionMeta = { createdAt: chosen.data.createdAt };

    // Arşivden yüklenen oturumu aktif yap
    if (!chosen.isActive) {
      saveSession(history);
      console.log(chalk.green(`\n  ✔ Oturum yüklendi — ${chosen.data.history.filter(m => m.role === 'user').length} soru, ${new Date(chosen.data.lastActiveAt).toLocaleString('tr-TR')} tarihinden.\n`));
    } else {
      console.log(chalk.green(`\n  ✔ Aktif oturum zaten yüklü.\n`));
    }

    prompt();
  });
}

(async () => {
  const resume = await askResume();
  if (resume && existingSession) {
    history = existingSession.history;
    activeSessionMeta = { createdAt: existingSession.createdAt };
    const resumeCount = history.filter(m => m.role === 'user').length;
    console.log(chalk.green(`  ✔ Oturum devam ediyor — ${resumeCount} önceki soru yüklendi.\n`));
  } else {
    // Kullanici devam etmek istemedi — once arşivle, sonra aktif dosyayı sil
    if (existingSession && existingSession.messageCount > 0) {
      archiveSession(existingSession.history);
      console.log(chalk.dim('  💾 Önceki oturum arşivlendi.'));
    }
    deleteActiveSession();
    activeSessionMeta = null;
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
      archiveSession(history);
      deleteActiveSession();
      console.log(chalk.dim('\n  💾 Oturum arşivlendi. Görüşürüz!'));
      await closeNeo4j();
      rl.close();
      process.exit(0);
    }

    if (input.toLowerCase() === '/reset') {
      archiveSession(history);
      deleteActiveSession();
      history = [];
      activeSessionMeta = null;
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

    if (input.toLowerCase() === '/resume') {
      handleResume();
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

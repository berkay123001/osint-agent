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
    chalk.cyan('/resume') + g(' · ') +
    chalk.cyan('/history') + g(' · ') +
    chalk.cyan('/show') + g(' · ') +
    chalk.cyan('/reset') + g(' · ') +
    chalk.cyan('/help') + g(' · ') +
    chalk.cyan('exit')
  )
  console.log(g('  ─────────────────────────────────────────────────────────'))
  console.log()
}

printBanner()

// ── Oturum yükleme ───────────────────────────────────────────────────────────
const SLASH_COMMANDS = ['/help', '/resume', '/history', '/show', '/reset'];
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  completer: (line: string): [string[], string] => {
    if (line.startsWith('/')) {
      const hits = SLASH_COMMANDS.filter(c => c.startsWith(line));
      return [hits.length ? hits : SLASH_COMMANDS, line];
    }
    return [[], line];
  },
});

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
      console.log(chalk.green(`\n  ✔ Oturum yüklendi — ${chosen.data.history.filter(m => m.role === 'user').length} soru, ${new Date(chosen.data.lastActiveAt).toLocaleString('tr-TR')} tarihinden.`));
    } else {
      console.log(chalk.green(`\n  ✔ Aktif oturum zaten yüklü.`));
    }

    // Yüklenen mesajları terminale yazdır
    printHistory(history);

    prompt();
  });
}

/** Oturum geçmişini terminale okunabilir şekilde yazdırır */
function printHistory(msgs: Message[]): void {
  const visible = msgs.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0
  );
  if (visible.length === 0) return;

  const userCount = visible.filter(m => m.role === 'user').length;
  const asstCount = visible.filter(m => m.role === 'assistant').length;
  console.log(chalk.dim(`\n  ── Yüklenen geçmiş: ${userCount} soru · ${asstCount} yanıt ──────────────────`));

  for (const msg of visible) {
    const content = (msg.content as string).trim();
    if (msg.role === 'user') {
      // Kullanıcı mesajı — tam göster
      console.log(chalk.bold.green('\n  ❯ ') + chalk.white(content));
    } else if (msg.role === 'assistant') {
      // Asistan yanıtı — son 2 mesajı geniş göster, öncekiler kısa
      const isRecent = msg === visible[visible.length - 1] || msg === visible[visible.length - 2];
      const maxLen = isRecent ? 1500 : 400;
      const text = content.length > maxLen
        ? content.slice(0, maxLen) + chalk.dim(` …[+${content.length - maxLen} karakter]`)
        : content;
      const indented = text.split('\n').join('\n     ');
      console.log(chalk.dim('  🤖 ') + indented);
    }
  }
  console.log(chalk.dim('\n  ─────────────────────────────────────────────────────────\n'));
}

(async () => {
  const resume = await askResume();
  if (resume && existingSession) {
    history = existingSession.history;
    activeSessionMeta = { createdAt: existingSession.createdAt };
    const resumeCount = history.filter(m => m.role === 'user').length;
    console.log(chalk.green(`  ✔ Oturum devam ediyor — ${resumeCount} önceki soru yüklendi.`));
    printHistory(history);
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

// ── Paste buffer & ana giriş döngüsü ────────────────────────────────────────
let pasteCounter = 0;
let pasteBuffer: string[] = [];
let pasteTimer: NodeJS.Timeout | null = null;
let isProcessing = false;

const PASTE_TIMEOUT_MS = 15;

rl.setPrompt(chalk.bold.green('\n❯ '));

function prompt(): void {
  if (!process.stdin.readable || isProcessing) return;
  rl.prompt();
}

async function handleUserInput(rawInput: string): Promise<void> {
  const input = rawInput.trim();
  if (!input) { prompt(); return; }

  if (input === '/' || input === '/help') {
    console.log(chalk.cyan('\n  📋 Komutlar:\n'));
    console.log(chalk.white('  /resume') + chalk.dim('   — Kayıtlı oturumları listele ve devam et'));
    console.log(chalk.white('  /history') + chalk.dim('  — Mesaj istatistikleri'));
    console.log(chalk.white('  /show') + chalk.dim('     — Mevcut oturum geçmişini ekrana yazdır'));
    console.log(chalk.white('  /reset') + chalk.dim('    — Oturumu sıfırla'));
    console.log(chalk.white('  exit') + chalk.dim('      — Oturumu arşivle ve çık'));
    console.log();
    prompt();
    return;
  }

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
    const asstMsgs = history.filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()).length;
    const toolMsgs = history.filter(m => m.role === 'tool').length;
    const created = activeSessionMeta?.createdAt
      ? chalk.dim(` · başlangıç: ${new Date(activeSessionMeta.createdAt).toLocaleString('tr-TR')}`)
      : '';
    console.log(chalk.cyan(`\n  📋 ${userMsgs} soru · ${asstMsgs} yanıt · ${toolMsgs} araç çağrısı${created}\n`));
    prompt();
    return;
  }

  if (input.toLowerCase() === '/resume') {
    handleResume();
    return;
  }

  if (input.toLowerCase() === '/show') {
    if (history.length === 0) {
      console.log(chalk.yellow('\n  📭 Henüz mesaj yok.\n'));
    } else {
      printHistory(history);
    }
    prompt();
    return;
  }

  isProcessing = true;
  try {
    history.push({ role: 'user', content: input });
    await runSupervisor(history);
    saveSession(history);
  } catch (e) {
    console.log(chalk.red(`\n  ❌ Hata: ${(e as Error).message}`));
  }
  isProcessing = false;
  prompt();
}

function flushPasteBuffer(): void {
  pasteTimer = null;
  if (pasteBuffer.length === 0) return;
  const lines = pasteBuffer.splice(0);

  if (lines.length > 1) {
    // Çok satırlı paste → onay iste
    pasteCounter++;
    const combined = lines.join('\n');
    const preview = combined.trim().slice(0, 60).replace(/\n/g, ' ');
    const ellipsis = combined.trim().length > 60 ? '…' : '';
    console.log(chalk.yellow(`\n  [paste #${pasteCounter}: "${preview}${ellipsis}" +${lines.length} satır]`));
    rl.question(chalk.bold.yellow('  Gönder? [E/h] '), (ans) => {
      if (ans.trim().toLowerCase() === 'h') {
        console.log(chalk.dim('  İptal edildi.'));
        prompt();
      } else {
        handleUserInput(combined);
      }
    });
  } else {
    // Tek satır — normal gönder
    handleUserInput(lines[0]);
  }
}

rl.on('line', (line: string) => {
  if (isProcessing) return;
  pasteBuffer.push(line);
  if (pasteTimer) clearTimeout(pasteTimer);
  pasteTimer = setTimeout(flushPasteBuffer, PASTE_TIMEOUT_MS);
});

rl.on('close', async () => {
  saveSession(history);
  console.log(chalk.dim('  Oturum kaydedildi.'));
  await closeNeo4j();
  process.exit(0);
});

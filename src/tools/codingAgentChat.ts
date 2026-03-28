/**
 * codingAgentChat.ts — Kodlama agent'larının (Claude Code, Copilot, vs.)
 * OSINT agent ile insana benzer şekilde sohbet etmesini sağlayan tool.
 *
 * Fark: agentCli.ts'ten farklı olarak:
 *   - stdout → yapılandırılmış JSON (makine-okunur)
 *   - stderr → log mesajları (LOG_LEVEL ile kontrol)
 *   - İsimlendirilmiş oturumlar (paralel araştırma desteği)
 *   - Daha iyi hata yönetimi
 *
 * Kullanım:
 *   npx tsx src/tools/codingAgentChat.ts "torvalds GitHub hesabını araştır"
 *   npx tsx src/tools/codingAgentChat.ts -s research1 "email adreslerini kontrol et"
 *   npx tsx src/tools/codingAgentChat.ts --reset
 *   npx tsx src/tools/codingAgentChat.ts --reset -s research1
 *   npx tsx src/tools/codingAgentChat.ts --history
 *   npx tsx src/tools/codingAgentChat.ts --sessions
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { runSupervisor } from '../agents/supervisorAgent.js';
import { closeNeo4j } from '../lib/neo4j.js';
import { logger } from '../lib/logger.js';
import type { Message } from '../agents/types.js';

// ── Tipler ──────────────────────────────────────────────────────────────────

interface ChatSession {
  id: string;
  createdAt: string;
  lastActive: string;
  turns: number;
  history: Message[];
}

interface ChatResponse {
  ok: boolean;
  action: 'chat' | 'reset' | 'history' | 'sessions';
  response?: string;
  turn?: number;
  historyLength?: number;
  session?: { id: string; createdAt: string; turns: number };
  sessions?: Array<{ id: string; turns: number; lastActive: string }>;
  error?: string;
}

// ── Sabitler ────────────────────────────────────────────────────────────────

const SESSION_DIR = path.join(process.cwd(), '.osint-sessions', 'coding-agent');
const DEFAULT_SESSION = 'default';

// ── Oturum yönetimi ─────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function sessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.json`);
}

function loadSession(id: string): ChatSession {
  const file = sessionPath(id);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as ChatSession;
    }
  } catch {
    logger.warn('SYSTEM', `Oturum dosyası bozuk: ${id}, yeni oturum başlatılıyor`);
  }
  return {
    id,
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    turns: 0,
    history: [],
  };
}

function saveSession(session: ChatSession): void {
  ensureDir();
  session.lastActive = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
}

function deleteSession(id: string): void {
  try {
    const file = sessionPath(id);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
    }
  } catch { /* no-op */ }
}

function listSessions(): Array<{ id: string; turns: number; lastActive: string }> {
  ensureDir();
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const s = JSON.parse(
          fs.readFileSync(path.join(SESSION_DIR, f), 'utf-8')
        ) as ChatSession;
        return { id: s.id, turns: s.turns, lastActive: s.lastActive };
      } catch {
        return { id: f.replace('.json', ''), turns: 0, lastActive: 'unknown' };
      }
    });
  } catch {
    return [];
  }
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

function outputJson(response: ChatResponse): void {
  process.stdout.write(JSON.stringify(response, null, 2) + '\n');
}

// ── Argüman parse ───────────────────────────────────────────────────────────

interface ParsedArgs {
  action: 'chat' | 'reset' | 'history' | 'sessions';
  message: string;
  sessionId: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let action: ParsedArgs['action'] = 'chat';
  let sessionId = DEFAULT_SESSION;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reset') {
      action = 'reset';
    } else if (arg === '--history') {
      action = 'history';
    } else if (arg === '--sessions') {
      action = 'sessions';
    } else if ((arg === '-s' || arg === '--session') && args[i + 1]) {
      sessionId = args[++i];
    } else {
      positional.push(arg);
    }
  }

  return { action, message: positional.join(' ').trim(), sessionId };
}

// ── Session info yardımcısı ─────────────────────────────────────────────────

function sessionInfo(s: ChatSession): { id: string; createdAt: string; turns: number } {
  return { id: s.id, createdAt: s.createdAt, turns: s.turns };
}

// ── Ana mantık ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { action, message, sessionId } = parseArgs(process.argv.slice(2));

  // ── Oturum listesi ───────────────────────────────────────────────────
  if (action === 'sessions') {
    outputJson({ ok: true, action: 'sessions', sessions: listSessions() });
    return;
  }

  // ── Sıfırlama ────────────────────────────────────────────────────────
  if (action === 'reset') {
    deleteSession(sessionId);
    logger.info('SYSTEM', `Oturum sıfırlandı: ${sessionId}`);
    outputJson({
      ok: true,
      action: 'reset',
      session: { id: sessionId, createdAt: new Date().toISOString(), turns: 0 },
    });
    return;
  }

  // ── Geçmiş ───────────────────────────────────────────────────────────
  if (action === 'history') {
    const session = loadSession(sessionId);
    outputJson({
      ok: true,
      action: 'history',
      turn: session.turns,
      historyLength: session.history.length,
      session: sessionInfo(session),
    });
    return;
  }

  // ── Sohbet ───────────────────────────────────────────────────────────
  if (!message) {
    outputJson({
      ok: false,
      action: 'chat',
      error: 'Mesaj boş. Kullanım: npx tsx src/tools/codingAgentChat.ts "mesajınız"',
    });
    process.exitCode = 1;
    return;
  }

  const session = loadSession(sessionId);
  session.history.push({ role: 'user', content: message });
  session.turns += 1;

  logger.info('SYSTEM', `[CodingAgent→OSINT] Tur ${session.turns}: "${message.slice(0, 80)}"`);

  try {
    await runSupervisor(session.history);
  } catch (error) {
    outputJson({
      ok: false,
      action: 'chat',
      error: `Agent hatası: ${(error as Error).message}`,
      session: sessionInfo(session),
    });
    process.exitCode = 1;
    await closeNeo4j();
    return;
  }

  // Yanıtı history'den çıkar
  const lastMsg = session.history[session.history.length - 1];
  const response =
    lastMsg && lastMsg.role === 'assistant'
      ? stripAnsi(
          typeof lastMsg.content === 'string'
            ? lastMsg.content
            : JSON.stringify(lastMsg.content)
        )
      : '';

  saveSession(session);

  outputJson({
    ok: true,
    action: 'chat',
    response,
    turn: session.turns,
    historyLength: session.history.length,
    session: sessionInfo(session),
  });

  await closeNeo4j();
}

main().catch((e: Error) => {
  outputJson({
    ok: false,
    action: 'chat',
    error: `Beklenmeyen hata: ${e.message}`,
  });
  process.exitCode = 1;
});

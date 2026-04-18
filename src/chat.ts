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

// ── Session persistence ────────────────────────────────────────────────────────
const SESSION_DIR = path.join(process.cwd(), '.osint-sessions');
const SESSION_PREFIX = 'session-';

interface SessionData {
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  history: Message[];
}

/** Lists all saved sessions in date order (newest first) */
function listSessions(): { filename: string; data: SessionData }[] {
  try {
    if (!fs.existsSync(SESSION_DIR)) return [];
    const files = fs.readdirSync(SESSION_DIR)
      .filter(f => f.startsWith(SESSION_PREFIX) && f.endsWith('.json'))
      .sort()
      .reverse(); // newest first
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

/** Returns the current active session file path */
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
    // skip silently — persistence is not critical
  }
}

/** Archives the active session to a timestamped file */
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
  } catch { /* skip silently */ }
}

function deleteActiveSession(): void {
  try { const f = currentSessionFile(); if (fs.existsSync(f)) fs.rmSync(f); } catch { /* no-op */ }
}

// ── Startup banner ──────────────────────────────────────────────────────
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
  console.log(g('  Sub-agent  : ') + chalk.green(DEFAULT_MODEL))
  console.log()
  console.log(
    g('  Commands: ') +
    chalk.cyan('/resume') + g(' · ') +
    chalk.cyan('/history') + g(' · ') +
    chalk.cyan('/show') + g(' · ') +
    chalk.cyan('/delete') + g(' · ') +
    chalk.cyan('/reset') + g(' · ') +
    chalk.cyan('/logs') + g(' · ') +
    chalk.cyan('/help') + g(' · ') +
    chalk.cyan('exit')
  )
  console.log(g('  ─────────────────────────────────────────────────────────'))
  console.log()
}

printBanner()

// ── Session loading ───────────────────────────────────────────────────────────
const SLASH_COMMANDS = ['/delete', '/help', '/history', '/logs', '/reset', '/resume', '/show'];
const CMD_DESCRIPTIONS: Record<string, string> = {
  '/delete':  'Delete session',
  '/help':    'List commands',
  '/history': 'Message statistics',
  '/logs':    'Export tool calls to file',
  '/reset':   'Reset session',
  '/resume':  'Load saved session',
  '/show':    'Print history to screen',
};

// ── Numbered command menu (type / + Enter to open, select by number, 0/Enter=cancel) ──────
function showCommandMenu(): Promise<void> {
  const maxLen = Math.max(...SLASH_COMMANDS.map(c => c.length));
  console.log(chalk.cyan('\n  Commands:\n'));
  for (let i = 0; i < SLASH_COMMANDS.length; i++) {
    const cmd = SLASH_COMMANDS[i];
    const num = chalk.bold.white(`${i + 1}.`);
    const pad = ' '.repeat(maxLen - cmd.length + 2);
    console.log(`  ${num} ${chalk.bold.cyan(cmd)}${pad}${chalk.dim(CMD_DESCRIPTIONS[cmd])}`);
  }
  console.log();

  return new Promise((resolve) => {
    rl.question(chalk.bold.yellow(`  Selection (1–${SLASH_COMMANDS.length}, Enter=cancel): `), (ans) => {
      const trimmed = ans.trim();
      if (!trimmed) { prompt(); resolve(); return; }
      const idx = parseInt(trimmed, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= SLASH_COMMANDS.length) {
        const cmd = SLASH_COMMANDS[idx - 1];
        handleUserInput(cmd).then(resolve);
      } else {
        console.log(chalk.dim('  Cancelled.\n'));
        prompt();
        resolve();
      }
    });
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

let history: Message[] = [];
let activeSessionMeta: { createdAt: string } | null = null;
let existingSession = loadActiveSession();

async function askResume(): Promise<boolean> {
  if (!existingSession) return false;
  const msgCount = existingSession.messageCount;
  const lastDate = new Date(existingSession.lastActiveAt).toLocaleString('en-US');
  return new Promise((resolve) => {
    console.log(chalk.yellow(`\n  💾 Saved session:`))
    console.log(chalk.dim(`     ${lastDate}  ·  ${msgCount} messages`))
    if (msgCount > 0) {
      const last = existingSession!.history.slice(-2).find(m => m.role === 'user');
      if (last) {
        const preview = typeof last.content === 'string'
          ? last.content.slice(0, 70)
          : '[complex message]';
        const ellipsis = typeof last.content === 'string' && last.content.length > 70 ? '…' : ''
        console.log(chalk.dim(`     Son: "${preview}${ellipsis}"`))
      }
    }
    rl.question(chalk.bold.yellow('\n  Resume from where you left off? [Y/n] '), (ans) => {
      resolve(ans.trim().toLowerCase() !== 'n');
    });
  });
}

// ── /resume command ───────────────────────────────────────────────────────────
function handleResume(): void {
  const sessions = listSessions();

  // Also include the currently active session in the list
  const active = loadActiveSession();
  const allSessions: { filename: string; data: SessionData; isActive: boolean }[] = [];
  if (active && active.messageCount > 0) {
    allSessions.push({ filename: '(active)', data: active, isActive: true });
  }
  for (const s of sessions) {
    allSessions.push({ ...s, isActive: false });
  }

  if (allSessions.length === 0) {
    console.log(chalk.yellow('\n  📭 No saved session found.\n'));
    prompt();
    return;
  }

  console.log(chalk.cyan('\n  📂 Saved sessions:\n'));

  for (let i = 0; i < allSessions.length; i++) {
    const s = allSessions[i];
    const date = new Date(s.data.lastActiveAt).toLocaleString('en-US');
    const userMsgs = s.data.history.filter(m => m.role === 'user').length;
    const last = s.data.history.slice(-2).find(m => m.role === 'user');
    const tag = s.isActive ? chalk.green(' [active]') : '';
    const num = chalk.bold.white(`${i + 1}.`);

    process.stdout.write(`  ${num} ${chalk.dim(date)} · ${userMsgs} messages${tag}\n`);

    if (last && typeof last.content === 'string') {
      const preview = last.content.slice(0, 60);
      const ellipsis = last.content.length > 60 ? '…' : '';
      console.log(chalk.dim(`     "${preview}${ellipsis}"`));
    }
  }

  console.log();
  rl.question(chalk.bold.yellow('  Session number to resume (cancel: 0): '), (ans) => {
    const idx = parseInt(ans.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > allSessions.length) {
      console.log(chalk.dim('\n  Cancelled.\n'));
      prompt();
      return;
    }

    const chosen = allSessions[idx - 1];

    // Archive current session (if switching to a different session)
    if (!chosen.isActive && history.length > 0) {
      archiveSession(history);
      console.log(chalk.dim('  💾 Current session archived.'));
    }

    // Load the selected session
    history = chosen.data.history;
    activeSessionMeta = { createdAt: chosen.data.createdAt };

    // Make the loaded session the active one
    if (!chosen.isActive) {
      saveSession(history);
      console.log(chalk.green(`\n  ✔ Session loaded — ${chosen.data.history.filter(m => m.role === 'user').length} messages from ${new Date(chosen.data.lastActiveAt).toLocaleString('en-US')}.`));
    } else {
      console.log(chalk.green(`\n  ✔ Active session already loaded.`));
    }

    // Print loaded messages to terminal
    printHistory(history);

    prompt();
  });
}

/** Prints session history to terminal in a readable format */
function printHistory(msgs: Message[]): void {
  const visible = msgs.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0
  );
  if (visible.length === 0) return;

  const userCount = visible.filter(m => m.role === 'user').length;
  const asstCount = visible.filter(m => m.role === 'assistant').length;
  console.log(chalk.dim(`\n  ── Loaded history: ${userCount} questions · ${asstCount} answers ──────────────────`));

  for (const msg of visible) {
    const content = (msg.content as string).trim();
    if (msg.role === 'user') {
      // User message — show in full
      console.log(chalk.bold.green('\n  ❯ ') + chalk.white(content));
    } else if (msg.role === 'assistant') {
      // Assistant reply — show last 2 messages in full, earlier ones abbreviated
      const isRecent = msg === visible[visible.length - 1] || msg === visible[visible.length - 2];
      const maxLen = isRecent ? 1500 : 400;
      const text = content.length > maxLen
        ? content.slice(0, maxLen) + chalk.dim(` …[+${content.length - maxLen} chars]`)
        : content;
      const indented = text.split('\n').join('\n     ');
      console.log(chalk.dim('  🤖 ') + indented);
    }
  }
  console.log(chalk.dim('\n  ─────────────────────────────────────────────────────────\n'));
}

/** Exports all tool calls in the current history to a timestamped file */
function handleLogs(): void {
  if (history.length === 0) {
    console.log(chalk.yellow('\n  📭 No tool calls yet.\n'));
    prompt();
    return;
  }

  type AssistantMsg = Message & { tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  const toolCallMsgs = history.filter(
    (m): m is AssistantMsg => m.role === 'assistant' && Array.isArray((m as AssistantMsg).tool_calls) && ((m as AssistantMsg).tool_calls!.length > 0)
  );
  const toolResults = history.filter(m => m.role === 'tool') as (Message & { tool_call_id?: string; content: string })[];

  if (toolCallMsgs.length === 0) {
    console.log(chalk.yellow('\n  📭 No tool calls found in this session.\n'));
    prompt();
    return;
  }

  // tool_call_id → result content map
  const resultMap = new Map<string, string>();
  for (const r of toolResults) {
    if (r.tool_call_id) {
      resultMap.set(r.tool_call_id, typeof r.content === 'string' ? r.content : JSON.stringify(r.content));
    }
  }

  const lines: string[] = [
    `# OSINT Tool Call Log`,
    `**Date:** ${new Date().toLocaleString('en-US')}`,
    `**Total tool calls:** ${toolResults.length}`,
    '',
  ];

  let callIndex = 0;
  for (const msg of toolCallMsgs) {
    for (const tc of msg.tool_calls!) {
      callIndex += 1;
      let args: unknown;
      try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }
      const result = resultMap.get(tc.id) ?? '(result not found)';
      const truncated = result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result;

      lines.push(`## ${callIndex}. \`${tc.function.name}\``);
      lines.push('**Parameters:**');
      lines.push('```json');
      lines.push(JSON.stringify(args, null, 2));
      lines.push('```');
      lines.push('**Result:**');
      lines.push('```');
      lines.push(truncated);
      lines.push('```');
      lines.push('');
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(SESSION_DIR, `logs-${timestamp}.md`);
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');

  console.log(chalk.green(`\n  ✅ ${callIndex} tool calls exported:`));
  console.log(chalk.bold.white(`     ${outPath}\n`));
  prompt();
}

/** Lists saved sessions and deletes the selected one */
function handleDelete(): void {
  const sessions = listSessions();
  const active = loadActiveSession();
  const allSessions: { filename: string; isActive: boolean; data: SessionData }[] = [];
  if (active && active.messageCount > 0) {
    allSessions.push({ filename: '(active)', isActive: true, data: active });
  }
  for (const s of sessions) {
    allSessions.push({ filename: s.filename, isActive: false, data: s.data });
  }

  if (allSessions.length === 0) {
    console.log(chalk.yellow('\n  📭 No session found to delete.\n'));
    prompt();
    return;
  }

  console.log(chalk.cyan('\n  🗑️  Saved sessions:\n'));
  for (let i = 0; i < allSessions.length; i++) {
    const s = allSessions[i];
    const date = new Date(s.data.lastActiveAt).toLocaleString('en-US');
    const userMsgs = s.data.history.filter(m => m.role === 'user').length;
    const tag = s.isActive ? chalk.green(' [active]') : '';
    process.stdout.write(`  ${chalk.bold.white(`${i + 1}.`)} ${chalk.dim(date)} · ${userMsgs} messages${tag}\n`);
    const last = s.data.history.slice(-2).find(m => m.role === 'user');
    if (last && typeof last.content === 'string') {
      const preview = last.content.slice(0, 60);
      const ellipsis = last.content.length > 60 ? '…' : '';
      console.log(chalk.dim(`     "${preview}${ellipsis}"`));
    }
  }
  console.log('\n  ' + chalk.bold.yellow('all') + chalk.dim(' — Delete all'));
  console.log();

  rl.question(chalk.bold.yellow('  Session to delete (cancel: 0): '), (ans) => {
    const trimmed = ans.trim().toLowerCase();
    if (trimmed === '0' || trimmed === '' || trimmed === 'cancel') {
      console.log(chalk.dim('\n  Cancelled.\n'));
      prompt();
      return;
    }
    if (trimmed === 'all') {
      let deleted = 0;
      for (const s of allSessions) {
        if (s.isActive) {
          deleteActiveSession();
          history = [];
          activeSessionMeta = null;
        } else {
          try { fs.rmSync(path.join(SESSION_DIR, s.filename)); } catch { /* no-op */ }
        }
        deleted++;
      }
      console.log(chalk.green(`\n  ✔ ${deleted} session(s) deleted.\n`));
      prompt();
      return;
    }
    const idx = parseInt(trimmed, 10);
    if (isNaN(idx) || idx < 1 || idx > allSessions.length) {
      console.log(chalk.red('\n  Invalid selection.\n'));
      prompt();
      return;
    }
    const chosen = allSessions[idx - 1];
    if (chosen.isActive) {
      deleteActiveSession();
      history = [];
      activeSessionMeta = null;
    } else {
      try { fs.rmSync(path.join(SESSION_DIR, chosen.filename)); } catch { /* no-op */ }
    }
    console.log(chalk.green('\n  ✔ Session deleted.\n'));
    prompt();
  });
}

(async () => {
  const resume = await askResume();
  if (resume && existingSession) {
    history = existingSession.history;
    activeSessionMeta = { createdAt: existingSession.createdAt };
    const resumeCount = history.filter(m => m.role === 'user').length;
    console.log(chalk.green(`  ✔ Resuming session — ${resumeCount} previous messages loaded.`));
    printHistory(history);
  } else {
    // User chose not to resume — archive first, then delete active file
    if (existingSession && existingSession.messageCount > 0) {
      archiveSession(existingSession.history);
      console.log(chalk.dim('  💾 Previous session archived.'));
    }
    deleteActiveSession();
    activeSessionMeta = null;
    console.log(chalk.dim('  New session started.\n'));
  }

  console.log(chalk.dim('  Example: ') + chalk.cyan('"investigate torvalds GitHub account"'))
  console.log(chalk.dim('           ') + chalk.cyan('"Is this news accurate: [URL]"'))
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────\n'))

  prompt();
})();

// ── Paste buffer & main input loop ────────────────────────────────────────
let pasteCounter = 0;
let pasteBuffer: string[] = [];
let pasteTimer: NodeJS.Timeout | null = null;
let isProcessing = false;

const PASTE_TIMEOUT_MS = 80;

rl.setPrompt(chalk.bold.green('\n❯ '));

function prompt(): void {
  if (!process.stdin.readable || isProcessing) return;
  rl.prompt();
}

async function handleUserInput(rawInput: string): Promise<void> {
  const input = rawInput.trim();
  if (!input) { prompt(); return; }

  if (input === '/' || input === '/help') {
    await showCommandMenu();
    return;
  }

  if (input.toLowerCase() === 'exit') {
    archiveSession(history);
    deleteActiveSession();
    console.log(chalk.dim('\n  💾 Session archived. Goodbye!'));
    await closeNeo4j();
    rl.close();
    process.exit(0);
  }

  if (input.toLowerCase() === '/reset') {
    archiveSession(history);
    deleteActiveSession();
    history = [];
    activeSessionMeta = null;
    console.log(chalk.yellow('  🔄 Session reset. Starting new conversation.\n'));
    prompt();
    return;
  }

  if (input.toLowerCase() === '/history') {
    const userMsgs = history.filter(m => m.role === 'user').length;
    const asstMsgs = history.filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()).length;
    const toolMsgs = history.filter(m => m.role === 'tool').length;
    const created = activeSessionMeta?.createdAt
      ? chalk.dim(` · started: ${new Date(activeSessionMeta.createdAt).toLocaleString('en-US')}`)
      : '';
    console.log(chalk.cyan(`\n  📋 ${userMsgs} questions · ${asstMsgs} answers · ${toolMsgs} tool calls${created}\n`));
    prompt();
    return;
  }

  if (input.toLowerCase() === '/resume') {
    handleResume();
    return;
  }

  if (input.toLowerCase() === '/show') {
    if (history.length === 0) {
      console.log(chalk.yellow('\n  📭 No messages yet.\n'));
    } else {
      printHistory(history);
    }
    prompt();
    return;
  }

  if (input.toLowerCase() === '/logs') {
    handleLogs();
    return;
  }

  if (input.toLowerCase() === '/delete') {
    handleDelete();
    return;
  }

  isProcessing = true;
  try {
    history.push({ role: 'user', content: input });
    await runSupervisor(history);
    saveSession(history);
  } catch (e) {
    console.log(chalk.red(`\n  ❌ Error: ${(e as Error).message}`));
  }
  isProcessing = false;
  prompt();
}

let pendingPaste: string | null = null;

function flushPasteBuffer(): void {
  pasteTimer = null;
  if (pasteBuffer.length === 0) return;
  const lines = pasteBuffer.splice(0);
  const combined = lines.join('\n');
  if (lines.length > 1) {
    // Multi-line paste: show preview, wait for Enter
    pasteCounter++;
    const preview = combined.trim().slice(0, 60).replace(/\n/g, ' ');
    const ellipsis = combined.trim().length > 60 ? '…' : '';
    pendingPaste = combined;
    process.stdout.write(chalk.yellow(`\n  [paste #${pasteCounter}: "${preview}${ellipsis}" +${lines.length} lines]\n`));
    process.stdout.write(chalk.dim('  ↵ press Enter to send, type new message or Ctrl+C to cancel\n'));
    prompt();
  } else {
    // Single line: treat as normal input
    handleUserInput(combined);
  }
}

rl.on('line', (line: string) => {
  if (isProcessing) return;

  // If there's a pending paste: empty Enter → send it, new text → cancel old paste and send new text
  if (pendingPaste !== null) {
    const toSend = line.trim() ? line : pendingPaste;
    pendingPaste = null;
    handleUserInput(toSend);
    return;
  }

  pasteBuffer.push(line);
  if (pasteTimer) clearTimeout(pasteTimer);
  pasteTimer = setTimeout(flushPasteBuffer, PASTE_TIMEOUT_MS);
});

// Keypress events are no longer used — all input is handled via rl.on('line')

rl.on('close', async () => {
  saveSession(history);
  console.log(chalk.dim('  Session saved.'));
  await closeNeo4j();
  process.exit(0);
});

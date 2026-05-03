/**
 * agentCli.ts — CLI tool enabling Copilot to chat with the OSINT agent
 * ──────────────────────────────────────────────────────────────────
 * Usage:
 *   npx tsx src/tools/agentCli.ts "your message"          ← send a single message
 *   npx tsx src/tools/agentCli.ts --reset                 ← reset session
 *   npx tsx src/tools/agentCli.ts --history               ← show history
 *   npx tsx src/tools/agentCli.ts --last                  ← show last response
 *
 * Session is persisted in .osint-sessions/cli-session.json
 * Copilot calls this tool via run_in_terminal to maintain multi-turn conversations.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { runSupervisor } from '../agents/supervisorAgent.js';
import { closeNeo4j } from '../lib/neo4j.js';
import type { Message } from '../agents/types.js';

const SESSION_DIR  = path.join(process.cwd(), '.osint-sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'cli-session.json');

// ── Session management ──────────────────────────────────────────────────────────
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

// ── Output formatter (no colour — raw text for terminal) ───────────────────────
function plain(text: string): string {
  // Strip ANSI escape codes — for Copilot readability
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

// ── Main logic ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // --reset
  if (args[0] === '--reset') {
    deleteSession();
    console.log('[CLI] Session reset.');
    process.exit(0);
  }

  const session = loadSession();

  // --history
  if (args[0] === '--history') {
    const userMsgs  = session.history.filter(m => m.role === 'user');
    const agentMsgs = session.history.filter(m => m.role === 'assistant');
    console.log(`[SESSION]`);
    console.log(`  Turns       : ${session.turns}`);
    console.log(`  Questions   : ${userMsgs.length}`);
    console.log(`  Responses   : ${agentMsgs.length}`);
    console.log(`  Started     : ${new Date(session.createdAt).toLocaleString('en-US')}`);
    console.log(`  Son aktiflik: ${new Date(session.lastActive).toLocaleString('tr-TR')}`);
    if (userMsgs.length > 0) {
      const lastQ = userMsgs[userMsgs.length - 1];
      const preview = typeof lastQ.content === 'string' ? lastQ.content.slice(0, 100) : '[complex]';
      console.log(`  Son soru    : "${preview}"`);
    }
    process.exit(0);
  }

  // --last (show last response)
  if (args[0] === '--last') {
    const lastAssistant = [...session.history].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) {
      console.log('[CLI] No response yet.');
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

  // Normal message send
  const message = args.join(' ').trim();
  if (!message) {
    console.error('[CLI] Error: Message is empty. Usage: npx tsx src/tools/agentCli.ts "your question"');
    process.exit(1);
  }

  // Update session & run agent
  session.history.push({ role: 'user', content: message });
  session.turns += 1;
  session.lastActive = new Date().toISOString();

  let agentResponse = '';

  // runSupervisor mutates session.history (via runAgentLoop's pushHistory) and also returns finalResponse
  const supervisorResult = await runSupervisor(session.history);

  if (supervisorResult) {
    // Prefer returned finalResponse (covers both normal loop and pre-routing paths)
    agentResponse = supervisorResult.finalResponse;
    // Sync history if pre-routing returned a different array reference
    if (supervisorResult.history !== session.history) {
      session.history = supervisorResult.history;
    }
  } else {
    // Fallback: read last assistant message from mutated history
    const lastMsg = session.history[session.history.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      agentResponse = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : JSON.stringify(lastMsg.content);
    }
  }

  // Kaydet
  saveSession(session);

  // Format that Copilot can parse
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

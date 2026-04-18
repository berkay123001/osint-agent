import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../agents/types.js';

const SESSION_DIR = path.join(process.cwd(), '.osint-sessions');
const SESSION_PREFIX = 'session-';

export interface SessionData {
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  history: Message[];
}

export interface SessionEntry {
  filename: string;
  data: SessionData;
  isActive: boolean;
}

function currentSessionFile(): string {
  return path.join(SESSION_DIR, `${SESSION_PREFIX}active.json`);
}

export function listSessions(): SessionEntry[] {
  try {
    if (!fs.existsSync(SESSION_DIR)) return [];
    const files = fs.readdirSync(SESSION_DIR)
      .filter(f => f.startsWith(SESSION_PREFIX) && f.endsWith('.json') && f !== `${SESSION_PREFIX}active.json`)
      .sort()
      .reverse();
    return files.map(filename => {
      try {
        const raw = fs.readFileSync(path.join(SESSION_DIR, filename), 'utf-8');
        return { filename, data: JSON.parse(raw) as SessionData, isActive: false };
      } catch {
        return null;
      }
    }).filter((s): s is SessionEntry => s !== null);
  } catch {
    return [];
  }
}

export function loadActiveSession(): SessionData | null {
  try {
    const file = currentSessionFile();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionData;
  } catch {
    return null;
  }
}

export function saveSession(history: Message[], createdAt?: string): void {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const data: SessionData = {
      createdAt: createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: history.length,
      history,
    };
    fs.writeFileSync(currentSessionFile(), JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* silently skip */ }
}

export function archiveSession(history: Message[], createdAt?: string): void {
  try {
    if (history.length === 0) return;
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const ts = new Date(createdAt ?? new Date().toISOString())
      .toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveFile = path.join(SESSION_DIR, `${SESSION_PREFIX}${ts}.json`);
    const data: SessionData = {
      createdAt: createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: history.length,
      history,
    };
    fs.writeFileSync(archiveFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* silently skip */ }
}

export function deleteActiveSession(): void {
  try {
    const f = currentSessionFile();
    if (fs.existsSync(f)) fs.rmSync(f);
  } catch { /* no-op */ }
}

export function deleteSession(filename: string): void {
  try {
    fs.rmSync(path.join(SESSION_DIR, filename));
  } catch { /* no-op */ }
}

export function deleteAllSessions(): number {
  const sessions = listSessions();
  let count = 0;
  for (const s of sessions) {
    try { fs.rmSync(path.join(SESSION_DIR, s.filename)); count++; } catch { /* no-op */ }
  }
  deleteActiveSession();
  return count + 1;
}

import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../agents/types.js';

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

function sessionDir(): string {
  return process.env.OSINT_SESSION_DIR || path.join(process.cwd(), '.osint-sessions');
}

function currentSessionFile(): string {
  return path.join(sessionDir(), `${SESSION_PREFIX}active.json`);
}

function listSessionFilenames(): string[] {
  try {
    if (!fs.existsSync(sessionDir())) return [];
    return fs.readdirSync(sessionDir())
      .filter(filename => filename.startsWith(SESSION_PREFIX) && filename.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function hasStoredSessions(): boolean {
  return listSessionFilenames().length > 0;
}

export function listSessions(): SessionEntry[] {
  try {
    if (!fs.existsSync(sessionDir())) return [];
    const files = fs.readdirSync(sessionDir())
      .filter(f => f.startsWith(SESSION_PREFIX) && f.endsWith('.json') && f !== `${SESSION_PREFIX}active.json`)
      .sort()
      .reverse();
    return files.map(filename => {
      try {
        const raw = fs.readFileSync(path.join(sessionDir(), filename), 'utf-8');
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

export function listDeletableSessions(): SessionEntry[] {
  const archivedSessions = listSessions();
  const activeSession = loadActiveSession();

  if (!activeSession) return archivedSessions;
  if (archivedSessions.some(session => session.data.createdAt === activeSession.createdAt)) {
    return archivedSessions.map((session) => ({
      ...session,
      isActive: session.data.createdAt === activeSession.createdAt,
    }));
  }

  return [
    {
      filename: path.basename(currentSessionFile()),
      data: activeSession,
      isActive: true,
    },
    ...archivedSessions,
  ];
}

export function saveSession(history: Message[], createdAt?: string): void {
  try {
    if (!fs.existsSync(sessionDir())) fs.mkdirSync(sessionDir(), { recursive: true });
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
    if (!fs.existsSync(sessionDir())) fs.mkdirSync(sessionDir(), { recursive: true });
    const ts = new Date(createdAt ?? new Date().toISOString())
      .toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveFile = path.join(sessionDir(), `${SESSION_PREFIX}${ts}.json`);
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
    fs.rmSync(path.join(sessionDir(), filename));
  } catch { /* no-op */ }
}

export function deleteSessionsByCreatedAt(createdAt: string): number {
  let deleted = 0;

  for (const session of listSessions()) {
    if (session.data.createdAt !== createdAt) continue;
    deleteSession(session.filename);
    deleted++;
  }

  const activeSession = loadActiveSession();
  if (activeSession?.createdAt === createdAt) {
    deleteActiveSession();
    deleted++;
  }

  return deleted;
}

export function deleteAllSessions(): number {
  const sessions = listSessionFilenames();
  let count = 0;
  for (const filename of sessions) {
    try { fs.rmSync(path.join(sessionDir(), filename)); count++; } catch { /* no-op */ }
  }
  return count;
}

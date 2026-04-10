#!/usr/bin/env node
/**
 * OSINT Agent — Web Intelligence Platform
 * SaaS-style web arayüzü: Chat + Canlı Log + Graf + Agent Durumu
 * Kullanım: npm run web → http://localhost:3000
 */
import 'dotenv/config';
import { emitProgress, progressEmitter } from './lib/progressEmitter.js';

// Tüm console çıktılarını progressEmitter'a yönlendir (TUI'daki gibi)
process.env.LOG_LEVEL = 'ERROR';
console.log = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.info = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.warn = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.error = (...args: unknown[]) => emitProgress(args.map(String).join(' '));

import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSupervisor } from './agents/supervisorAgent.js';
import { exportGraphForVisualization, closeNeo4j } from './lib/neo4j.js';
import type { Message } from './agents/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, 'web');

const PORT = Number(process.env.WEB_PORT) || 3000;
const TOKEN = process.env.WEB_TOKEN || '';

// ── Session ───────────────────────────────────────────
let history: Message[] = [];
let isProcessing = false;

// ── SSE Clients ───────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();

function broadcast(data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Progress → SSE
progressEmitter.on('progress', (msg: string) => {
  broadcast({ type: 'progress', msg, ts: new Date().toTimeString().slice(0, 8) });
});

progressEmitter.on('detail', ({ toolName, output }: { toolName: string; output: string }) => {
  broadcast({ type: 'detail', toolName, output: output.slice(0, 50000) });
});

// ── Rate Limiter (basit) ──────────────────────────────
const rateMap = new Map<string, number[]>();
function rateLimit(ip: string, maxPerMin = 30): boolean {
  const now = Date.now();
  const hits = (rateMap.get(ip) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= maxPerMin) return false;
  hits.push(now);
  rateMap.set(ip, hits);
  return true;
}

// ── Auth ──────────────────────────────────────────────
function authorize(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const url = new URL(req.url || '/', `http://localhost`);
  const qToken = url.searchParams.get('token');
  const hToken = req.headers.authorization?.replace('Bearer ', '');
  return qToken === TOKEN || hToken === TOKEN;
}

// ── Body Parser ───────────────────────────────────────
function readBody(req: http.IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── MIME Types ────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ── Static File Server ────────────────────────────────
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const safePath = (req.url === '/' ? '/index.html' : req.url?.split('?')[0]) ?? '/index.html';
  const cleanPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_DIR, cleanPath);

  // Path traversal koruması
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ── HTTP Server ───────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://localhost`);
  const pathname = url.pathname;
  const ip = req.socket.remoteAddress ?? 'unknown';

  // Auth check (API routes only)
  if (pathname.startsWith('/api/') && !authorize(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Rate limit
  if (pathname.startsWith('/api/') && !rateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  // ── SSE Events ─────────────────────────────────
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Mevcut durumu gönder
    res.write(`data: ${JSON.stringify({ type: 'init', processing: isProcessing, messageCount: history.filter(m => m.role !== 'system').length })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── Chat ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/chat') {
    if (isProcessing) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Araştırma devam ediyor, lütfen bekleyin.' }));
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 10_000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Geçersiz mesaj' }));
        return;
      }

      // Yanıtı hemen döndür, işlem arka planda devam etsin
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      isProcessing = true;
      broadcast({ type: 'user_message', content: message });
      broadcast({ type: 'status', processing: true });

      history.push({ role: 'user', content: message });
      const prevLen = history.length;

      try {
        await runSupervisor(history);

        // Supervisor'ın eklediği yeni mesajları bul
        const newMessages = history.slice(prevLen);
        const assistantMsg = newMessages
          .filter(m => m.role === 'assistant' && typeof m.content === 'string')
          .pop();

        broadcast({
          type: 'response',
          content: (assistantMsg?.content as string) ?? '',
        });
      } catch (e) {
        broadcast({ type: 'error', message: (e as Error).message });
      }

      isProcessing = false;
      broadcast({ type: 'status', processing: false });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Geçersiz istek' }));
    }
    return;
  }

  // ── Graph Data ─────────────────────────────────
  if (pathname === '/api/graph') {
    try {
      const data = await exportGraphForVisualization();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nodes: [], links: [] }));
    }
    return;
  }

  // ── History ────────────────────────────────────
  if (pathname === '/api/history') {
    const visible = history
      .filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string'))
      .map(m => ({ role: m.role, content: m.content }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(visible));
    return;
  }

  // ── Reset ──────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/reset') {
    history = [];
    broadcast({ type: 'reset' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Static Files ───────────────────────────────
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  const authUrl = TOKEN ? `${url}?token=${TOKEN}` : url;

  // stderr'e yaz — progressEmitter henüz aktif olmayabilir
  process.stderr.write(`\n🕵️  OSINT Agent Web UI: ${authUrl}\n`);
  process.stderr.write(`📊 API: ${url}/api/events (SSE)\n`);
  process.stderr.write(`🕸️  Graf: ${url}/api/graph\n\n`);
});

process.on('SIGINT', async () => {
  process.stderr.write('\nKapatılıyor...\n');
  await closeNeo4j();
  server.close();
  process.exit(0);
});

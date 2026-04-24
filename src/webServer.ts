#!/usr/bin/env node
/**
 * OSINT Agent — Web Intelligence Platform
 * SaaS-style web interface: Chat + Live Log + Graph + Agent Status
 * Usage: npm run web → http://localhost:3000
 */
import 'dotenv/config';
import { emitProgress, progressEmitter } from './lib/progressEmitter.js';
import { formatLLMTelemetryLine, type LLMTelemetryEvent } from './lib/llmTelemetry.js';

// Route all console output to progressEmitter (same as TUI)
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
import { buildSessionGraph, type SessionGraph, type SessionGraphReplayEvent } from './lib/sessionGraph.js';
import type { Message } from './agents/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, 'web');

const PORT = Number(process.env.WEB_PORT) || 3000;
const TOKEN = process.env.WEB_TOKEN || '';

function createWebSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Session ───────────────────────────────────────────
let history: Message[] = [];
let isProcessing = false;
let webSessionId = createWebSessionId();

type ReplayableEvent = SessionGraphReplayEvent;

const eventBuffer: ReplayableEvent[] = [];
const sessionGraphDetailEvents = new Map<string, Extract<ReplayableEvent, { type: 'detail' }>>();
const sessionGraphAgentCounts = new Map<string, number>();
const EVENT_BUFFER_LIMIT = 500;
const DETAIL_REPLAY_MAX_CHARS = 50000;
const DETAIL_BROADCAST_MAX_CHARS = 50000;
const INIT_REPLAY_MAX_BYTES = 300_000;
let sessionGraphSourceRevision = 0;
let sessionGraphCacheRevision = -1;
let sessionGraphCache: SessionGraph | null = null;
let sessionGraphCacheHistorySignature = '';

function bufferEvent(event: ReplayableEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > EVENT_BUFFER_LIMIT) eventBuffer.shift();
}

function recordSessionGraphAgent(agentId: string): void {
  sessionGraphAgentCounts.set(agentId, (sessionGraphAgentCounts.get(agentId) ?? 0) + 1)
  sessionGraphSourceRevision += 1;
  sessionGraphCache = null;
}

function recordSessionGraphDetail(event: Extract<ReplayableEvent, { type: 'detail' }>): void {
  const detailKey = event.toolCallId || `${event.toolName}:${event.output.slice(0, 160)}`;
  sessionGraphDetailEvents.set(detailKey, event);
  sessionGraphSourceRevision += 1;
  sessionGraphCache = null;
}

function markSessionGraphSourceDirty(): void {
  sessionGraphSourceRevision += 1;
  sessionGraphCache = null;
}

function isSessionGraphRelevantProgress(msg: string): boolean {
  const lowered = msg.toLowerCase();
  return [
    'supervisor',
    'identityagent',
    'identity agent',
    'mediaagent',
    'media agent',
    'academicagent',
    'academic agent',
    'strategyagent',
    'strategy agent',
    '[strategy-',
    'routing',
    'koordinat',
    '🕵',
    '📚',
  ].some(pattern => lowered.includes(pattern));
}

function extractSessionGraphAgentIds(msg: string): string[] {
  const lowered = msg.toLowerCase();
  const matches: string[] = [];

  if (lowered.includes('supervisor') || lowered.includes('koordinat') || lowered.includes('routing')) {
    matches.push('Supervisor');
  }
  if (lowered.includes('identityagent') || lowered.includes('identity agent') || lowered.includes('🕵')) {
    matches.push('IdentityAgent');
  }
  if (lowered.includes('mediaagent') || lowered.includes('media agent')) {
    matches.push('MediaAgent');
  }
  if (lowered.includes('academicagent') || lowered.includes('academic agent') || lowered.includes('📚')) {
    matches.push('AcademicAgent');
  }
  if (lowered.includes('strategyagent') || lowered.includes('strategy agent') || lowered.includes('[strategy-')) {
    matches.push('StrategyAgent');
  }

  return matches;
}

function isRenderableSessionGraphTool(toolName: string): boolean {
  return new Set([
    'run_github_osint',
    'run_sherlock',
    'run_maigret',
    'parse_gpg_key',
    'check_email_registrations',
    'search_web',
    'search_web_multi',
    'search_academic_papers',
    'search_researcher_papers',
    'web_fetch',
    'scrape_profile',
    'verify_claim',
  ]).has(toolName);
}

function buildReplayEventsForInit(): ReplayableEvent[] {
  const replay: ReplayableEvent[] = [];
  let totalBytes = 0;

  for (let index = eventBuffer.length - 1; index >= 0; index--) {
    const event = eventBuffer[index]!;
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf-8');
    if (replay.length > 0 && totalBytes + bytes > INIT_REPLAY_MAX_BYTES) break;
    replay.unshift(event);
    totalBytes += bytes;
  }

  return replay;
}

function getSessionGraphHistorySignature(messages: Message[]): string {
  const lastMessage = messages.at(-1);
  const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0;
  const lastToolCalls = Array.isArray((lastMessage as any)?.tool_calls) ? (lastMessage as any).tool_calls.length : 0;
  const lastToolCallId = typeof (lastMessage as any)?.tool_call_id === 'string' ? (lastMessage as any).tool_call_id : '';
  return [messages.length, lastMessage?.role || '', lastContent, lastToolCalls, lastToolCallId].join(':');
}

function buildCurrentSessionGraph() {
  const historySignature = getSessionGraphHistorySignature(history);

  if (
    sessionGraphCache
    && sessionGraphCacheRevision === sessionGraphSourceRevision
    && sessionGraphCacheHistorySignature === historySignature
  ) {
    return sessionGraphCache;
  }

  const replayEvents: ReplayableEvent[] = [
    ...Array.from(sessionGraphAgentCounts.entries()).flatMap(([msg, count]) => Array.from({ length: count }, () => ({
      type: 'progress' as const,
      msg,
      ts: '00:00:00',
    }))),
    ...sessionGraphDetailEvents.values(),
  ];

  const graph = buildSessionGraph({
    sessionId: webSessionId,
    history,
    replayEvents,
  });

  sessionGraphCache = graph;
  sessionGraphCacheRevision = sessionGraphSourceRevision;
  sessionGraphCacheHistorySignature = historySignature;

  return graph;
}

type TelemetrySummary = {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  pricedCalls: number;
  lastModel: string | null;
  lastLatencyMs: number | null;
  lastContextPct: number | null;
  lastInputTokens: number | null;
  lastInputEstimated: boolean;
  lastContextLimit: number | null;
};

function createEmptyTelemetrySummary(): TelemetrySummary {
  return {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    pricedCalls: 0,
    lastModel: null,
    lastLatencyMs: null,
    lastContextPct: null,
    lastInputTokens: null,
    lastInputEstimated: false,
    lastContextLimit: null,
  };
}

let telemetrySummary: TelemetrySummary = createEmptyTelemetrySummary();

function applyTelemetry(event: LLMTelemetryEvent): void {
  telemetrySummary = {
    calls: telemetrySummary.calls + 1,
    errors: telemetrySummary.errors + (event.status === 'error' ? 1 : 0),
    promptTokens: telemetrySummary.promptTokens + (event.promptTokens ?? 0),
    completionTokens: telemetrySummary.completionTokens + (event.completionTokens ?? 0),
    totalTokens: telemetrySummary.totalTokens + (event.totalTokens ?? 0),
    costUsd: telemetrySummary.costUsd + (event.totalCostUsd ?? 0),
    pricedCalls: telemetrySummary.pricedCalls + (event.totalCostUsd != null ? 1 : 0),
    lastModel: event.actualModel || event.requestedModel,
    lastLatencyMs: event.latencyMs,
    lastContextPct: event.contextPct ?? null,
    lastInputTokens: event.promptTokens ?? event.approxPromptTokens,
    lastInputEstimated: event.promptTokens === undefined,
    lastContextLimit: event.contextLimit ?? null,
  };
}

// ── SSE Clients ───────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();

function broadcast(data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function notifySessionGraphDirty(): void {
  broadcast({ type: 'session_graph_dirty' });
}

progressEmitter.on('session-graph-dirty', () => {
  markSessionGraphSourceDirty();
  notifySessionGraphDirty();
});

// Progress → SSE
progressEmitter.on('progress', (msg: string) => {
  const event = { type: 'progress' as const, msg, ts: new Date().toTimeString().slice(0, 8) };
  bufferEvent(event);
  let sessionGraphChanged = false;
  if (isSessionGraphRelevantProgress(msg)) {
    for (const agentId of extractSessionGraphAgentIds(msg)) {
      recordSessionGraphAgent(agentId);
      sessionGraphChanged = true;
    }
  }
  if (sessionGraphChanged) notifySessionGraphDirty();
  broadcast(event);
});

progressEmitter.on('detail', ({ toolName, output, toolCallId }: { toolName: string; output: string; toolCallId?: string }) => {
  const event = {
    type: 'detail' as const,
    toolName,
    toolCallId,
    output: output.slice(0, DETAIL_REPLAY_MAX_CHARS),
  };
  bufferEvent(event);
  if (isRenderableSessionGraphTool(toolName)) {
    recordSessionGraphDetail({
      type: 'detail',
      toolName,
      toolCallId,
      output,
    });
    notifySessionGraphDirty();
  }
  broadcast({
    type: 'detail',
    toolName,
    toolCallId,
    output: output.slice(0, DETAIL_BROADCAST_MAX_CHARS),
  });
});

progressEmitter.on('strategy-detail', (output: string) => {
  const event = {
    type: 'detail' as const,
    toolName: 'strategy_detail',
    output: output.slice(0, DETAIL_REPLAY_MAX_CHARS),
  };
  bufferEvent(event);
  broadcast({
    type: 'detail',
    toolName: 'strategy_detail',
    output: output.slice(0, DETAIL_BROADCAST_MAX_CHARS),
  });
});

progressEmitter.on('telemetry', (event: LLMTelemetryEvent) => {
  applyTelemetry(event);
  const telemetryLine = formatLLMTelemetryLine(event);
  const replayEvent = {
    type: 'telemetry' as const,
    msg: telemetryLine,
    ts: new Date().toTimeString().slice(0, 8),
  };
  bufferEvent(replayEvent);
  let sessionGraphChanged = false;
  for (const agentId of extractSessionGraphAgentIds(event.agent)) {
    recordSessionGraphAgent(agentId);
    sessionGraphChanged = true;
  }
  if (sessionGraphChanged) notifySessionGraphDirty();
  broadcast({
    type: 'telemetry',
    msg: telemetryLine,
    ts: replayEvent.ts,
    telemetry: event,
    summary: telemetrySummary,
  });
});

// ── Rate Limiter (basit) ──────────────────────────────
const rateMap = new Map<string, number[]>();
function rateLimit(key: string, maxPerMin = 30): boolean {
  const now = Date.now();
  const hits = (rateMap.get(key) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= maxPerMin) return false;
  hits.push(now);
  rateMap.set(key, hits);
  return true;
}

function getRateLimitBucket(pathname: string): { bucket: string; maxPerMin: number } {
  if (pathname === '/api/events') {
    return { bucket: 'events', maxPerMin: 120 };
  }

  if (pathname === '/api/session-graph') {
    return { bucket: 'session-graph', maxPerMin: 600 };
  }

  if (pathname === '/api/graph') {
    return { bucket: 'database-graph', maxPerMin: 120 };
  }

  return { bucket: 'default', maxPerMin: 30 };
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

  // Path traversal protection
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

  if (pathname.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  // Rate limit
  if (pathname.startsWith('/api/')) {
    const { bucket, maxPerMin } = getRateLimitBucket(pathname);
    if (!rateLimit(`${ip}:${bucket}`, maxPerMin)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }
  }

  // ── SSE Events ─────────────────────────────────
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    // Send current state
    res.write(`data: ${JSON.stringify({ type: 'init', sessionId: webSessionId, processing: isProcessing, messageCount: history.filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0 && !(m as any).tool_calls?.length)).length, telemetry: telemetrySummary, replayEvents: buildReplayEventsForInit() })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── Chat ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/chat') {
    if (isProcessing) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Research in progress, please wait.' }));
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 10_000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid message' }));
        return;
      }

      // Return response immediately, processing continues in background
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      isProcessing = true;
      broadcast({ type: 'user_message', content: message });
      broadcast({ type: 'status', processing: true });

      history.push({ role: 'user', content: message });
      markSessionGraphSourceDirty();
      const prevLen = history.length;

      try {
        const supervisorResult = await runSupervisor(history);
        history = supervisorResult?.history ?? history;
        markSessionGraphSourceDirty();

        // Find new messages added by the Supervisor
        const newMessages = history.slice(prevLen);
        const assistantMsg = newMessages
          .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0 && !(m as any).tool_calls?.length)
          .pop();

        broadcast({
          type: 'response',
          content: supervisorResult?.finalResponse ?? (assistantMsg?.content as string) ?? '',
        });
      } catch (e) {
        broadcast({ type: 'error', message: (e as Error).message });
      }

      isProcessing = false;
      broadcast({ type: 'status', processing: false });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
    return;
  }

  // ── Session Graph Data ─────────────────────────
  if (pathname === '/api/session-graph') {
    try {
      const data = buildCurrentSessionGraph();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session graph unavailable' }));
    }
    return;
  }

  // ── Graph Data ─────────────────────────────────
  if (pathname === '/api/graph') {
    try {
      const data = await exportGraphForVisualization();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database graph unavailable' }));
    }
    return;
  }

  // ── History ────────────────────────────────────
  if (pathname === '/api/history') {
    const visible = history
      .filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0 && !(m as any).tool_calls?.length))
      .map(m => ({ role: m.role, content: m.content }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(visible));
    return;
  }

  // ── Reset ──────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/reset') {
    if (isProcessing) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Research in progress, please wait.' }));
      return;
    }
    history = [];
    webSessionId = createWebSessionId();
    telemetrySummary = createEmptyTelemetrySummary();
    eventBuffer.length = 0;
    sessionGraphDetailEvents.clear();
    sessionGraphAgentCounts.clear();
    sessionGraphCache = null;
    sessionGraphCacheRevision = -1;
    sessionGraphSourceRevision = 0;
    sessionGraphCacheHistorySignature = '';
    broadcast({ type: 'reset', sessionId: webSessionId });
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

  // Write to stderr — progressEmitter may not be active yet
  process.stderr.write(`\n🕵️  OSINT Agent Web UI: ${authUrl}\n`);
  process.stderr.write(`📊 API: ${url}/api/events (SSE)\n`);
  process.stderr.write(`🧭 Session map: ${url}/api/session-graph\n`);
  process.stderr.write(`🕸️  Graf: ${url}/api/graph\n\n`);
});

process.on('SIGINT', async () => {
  process.stderr.write('\nShutting down...\n');
  await closeNeo4j();
  server.close();
  process.exit(0);
});

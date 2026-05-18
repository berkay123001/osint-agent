#!/usr/bin/env node
/**
 * OSINT Agent — REST API Server
 * Comprehensive programmatic API for external integrations.
 * Usage: npm run api → http://localhost:3002
 *
 * All endpoints are prefixed with /api/v1/
 */
import 'dotenv/config';
import { emitProgress, progressEmitter } from './lib/progressEmitter.js';
import { formatLLMTelemetryLine, type LLMTelemetryEvent } from './lib/llmTelemetry.js';

process.env.LOG_LEVEL = 'ERROR';
console.log = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.info = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.warn = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.error = (...args: unknown[]) => emitProgress(args.map(String).join(' '));

import http from 'http';
import {
  exportGraphForVisualization,
  closeNeo4j,
  getGraphStats,
  getGraphNodeCountsByLabel,
  listGraphNodes,
  getConnections,
} from './lib/neo4j.js';
import {
  buildSessionGraph,
  type SessionGraph,
  type SessionGraphReplayEvent,
} from './lib/sessionGraph.js';
import { tools as allTools } from './lib/toolRegistry.js';
import type { Message } from './agents/types.js';

type RunSupervisorFn = typeof import('./agents/supervisorAgent.js').runSupervisor;
type ExecuteToolFn = typeof import('./lib/toolRegistry.js').executeTool;

let _runSupervisor: RunSupervisorFn | null = null;
let _executeTool: ExecuteToolFn | null = null;

async function getRunSupervisor(): Promise<RunSupervisorFn> {
  if (!_runSupervisor) {
    const mod = await import('./agents/supervisorAgent.js');
    _runSupervisor = mod.runSupervisor;
  }
  return _runSupervisor;
}

async function getExecuteTool(): Promise<ExecuteToolFn> {
  if (!_executeTool) {
    const mod = await import('./lib/toolRegistry.js');
    _executeTool = mod.executeTool;
  }
  return _executeTool;
}

const PORT = Number(process.env.API_PORT) || 3002;
const TOKEN = process.env.WEB_TOKEN || '';
const API_PREFIX = '/api/v1';

type JsonResponse = Record<string, unknown>;

function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let history: Message[] = [];
let isProcessing = false;
let sessionId = createSessionId();
let investigationCount = 0;
let lastResponse: string | null = null;
let lastError: string | null = null;
let startedAt = new Date().toISOString();

type ReplayableEvent = SessionGraphReplayEvent;
const eventBuffer: ReplayableEvent[] = [];
const sessionGraphDetailEvents = new Map<string, Extract<ReplayableEvent, { type: 'detail' }>>();
const sessionGraphAgentCounts = new Map<string, number>();
const EVENT_BUFFER_LIMIT = 500;
const DETAIL_REPLAY_MAX_CHARS = 50000;
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
  sessionGraphAgentCounts.set(agentId, (sessionGraphAgentCounts.get(agentId) ?? 0) + 1);
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
    'supervisor', 'identityagent', 'identity agent',
    'mediaagent', 'media agent', 'academicagent', 'academic agent',
    'strategyagent', 'strategy agent', '[strategy-', 'routing',
    'koordinat', '🕵', '📚',
  ].some(pattern => lowered.includes(pattern));
}

function extractSessionGraphAgentIds(msg: string): string[] {
  const lowered = msg.toLowerCase();
  const matches: string[] = [];
  if (lowered.includes('supervisor') || lowered.includes('koordinat') || lowered.includes('routing'))
    matches.push('Supervisor');
  if (lowered.includes('identityagent') || lowered.includes('identity agent') || lowered.includes('🕵'))
    matches.push('IdentityAgent');
  if (lowered.includes('mediaagent') || lowered.includes('media agent'))
    matches.push('MediaAgent');
  if (lowered.includes('academicagent') || lowered.includes('academic agent') || lowered.includes('📚'))
    matches.push('AcademicAgent');
  if (lowered.includes('strategyagent') || lowered.includes('strategy agent') || lowered.includes('[strategy-'))
    matches.push('StrategyAgent');
  return matches;
}

function isRenderableSessionGraphTool(toolName: string): boolean {
  return new Set([
    'run_github_osint', 'run_sherlock', 'run_maigret', 'parse_gpg_key',
    'check_email_registrations', 'search_web', 'search_web_multi',
    'search_academic_papers', 'search_researcher_papers',
    'web_fetch', 'scrape_profile', 'verify_claim',
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

function buildCurrentSessionGraph(): SessionGraph {
  const historySignature = getSessionGraphHistorySignature(history);
  if (sessionGraphCache && sessionGraphCacheRevision === sessionGraphSourceRevision && sessionGraphCacheHistorySignature === historySignature) {
    return sessionGraphCache;
  }
  const replayEvents: ReplayableEvent[] = [
    ...Array.from(sessionGraphAgentCounts.entries()).flatMap(([msg, count]) =>
      Array.from({ length: count }, () => ({ type: 'progress' as const, msg, ts: '00:00:00' }))
    ),
    ...sessionGraphDetailEvents.values(),
  ];
  const graph = buildSessionGraph({ sessionId, history, replayEvents });
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
    calls: 0, errors: 0, promptTokens: 0, completionTokens: 0,
    totalTokens: 0, costUsd: 0, pricedCalls: 0,
    lastModel: null, lastLatencyMs: null, lastContextPct: null,
    lastInputTokens: null, lastInputEstimated: false, lastContextLimit: null,
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
    type: 'detail' as const, toolName, toolCallId,
    output: output.slice(0, DETAIL_REPLAY_MAX_CHARS),
  };
  bufferEvent(event);
  if (isRenderableSessionGraphTool(toolName)) {
    recordSessionGraphDetail({ type: 'detail', toolName, toolCallId, output });
    notifySessionGraphDirty();
  }
  broadcast({ type: 'detail', toolName, toolCallId, output: output.slice(0, 50000) });
});

progressEmitter.on('strategy-detail', (output: string) => {
  const event = { type: 'detail' as const, toolName: 'strategy_detail', output: output.slice(0, DETAIL_REPLAY_MAX_CHARS) };
  bufferEvent(event);
  broadcast({ type: 'detail', toolName: 'strategy_detail', output: output.slice(0, 50000) });
});

progressEmitter.on('telemetry', (event: LLMTelemetryEvent) => {
  applyTelemetry(event);
  const telemetryLine = formatLLMTelemetryLine(event);
  const replayEvent = { type: 'telemetry' as const, msg: telemetryLine, ts: new Date().toTimeString().slice(0, 8) };
  bufferEvent(replayEvent);
  let sessionGraphChanged = false;
  for (const agentId of extractSessionGraphAgentIds(event.agent)) {
    recordSessionGraphAgent(agentId);
    sessionGraphChanged = true;
  }
  if (sessionGraphChanged) notifySessionGraphDirty();
  broadcast({ type: 'telemetry', msg: telemetryLine, ts: replayEvent.ts, telemetry: event, summary: telemetrySummary });
});

const rateMap = new Map<string, number[]>();
function rateLimit(key: string, maxPerMin = 60): boolean {
  const now = Date.now();
  const hits = (rateMap.get(key) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= maxPerMin) return false;
  hits.push(now);
  rateMap.set(key, hits);
  return true;
}

function authorize(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const url = new URL(req.url || '/', `http://localhost`);
  const qToken = url.searchParams.get('token');
  const hToken = req.headers.authorization?.replace('Bearer ', '');
  return qToken === TOKEN || hToken === TOKEN;
}

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

function json(res: http.ServerResponse, statusCode: number, data: JsonResponse): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const rp = pParts[i];
    if (pp.startsWith(':')) {
      params[pp.slice(1)] = decodeURIComponent(rp!);
    } else if (pp !== rp) {
      return null;
    }
  }
  return params;
}

function getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown>; required?: string[] }> {
  return allTools
    .filter((t: any) => t.type === 'function')
    .map((t: any) => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters?.properties ?? {},
      required: t.function.parameters?.required ?? [],
    }));
}

function getOpenApiSpec(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OSINT Agent REST API',
      description: [
        '# OSINT Agent — Çok Ajanlı Açık Kaynak İstihbarat Sistemi',
        '',
        '## Genel Bakış',
        'Bu API, 40+ OSINT aracını ve 5 uzman ajanı (Supervisor, Identity, Media, Academic, Strategy) kullanarak kapsamlı araştırmalar yapmanızı sağlar.',
        '',
        '## Frontend Entegrasyon Akışı',
        '1. `POST /chat` ile araştırma sorusu gönderin → araştırma asenkron başlar',
        '2. `GET /events` SSE akışına bağlanın → gerçek zamanlı ilerleme, tool sonuçları, telemetry alın',
        '3. `GET /status` ile işleme durumunu kontrol edin',
        '4. `GET /history` ile sohbet geçmişini gösterin',
        '5. `GET /graph/session` ile oturum graf haritasını görselleştirin',
        '6. Araştırma tamamlandığında SSE üzerinden `type: "status", processing: false` gelir',
        '',
        '## Kimlik Doğrulama',
        'WEB_TOKEN env değişkeni tanımlıysa, her isteğe token eklemeniz gerekir:',
        '- Header: `Authorization: Bearer <token>`',
        '- Query: `?token=<token>`',
        '',
        '## SSE Olay Tipleri',
        'Her SSE olayı `data: {...}\\n\\n` formatında gönderilir. Olay tipleri:',
        '',
        '| type | Açıklama | Payload Alanları |',
        '|------|----------|-----------------|',
        '| `init` | Bağlantı açıldığında | sessionId, processing, messageCount, telemetry, replayEvents |',
        '| `user_message` | Kullanıcı mesajı alındı | content |',
        '| `status` | İşlem durumu değişti | processing |',
        '| `progress` | Araştırma ilerleme mesajı | msg, ts |',
        '| `detail` | Tool çalıştırma sonucu | toolName, toolCallId, output |',
        '| `telemetry` | LLM çağrı metrikleri | msg, ts, telemetry, summary |',
        '| `response` | Supervisor yanıtı | content |',
        '| `error` | Hata mesajı | message |',
        '| `reset` | Oturum sıfırlandı | sessionId |',
        '| `session_graph_dirty` | Oturum grafı güncellendi | (yok — /graph/session tekrar çekilmeli) |',
        '',
        '## Rate Limiting',
        '- Genel endpoint\'ler: IP başına dakikada 60 istek',
        '- SSE stream: IP başına dakikada 120 bağlantı',
        '- Graf endpoint\'leri: IP başına dakikada 120 istek',
        '- Aşımda HTTP 429 döner',
      ].join('\n'),
      version: '1.0.0',
      contact: { name: 'OSINT Agent' },
      license: { name: 'ISC' },
    },
    servers: [
      { url: `http://localhost:${PORT}${API_PREFIX}`, description: 'Local development' },
    ],
    security: TOKEN ? [{ BearerAuth: [] }, { QueryToken: [] }] : [],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', description: 'WEB_TOKEN env değişkeni' },
        QueryToken: { type: 'apiKey', in: 'query', name: 'token', description: 'URL query parametresi olarak token' },
      },
      schemas: {
        ChatRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', maxLength: 10000, description: 'Araştırma sorusu veya komut' },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            sessionId: { type: 'string' },
          },
        },
        StatusResponse: {
          type: 'object',
          properties: {
            processing: { type: 'boolean' },
            sessionId: { type: 'string' },
            messageCount: { type: 'number' },
            investigationCount: { type: 'number' },
            lastResponse: { type: 'string', nullable: true },
            lastError: { type: 'string', nullable: true },
            uptime: { type: 'string' },
          },
        },
        HistoryResponse: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string' },
                },
              },
            },
          },
        },
        ToolInfo: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            parameters: { type: 'object', additionalProperties: { type: 'object' } },
          },
        },
        ToolExecuteRequest: {
          type: 'object',
          required: ['args'],
          properties: {
            args: { type: 'object', additionalProperties: { description: 'Tool parametreleri (her tool için farklı)' } },
          },
        },
        ToolExecuteResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            tool: { type: 'string' },
            result: { type: 'string' },
            error: { type: 'string', nullable: true },
          },
        },
        TelemetryResponse: {
          type: 'object',
          properties: {
            calls: { type: 'number' },
            errors: { type: 'number' },
            promptTokens: { type: 'number' },
            completionTokens: { type: 'number' },
            totalTokens: { type: 'number' },
            costUsd: { type: 'number' },
            pricedCalls: { type: 'number' },
            lastModel: { type: 'string', nullable: true },
            lastLatencyMs: { type: 'number', nullable: true },
            lastContextPct: { type: 'number', nullable: true },
            lastInputTokens: { type: 'number', nullable: true },
          },
        },
        GraphData: {
          type: 'object',
          properties: {
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
          },
        },
        GraphStats: {
          type: 'object',
          properties: {
            nodes: { type: 'number' },
            relationships: { type: 'number' },
          },
        },
        GraphQueryResult: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            connections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  relation: { type: 'string' },
                  toLabel: { type: 'string' },
                  confidence: { type: 'string' },
                  source: { type: 'string' },
                },
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Hata mesajı' },
            statusCode: { type: 'number', description: 'HTTP durum kodu' },
          },
        },
        SSEInitEvent: {
          type: 'object',
          description: 'SSE bağlantısı açıldığında gönderilen ilk olay',
          properties: {
            type: { type: 'string', example: 'init' },
            sessionId: { type: 'string', example: 'mpayvrwg-3uoitl' },
            processing: { type: 'boolean', example: false },
            messageCount: { type: 'number', example: 0 },
            telemetry: { $ref: '#/components/schemas/TelemetryResponse' },
            replayEvents: { type: 'array', items: { type: 'object' }, description: 'Geçmiş olaylar (replay)' },
          },
        },
        SSEProgressEvent: {
          type: 'object',
          description: 'Araştırma ilerleme mesajı',
          properties: {
            type: { type: 'string', example: 'progress' },
            msg: { type: 'string', example: '🕵️ IdentityAgent: Starting investigation...' },
            ts: { type: 'string', example: '14:32:05', description: 'Saat:DK:SN formatında zaman damgası' },
          },
        },
        SSEDetailEvent: {
          type: 'object',
          description: 'Tool çalıştırma sonucu',
          properties: {
            type: { type: 'string', example: 'detail' },
            toolName: { type: 'string', example: 'search_web' },
            toolCallId: { type: 'string', example: 'call_abc123', nullable: true },
            output: { type: 'string', description: 'Tool çıktısı (maks 50000 karakter)' },
          },
        },
        SSETelemetryEvent: {
          type: 'object',
          description: 'LLM çağrı metrikleri',
          properties: {
            type: { type: 'string', example: 'telemetry' },
            msg: { type: 'string', description: 'Formatlanmış telemetry satırı' },
            ts: { type: 'string', example: '14:32:06' },
            telemetry: { type: 'object', description: 'Ham LLM telemetry olayı' },
            summary: { $ref: '#/components/schemas/TelemetryResponse' },
          },
        },
        SSEStatusEvent: {
          type: 'object',
          description: 'İşlem durumu değişikliği',
          properties: {
            type: { type: 'string', example: 'status' },
            processing: { type: 'boolean', example: true },
          },
        },
        SSEResponseEvent: {
          type: 'object',
          description: 'Supervisor final yanıtı — araştırma tamamlandığında gönderilir',
          properties: {
            type: { type: 'string', example: 'response' },
            content: { type: 'string', description: 'Supervisor\'un formatlanmış yanıtı' },
          },
        },
        SSEErrorEvent: {
          type: 'object',
          description: 'Hata olayı',
          properties: {
            type: { type: 'string', example: 'error' },
            message: { type: 'string', description: 'Hata mesajı' },
          },
        },
        SSEUserMessageEvent: {
          type: 'object',
          description: 'Kullanıcı mesajı alındı onayı',
          properties: {
            type: { type: 'string', example: 'user_message' },
            content: { type: 'string', description: 'Kullanıcının gönderdiği mesaj' },
          },
        },
        SSEResetEvent: {
          type: 'object',
          description: 'Oturum sıfırlandı',
          properties: {
            type: { type: 'string', example: 'reset' },
            sessionId: { type: 'string', description: 'Yeni session ID' },
          },
        },
        SSESessionGraphDirtyEvent: {
          type: 'object',
          description: 'Oturum grafı güncellendi — /graph/session endpoint\'ini tekrar çağırarak güncel grafı alın',
          properties: {
            type: { type: 'string', example: 'session_graph_dirty' },
          },
        },
      },
    },
    paths: {
      '/chat': {
        post: {
          summary: 'Araştırma başlat',
          description: [
            'Bir soru veya komut gönderir, çok ajanlı OSINT araştırmasını başlatır.',
            '',
            '**Frontend kullanım akışı:**',
            '1. Bu endpoint\'e POST yapın → hemen `{ ok: true }` döner (asenkron)',
            '2. Aynı anda `GET /events` SSE akışına bağlanın → ilerleme, tool sonuçları, final yanıt alın',
            '3. `type: "status", processing: false` geldiğinde araştırma tamamlanmış demektir',
            '4. `type: "response"` olayı Supervisor\'un formatlanmış final yanıtını içerir',
            '',
            '**Örnek sorgular:**',
            '- `"Investigate username: torvalds"` → kimlik araştırması',
            '- `"Check email: test@gmail.com for breaches"` → breach kontrolü',
            '- `"Search for news about OpenAI"` → web arama',
            '- `"Analyze this image: https://..."` → görsel analizi',
          ].join('\n'),
          tags: ['Investigation'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatRequest' },
                examples: {
                  username_investigation: {
                    summary: 'Username araştırması',
                    value: { message: 'Investigate username: torvalds on all platforms' },
                  },
                  email_check: {
                    summary: 'Email breach kontrolü',
                    value: { message: 'Check email: test@gmail.com for data breaches' },
                  },
                  web_search: {
                    summary: 'Web arama',
                    value: { message: 'Search the web for recent news about OpenAI GPT-5' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Araştırma başlatıldı',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatResponse' },
                  example: { ok: true, sessionId: 'mpayvrwg-3uoitl' },
                },
              },
            },
            '400': { description: 'Geçersiz mesaj', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { error: 'Invalid message (1-10000 chars required)', statusCode: 400 } } } },
            '409': { description: 'Zaten bir araştırma devam ediyor', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { error: 'Research in progress, please wait.', statusCode: 409 } } } },
          },
        },
      },
      '/status': {
        get: {
          summary: 'Sistem durumu',
          description: 'Mevcut oturum durumu, işleme durumu ve sayaçları döndürür. Frontend polling için kullanılabilir, ancak SSE `/events` tercih edilmelidir.',
          tags: ['Investigation'],
          responses: {
            '200': {
              description: 'Durum bilgisi',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StatusResponse' },
                  example: { processing: false, sessionId: 'mpayvrwg-3uoitl', messageCount: 2, investigationCount: 1, lastResponse: '## Investigation Results\n...', lastError: null, uptime: '1h 23m' },
                },
              },
            },
          },
        },
      },
      '/history': {
        get: {
          summary: 'Sohbet geçmişi',
          description: 'Mevcut oturumdaki kullanıcı ve asistan mesajlarını listeler. Tool çağrısı mesajları filtrelenir, sadece görünür mesajlar döner.',
          tags: ['Investigation'],
          responses: {
            '200': {
              description: 'Geçmiş',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HistoryResponse' },
                  example: {
                    sessionId: 'mpayvrwg-3uoitl',
                    messages: [
                      { role: 'user', content: 'Investigate username: torvalds' },
                      { role: 'assistant', content: '## Investigation Complete\n\nI found...' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/reset': {
        post: {
          summary: 'Oturumu sıfırla',
          description: 'Mevcut oturumu temizler, yeni session ID oluşturur. Tüm geçmiş, telemetry ve graf önbelleği sıfırlanır. Araştırma devam ediyorsa sıfırlama reddedilir (HTTP 409).',
          tags: ['Investigation'],
          responses: {
            '200': { description: 'Sıfırlandı', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, sessionId: { type: 'string' } } }, example: { ok: true, sessionId: 'abc123xy-z9w8v7' } } } },
            '409': { description: 'Araştırma devam ediyor', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { error: 'Research in progress, cannot reset.', statusCode: 409 } } } },
          },
        },
      },
      '/events': {
        get: {
          summary: 'Canlı olay akışı (SSE)',
          description: [
            'Server-Sent Events akışı. `text/event-stream` content-type ile gerçek zamanlı olaylar yayınlanır.',
            '',
            '**Frontend bağlantı örneği (JavaScript):**',
            '```javascript',
            'const es = new EventSource("/api/v1/events");',
            'es.onmessage = (e) => {',
            '  const data = JSON.parse(e.data);',
            '  switch(data.type) {',
            '    case "init": console.log("Connected:", data.sessionId); break;',
            '    case "progress": updateProgress(data.msg); break;',
            '    case "detail": showToolResult(data.toolName, data.output); break;',
            '    case "response": displayFinalResponse(data.content); break;',
            '    case "status": setProcessing(data.processing); break;',
            '    case "session_graph_dirty": refreshSessionGraph(); break;',
            '  }',
            '};',
            '```',
            '',
            'Bağlantı açıldığında `init` olayı gönderilir (mevcut durum + geçmiş replay).',
            'Araştırma sırasında `progress`, `detail`, `telemetry` olayları akar.',
            'Tamamlandığında `response` + `status` olayları gönderilir.',
          ].join('\n'),
          tags: ['Streaming'],
          responses: {
            '200': {
              description: 'SSE stream — her satır `data: {JSON}\\n\\n` formatında',
              content: {
                'text/event-stream': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/SSEInitEvent' },
                      { $ref: '#/components/schemas/SSEProgressEvent' },
                      { $ref: '#/components/schemas/SSEDetailEvent' },
                      { $ref: '#/components/schemas/SSETelemetryEvent' },
                      { $ref: '#/components/schemas/SSEStatusEvent' },
                      { $ref: '#/components/schemas/SSEResponseEvent' },
                      { $ref: '#/components/schemas/SSEErrorEvent' },
                      { $ref: '#/components/schemas/SSEUserMessageEvent' },
                      { $ref: '#/components/schemas/SSEResetEvent' },
                      { $ref: '#/components/schemas/SSESessionGraphDirtyEvent' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Sağlık kontrolü',
          description: 'API sunucusu ve Neo4j bağlantı durumunu kontrol eder. Kimlik doğrulama gerektirmez. Monitoring ve load balancer\'lar için uygundur.',
          tags: ['System'],
          responses: {
            '200': {
              description: 'Sağlık durumu',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' }, uptime: { type: 'string' }, neo4j: { type: 'string' }, sessionId: { type: 'string' }, toolCount: { type: 'number' } } },
                  example: { status: 'ok', version: '1.0.0', uptime: '2h 15m', neo4j: 'connected (142 nodes, 89 rels)', sessionId: 'mpayvrwg-3uoitl', toolCount: 48 },
                },
              },
            },
          },
        },
      },
      '/telemetry': {
        get: {
          summary: 'LLM telemetri verileri',
          description: 'LLM çağrı sayısı, token kullanımı, maliyet ve performans metriklerini döndürür. Frontend dashboard\'larında maliyet takibi için kullanılabilir.',
          tags: ['System'],
          responses: {
            '200': {
              description: 'Telemetri',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TelemetryResponse' },
                  example: { calls: 15, errors: 0, promptTokens: 45000, completionTokens: 12000, totalTokens: 57000, costUsd: 0.085, pricedCalls: 15, lastModel: 'qwen/qwen3.6-plus', lastLatencyMs: 3200, lastContextPct: 45.2, lastInputTokens: 3500 },
                },
              },
            },
          },
        },
      },
      '/tools': {
        get: {
          summary: 'Kullanılabilir araçları listele',
          description: 'Tüm OSINT araçlarının adını, açıklamasını ve tam JSON Schema parametre tanımlarını listeler. Frontend\'de dinamik tool form oluşturmak için kullanılabilir.',
          tags: ['Tools'],
          responses: {
            '200': {
              description: 'Araç listesi',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { count: { type: 'number' }, tools: { type: 'array', items: { $ref: '#/components/schemas/ToolInfo' } } } },
                  example: {
                    count: 48,
                    tools: [
                      { name: 'search_web', description: 'Search the web using...', parameters: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/tools/{name}': {
        post: {
          summary: 'Araç çalıştır',
          description: [
            'Belirli bir OSINT aracını doğrudan çağırır. Araç adını path\'te, parametreleri body\'de gönderin.',
            '',
            '**Kullanılabilir araçlar:** `search_web`, `search_web_multi`, `run_sherlock`, `run_maigret`, `run_github_osint`, `check_email_registrations`, `check_breaches`, `web_fetch`, `reverse_image_search`, `compare_images_phash`, `extract_metadata`, `search_academic_papers`, `search_researcher_papers`, `wayback_search`, `verify_claim`, `scrape_profile`, `cross_reference`, `verify_profiles`, `nitter_profile`, `parse_gpg_key`, `auto_visual_intel`, `check_plagiarism`, `search_person`, `save_finding`, `batch_save_findings`, `save_ioc`, `link_entities`, `query_graph`, `graph_stats`, `list_graph_nodes`, `query_graph_confidence`, `unexplored_pivots`, `fact_check_to_graph`, `mark_false_positive`, `remove_false_positive`, `clear_graph`, `add_custom_node`, `add_custom_relationship`, `delete_custom_node`, `obsidian_write`, `obsidian_append`, `obsidian_read`, `obsidian_daily`, `obsidian_write_profile`, `obsidian_list`, `obsidian_search`, `generate_report`, `analyze_gpx`.',
            '',
            'Tam parametre şemaları için `GET /tools` endpoint\'ini çağırın.',
          ].join('\n'),
          tags: ['Tools'],
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' }, description: 'Araç adı', example: 'search_web' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ToolExecuteRequest' },
                examples: {
                  search_web: { summary: 'Web arama', value: { args: { query: 'OpenAI GPT-5 release date' } } },
                  run_sherlock: { summary: 'Sherlock username araştırması', value: { args: { username: 'torvalds' } } },
                  check_email: { summary: 'Email breach kontrolü', value: { args: { email: 'test@gmail.com' } } },
                  web_fetch: { summary: 'URL içeriğini çek', value: { args: { url: 'https://example.com' } } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Araç sonucu', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolExecuteResponse' } } } },
            '400': { description: 'Geçersiz istek', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'Araç bulunamadı', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/graph': {
        get: {
          summary: 'Tam graf verisi',
          description: 'Neo4j veritabanındaki tüm node ve ilişkileri görselleştirme formatında döndürür.',
          tags: ['Graph'],
          responses: {
            '200': { description: 'Graf verisi', content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphData' } } } },
            '503': { description: 'Neo4j bağlantı hatası', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/graph/session': {
        get: {
          summary: 'Oturum graf haritası',
          description: 'Mevcut oturumun ajan-tool-entity ilişki haritasını döndürür.',
          tags: ['Graph'],
          responses: { '200': { description: 'Oturum grafı', content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphData' } } } } },
        },
      },
      '/graph/query/{value}': {
        get: {
          summary: 'Varlık bağlantılarını sorgula',
          description: 'Belirli bir username, email veya entity için Neo4j grafındaki tüm bağlantıları döndürür.',
          tags: ['Graph'],
          parameters: [{ name: 'value', in: 'path', required: true, schema: { type: 'string' }, description: 'Sorgulanacak değer (username, email, entity)' }],
          responses: {
            '200': { description: 'Bağlantı listesi', content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphQueryResult' } } } },
            '503': { description: 'Neo4j bağlantı hatası', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/graph/stats': {
        get: {
          summary: 'Graf istatistikleri',
          description: 'Toplam node ve ilişki sayısını döndürür.',
          tags: ['Graph'],
          responses: { '200': { description: 'İstatistikler', content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphStats' } } } } },
        },
      },
      '/graph/nodes': {
        get: {
          summary: 'Node listesi',
          description: 'Graftaki node\'ları listeler, opsiyonel label filtresi uygular.',
          tags: ['Graph'],
          parameters: [
            { name: 'label', in: 'query', schema: { type: 'string' }, description: 'Node label filtresi (Username, Email, Person, Platform, Profile)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 }, description: 'Maksimum node sayısı' },
          ],
          responses: { '200': { description: 'Node listesi', content: { 'application/json': { schema: { type: 'object', properties: { counts: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, count: { type: 'number' } } } }, nodes: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } } } } } } } },
        },
      },
      '/docs': {
        get: {
          summary: 'OpenAPI spesifikasyonu',
          description: 'Tam OpenAPI 3.1 JSON spesifikasyonunu döndürür.',
          tags: ['System'],
          responses: { '200': { description: 'OpenAPI JSON' } },
        },
      },
    },
    tags: [
      { name: 'Investigation', description: 'Araştırma başlatma, durum ve geçmiş' },
      { name: 'Tools', description: '40+ OSINT aracını doğrudan çalıştırma' },
      { name: 'Graph', description: 'Neo4j graf veritabanı sorguları' },
      { name: 'Streaming', description: 'Gerçek zamanlı olay akışı' },
      { name: 'System', description: 'Sağlık, telemetri ve dokümantasyon' },
    ],
  };
}

const routes: Array<{
  method: string;
  pattern: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, query: URLSearchParams) => Promise<void>;
}> = [];

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/health`,
  handler: async (_req, res, _params, _query) => {
    let neo4jStatus = 'disconnected';
    try {
      const stats = await getGraphStats();
      neo4jStatus = `connected (${stats.nodes} nodes, ${stats.relationships} rels)`;
    } catch {
      neo4jStatus = 'unavailable';
    }
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    json(res, 200, {
      status: 'ok',
      version: '1.0.0',
      uptime: `${hours}h ${minutes}m`,
      neo4j: neo4jStatus,
      sessionId,
      toolCount: allTools.filter((t: any) => t.type === 'function').length,
    });
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/docs`,
  handler: async (_req, res, _params, _query) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getOpenApiSpec(), null, 2));
  },
});

routes.push({
  method: 'POST', pattern: `${API_PREFIX}/chat`,
  handler: async (_req, res, _params, _query) => {
    if (isProcessing) {
      json(res, 409, { error: 'Research in progress, please wait.', statusCode: 409 });
      return;
    }
    let body: any;
    try {
      body = JSON.parse(await readBody(_req));
    } catch {
      json(res, 400, { error: 'Invalid JSON body', statusCode: 400 });
      return;
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 10_000) {
      json(res, 400, { error: 'Invalid message (1-10000 chars required)', statusCode: 400 });
      return;
    }

    json(res, 200, { ok: true, sessionId });

    isProcessing = true;
    lastError = null;
    investigationCount++;
    broadcast({ type: 'user_message', content: message });
    broadcast({ type: 'status', processing: true });

    history.push({ role: 'user', content: message });
    markSessionGraphSourceDirty();
    const prevLen = history.length;

    try {
      const runSupervisor = await getRunSupervisor();
      const supervisorResult = await runSupervisor(history);
      history = supervisorResult?.history ?? history;
      markSessionGraphSourceDirty();

      const newMessages = history.slice(prevLen);
      const assistantMsg = newMessages
        .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0 && !(m as any).tool_calls?.length)
        .pop();

      lastResponse = supervisorResult?.finalResponse ?? (assistantMsg?.content as string) ?? '';
      broadcast({ type: 'response', content: lastResponse });
    } catch (e) {
      lastError = (e as Error).message;
      broadcast({ type: 'error', message: lastError });
    }

    isProcessing = false;
    broadcast({ type: 'status', processing: false });
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/status`,
  handler: async (_req, res, _params, _query) => {
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    json(res, 200, {
      processing: isProcessing,
      sessionId,
      messageCount: history.filter(m => m.role === 'user').length,
      investigationCount,
      lastResponse,
      lastError,
      uptime: `${hours}h ${minutes}m`,
    });
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/history`,
  handler: async (_req, res, _params, _query) => {
    const visible = history
      .filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0 && !(m as any).tool_calls?.length))
      .map(m => ({ role: m.role, content: m.content }));
    json(res, 200, { sessionId, messages: visible });
  },
});

routes.push({
  method: 'POST', pattern: `${API_PREFIX}/reset`,
  handler: async (_req, res, _params, _query) => {
    if (isProcessing) {
      json(res, 409, { error: 'Research in progress, cannot reset.', statusCode: 409 });
      return;
    }
    history = [];
    sessionId = createSessionId();
    lastResponse = null;
    lastError = null;
    telemetrySummary = createEmptyTelemetrySummary();
    eventBuffer.length = 0;
    sessionGraphDetailEvents.clear();
    sessionGraphAgentCounts.clear();
    sessionGraphCache = null;
    sessionGraphCacheRevision = -1;
    sessionGraphSourceRevision = 0;
    sessionGraphCacheHistorySignature = '';
    broadcast({ type: 'reset', sessionId });
    json(res, 200, { ok: true, sessionId });
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/events`,
  handler: async (req, res, _params, _query) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({
      type: 'init',
      sessionId,
      processing: isProcessing,
      messageCount: history.filter(m => m.role === 'user').length,
      telemetry: telemetrySummary,
      replayEvents: buildReplayEventsForInit(),
    })}\n\n`);
    req.on('close', () => sseClients.delete(res));
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/telemetry`,
  handler: async (_req, res, _params, _query) => {
    json(res, 200, telemetrySummary);
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/tools`,
  handler: async (_req, res, _params, _query) => {
    json(res, 200, {
      count: getToolDefinitions().length,
      tools: getToolDefinitions(),
    });
  },
});

routes.push({
  method: 'POST', pattern: `${API_PREFIX}/tools/:name`,
  handler: async (_req, res, params, _query) => {
    const toolName = params.name;
    if (!toolName) {
      json(res, 400, { error: 'Tool name is required', statusCode: 400 });
      return;
    }
    const toolDef = allTools.find((t: any) => t.type === 'function' && t.function.name === toolName);
    if (!toolDef) {
      json(res, 404, { error: `Tool not found: ${toolName}`, statusCode: 404, availableTools: allTools.filter((t: any) => t.type === 'function').map((t: any) => t.function.name) });
      return;
    }
    let body: any;
    try {
      body = JSON.parse(await readBody(_req));
    } catch {
      json(res, 400, { error: 'Invalid JSON body. Expected: { "args": { ... } }', statusCode: 400 });
      return;
    }
    const args = body.args ?? body.parameters ?? body;
    if (typeof args !== 'object' || args === null) {
      json(res, 400, { error: 'args must be an object', statusCode: 400 });
      return;
    }
    try {
      const executeTool = await getExecuteTool();
      const result = await executeTool(toolName, args);
      json(res, 200, { ok: true, tool: toolName, result, error: null });
    } catch (e) {
      json(res, 200, { ok: false, tool: toolName, result: null, error: (e as Error).message });
    }
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/graph`,
  handler: async (_req, res, _params, _query) => {
    try {
      const data = await exportGraphForVisualization();
      json(res, 200, data as unknown as JsonResponse);
    } catch {
      json(res, 503, { error: 'Database graph unavailable (Neo4j connection failed)', statusCode: 503 });
    }
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/graph/session`,
  handler: async (_req, res, _params, _query) => {
    try {
      const data = buildCurrentSessionGraph();
      json(res, 200, data as unknown as JsonResponse);
    } catch {
      json(res, 500, { error: 'Session graph unavailable', statusCode: 500 });
    }
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/graph/query/:value`,
  handler: async (_req, res, params, _query) => {
    const value = params.value;
    if (!value) {
      json(res, 400, { error: 'Query value is required', statusCode: 400 });
      return;
    }
    try {
      const connections = await getConnections(value);
      json(res, 200, {
        value,
        connectionCount: connections.length,
        connections: connections.map(c => ({
          from: c.from,
          to: c.to,
          relation: c.relation,
          toLabel: c.toLabel,
          confidence: c.confidence || null,
          source: c.source || null,
        })),
      });
    } catch {
      json(res, 503, { error: 'Neo4j connection failed', statusCode: 503 });
    }
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/graph/stats`,
  handler: async (_req, res, _params, _query) => {
    try {
      const stats = await getGraphStats();
      json(res, 200, { nodes: stats.nodes, relationships: stats.relationships });
    } catch {
      json(res, 503, { error: 'Neo4j connection failed', statusCode: 503 });
    }
  },
});

routes.push({
  method: 'GET', pattern: `${API_PREFIX}/graph/nodes`,
  handler: async (_req, res, _params, query) => {
    const label = query.get('label') || undefined;
    const limitStr = query.get('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 50;
    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      json(res, 400, { error: 'limit must be between 1 and 500', statusCode: 400 });
      return;
    }
    try {
      const counts = await getGraphNodeCountsByLabel();
      const nodes = await listGraphNodes(limit, label);
      json(res, 200, {
        counts: counts.map(c => ({ label: c.label, count: c.count })),
        nodes: nodes.map(n => ({ label: n.label, value: n.value })),
      });
    } catch {
      json(res, 503, { error: 'Neo4j connection failed', statusCode: 503 });
    }
  },
});

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost`);
  const pathname = url.pathname;
  const ip = req.socket.remoteAddress ?? 'unknown';

  if (pathname.startsWith(API_PREFIX) && !authorize(req)) {
    json(res, 401, { error: 'Unauthorized. Provide token via ?token= or Authorization: Bearer <token>', statusCode: 401 });
    return;
  }

  if (pathname.startsWith(API_PREFIX)) {
    res.setHeader('Cache-Control', 'no-store');
    const { bucket, maxPerMin } = pathname === `${API_PREFIX}/events`
      ? { bucket: 'events', maxPerMin: 120 }
      : pathname === `${API_PREFIX}/graph`
        ? { bucket: 'database-graph', maxPerMin: 120 }
        : { bucket: 'default', maxPerMin: 60 };
    if (!rateLimit(`${ip}:${bucket}`, maxPerMin)) {
      json(res, 429, { error: 'Too many requests', statusCode: 429 });
      return;
    }
  }

  for (const route of routes) {
    if (req.method !== route.method) continue;
    const params = matchRoute(pathname, route.pattern);
    if (params !== null) {
      try {
        await route.handler(req, res, params, url.searchParams);
      } catch (e) {
        process.stderr.write(`API Error: ${(e as Error).message}\n`);
        json(res, 500, { error: 'Internal server error', statusCode: 500 });
      }
      return;
    }
  }

  if (pathname === '/' || pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem;background:#0d1117;color:#c9d1d9">
<h2>🕵️ OSINT Agent — REST API</h2>
<p>Programmatic API for external integrations.</p>
<h3>Quick Start</h3>
<pre style="background:#161b22;padding:1rem;border-radius:8px;overflow-x:auto">
curl http://localhost:${PORT}${API_PREFIX}/health
curl http://localhost:${PORT}${API_PREFIX}/tools
curl -X POST http://localhost:${PORT}${API_PREFIX}/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message": " Investigate username: torvalds"}'
curl -X POST http://localhost:${PORT}${API_PREFIX}/tools/search_web \\
  -H "Content-Type: application/json" \\
  -d '{"args": {"query": "openai gpt-4"}}'
</pre>
<h3>Endpoints</h3>
<table style="border-collapse:collapse">
<tr><th style="text-align:left;padding:4px 12px">Method</th><th style="text-align:left;padding:4px 12px">Endpoint</th><th style="text-align:left;padding:4px 12px">Description</th></tr>
<tr><td style="padding:4px 12px;color:#3fb950">POST</td><td style="padding:4px 12px">${API_PREFIX}/chat</td><td style="padding:4px 12px">Start investigation</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/status</td><td style="padding:4px 12px">Processing status</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/history</td><td style="padding:4px 12px">Chat history</td></tr>
<tr><td style="padding:4px 12px;color:#f0883e">POST</td><td style="padding:4px 12px">${API_PREFIX}/reset</td><td style="padding:4px 12px">Reset session</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/events</td><td style="padding:4px 12px">SSE live stream</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/tools</td><td style="padding:4px 12px">List tools</td></tr>
<tr><td style="padding:4px 12px;color:#3fb950">POST</td><td style="padding:4px 12px">${API_PREFIX}/tools/:name</td><td style="padding:4px 12px">Execute tool</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/graph</td><td style="padding:4px 12px">Full graph data</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/graph/session</td><td style="padding:4px 12px">Session graph</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/graph/query/:value</td><td style="padding:4px 12px">Query entity</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/graph/stats</td><td style="padding:4px 12px">Graph stats</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/graph/nodes</td><td style="padding:4px 12px">List nodes</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/telemetry</td><td style="padding:4px 12px">LLM telemetry</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/health</td><td style="padding:4px 12px">Health check</td></tr>
<tr><td style="padding:4px 12px;color:#58a6ff">GET</td><td style="padding:4px 12px">${API_PREFIX}/docs</td><td style="padding:4px 12px">OpenAPI spec</td></tr>
</table>
</body></html>`);
    return;
  }

  json(res, 404, { error: 'Not found', statusCode: 404, hint: `Try ${API_PREFIX}/docs for API documentation` });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  const authUrl = TOKEN ? `${url}?token=${TOKEN}` : url;

  process.stderr.write(`\n`);
  process.stderr.write(`🕵️  OSINT Agent REST API: ${authUrl}\n`);
  process.stderr.write(`📄  API Docs:        ${url}${API_PREFIX}/docs\n`);
  process.stderr.write(`📡  SSE Stream:      ${url}${API_PREFIX}/events\n`);
  process.stderr.write(`🧭  Health Check:    ${url}${API_PREFIX}/health\n`);
  process.stderr.write(`🔧  Tools:           ${url}${API_PREFIX}/tools\n`);
  process.stderr.write(`\n`);
});

process.on('SIGINT', async () => {
  process.stderr.write('\nShutting down REST API server...\n');
  await closeNeo4j();
  server.close();
  process.exit(0);
});

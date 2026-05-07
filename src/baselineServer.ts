#!/usr/bin/env node
/**
 * OSINT Baseline Agent Server  (port 3001)
 * ---
 * Single-agent ReAct loop — no supervisor, no sub-agents, no strategy orchestrator.
 * Graph-write / Obsidian / strategy tools are excluded so the agent cannot persist
 * state across sessions, making it a fair zero-memory baseline.
 *
 * Tool budget and fallback chains are identical to the multi-agent system
 * so comparisons are apples-to-apples.
 *
 * Usage:
 *   npm run baseline          → starts on :3001
 *   cd react-ui && npm run dev → UI on :5173, proxied to :3001
 */
import 'dotenv/config';
import { emitProgress, progressEmitter } from './lib/progressEmitter.js';
import { formatLLMTelemetryLine, type LLMTelemetryEvent } from './lib/llmTelemetry.js';

process.env.LOG_LEVEL = 'ERROR';
console.log   = (...a: unknown[]) => emitProgress(a.map(String).join(' '));
console.info  = (...a: unknown[]) => emitProgress(a.map(String).join(' '));
console.warn  = (...a: unknown[]) => emitProgress(a.map(String).join(' '));
console.error = (...a: unknown[]) => emitProgress(a.map(String).join(' '));

import http from 'http';
import { closeNeo4j } from './lib/neo4j.js';
import { runAgentLoop } from './agents/baseAgent.js';
import { tools as allTools, executeTool } from './lib/toolRegistry.js';
import type { Message, AgentConfig } from './agents/types.js';

const PORT = Number(process.env.BASELINE_PORT) || 3001;
const TOKEN = process.env.WEB_TOKEN || '';

// ── Tool filtering ─────────────────────────────────────────
// Exclude graph-write, strategy, obsidian tools — baseline agent
// must not persist state or use orchestration scaffolding.
const EXCLUDED_TOOLS = new Set([
  // Graph writes
  'save_finding', 'batch_save_findings', 'save_ioc', 'link_entities',
  'add_custom_node', 'add_custom_relationship', 'delete_custom_node',
  'fact_check_to_graph', 'clear_graph', 'mark_false_positive',
  'remove_false_positive',
  // Graph reads (depends on prior saved state — not fair baseline)
  'query_graph', 'graph_stats', 'list_graph_nodes', 'query_graph_confidence',
  'unexplored_pivots', 'cross_reference',
  // Obsidian
  'obsidian_write', 'obsidian_append', 'obsidian_read',
  'obsidian_daily', 'obsidian_write_profile', 'obsidian_list', 'obsidian_search',
  // GPS/misc
  'analyze_gpx',
]);

const baselineTools = allTools.filter(
  (t: any) => t.type === 'function' && !EXCLUDED_TOOLS.has(t.function.name),
);

// ── System prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = `# REACT BASELINE OSINT AGENT

You are a standalone OSINT research agent. You have access to various tools for open-source intelligence gathering. Your task is to investigate the given query using ONLY tool outputs — never fabricate information.

# CORE RULES

1. **TOOL OUTPUTS ONLY**: Every claim must come from a tool result. Your training data is NOT a source.
2. **NO FABRICATION**: If a tool returns empty results, write "No data found". Never guess or fill gaps.
3. **SOURCE TAGS**: Add [source: tool_name] to every claim.
4. **EVIDENCE LEVELS**:
   - ✅ VERIFIED = 2+ independent sources confirm
   - ⚠️  SINGLE SOURCE = only 1 tool supports this
   - ❓ UNVERIFIED = no data returned
5. **MULTIPLE IDENTITY RULE**: Name similarity alone is NOT evidence. Linking profiles requires concrete proof (same email, same avatar, cross-link, matching bio).

# RESEARCH APPROACH — ReAct loop

1. **Observe** the query and plan your next tool call
2. **Act** by calling the most relevant tool
3. **Reflect** on the result — did it answer the question? What's missing?
4. Repeat until you have sufficient findings or run out of tool budget
5. **DEPTH**: Do NOT stop after 1-2 tool calls. A thorough investigation requires at least 10-15 tool calls. If you found basic profile info, deepen it — check emails, run username sweeps, verify profiles, cross-reference. Surface-level results are NOT acceptable.

## Query-type guidance

**Person / username / email / GitHub:**
- Broad discovery first: search_person or search_web
- GitHub profiles: run_github_osint → extract emails → check_email_registrations → check_breaches
- Username presence: run_sherlock, then run_maigret for deeper coverage
- Profile pages: scrape_profile, web_fetch for bio/links
- Cross-validate: verify_profiles, cross_reference

**Image / media / fact-check:**
- Collect URLs first with search_web
- Image origin: reverse_image_search → compare_images_phash if variants found
- Metadata: extract_metadata for EXIF/location data
- Visual analysis: auto_visual_intel
- Claim verification: verify_claim against source URLs
- Archive: wayback_search for deleted/changed content

**Academic / research:**
- Paper search: search_academic_papers with multiple query variants
- Author profile: search_researcher_papers
- Originality: check_plagiarism if suspicious similarity found

**General web investigation:**
- Multi-angle search: search_web_multi (up to 3 parallel queries)
- Deep-read: scrape_profile or web_fetch for full page content
- Archive: wayback_search for historical snapshots

# REPORT FORMAT

## Summary
Brief overview of target and key findings.

## Verified Findings
High-confidence findings with [source: tool_name] tags and ✅ labels.

## Unverified or Partial Findings
Low-confidence or single-source findings with ⚠️ labels.

## Open Questions
What remains unknown or needs further investigation.

## Tool Statistics
List of all tools called and their results.`;

// ── Session ────────────────────────────────────────────────
let history: Message[] = [];
let isProcessing = false;

function makeSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
let sessionId = makeSessionId();

// ── Telemetry ──────────────────────────────────────────────
type TelemetrySummary = {
  calls: number; errors: number;
  promptTokens: number; completionTokens: number; totalTokens: number;
  costUsd: number; pricedCalls: number;
  lastModel: string | null; lastLatencyMs: number | null;
  lastContextPct: number | null; lastInputTokens: number | null;
  lastInputEstimated: boolean; lastContextLimit: number | null;
};

const zeroTelemetry = (): TelemetrySummary => ({
  calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
  costUsd: 0, pricedCalls: 0, lastModel: null, lastLatencyMs: null,
  lastContextPct: null, lastInputTokens: null, lastInputEstimated: false,
  lastContextLimit: null,
});

let telemetry = zeroTelemetry();

function applyTelemetry(e: LLMTelemetryEvent) {
  telemetry = {
    calls: telemetry.calls + 1,
    errors: telemetry.errors + (e.status === 'error' ? 1 : 0),
    promptTokens: telemetry.promptTokens + (e.promptTokens ?? 0),
    completionTokens: telemetry.completionTokens + (e.completionTokens ?? 0),
    totalTokens: telemetry.totalTokens + (e.totalTokens ?? 0),
    costUsd: telemetry.costUsd + (e.totalCostUsd ?? 0),
    pricedCalls: telemetry.pricedCalls + (e.totalCostUsd != null ? 1 : 0),
    lastModel: e.actualModel || e.requestedModel,
    lastLatencyMs: e.latencyMs,
    lastContextPct: e.contextPct ?? null,
    lastInputTokens: e.promptTokens ?? e.approxPromptTokens,
    lastInputEstimated: e.promptTokens === undefined,
    lastContextLimit: e.contextLimit ?? null,
  };
}

// ── SSE ────────────────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();

function broadcast(data: object) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(payload);
}

progressEmitter.on('progress', (msg: string) => {
  broadcast({ type: 'progress', msg, ts: new Date().toTimeString().slice(0, 8) });
});

progressEmitter.on('detail', ({ toolName, output, toolCallId }: { toolName: string; output: string; toolCallId?: string }) => {
  broadcast({ type: 'detail', toolName, toolCallId, output: output.slice(0, 50_000) });
});

progressEmitter.on('telemetry', (e: LLMTelemetryEvent) => {
  applyTelemetry(e);
  broadcast({
    type: 'telemetry',
    msg: formatLLMTelemetryLine(e),
    ts: new Date().toTimeString().slice(0, 8),
    telemetry: e,
    summary: telemetry,
  });
});

// ── Helpers ────────────────────────────────────────────────
const rateMap = new Map<string, number[]>();
function rateLimit(key: string, max = 30): boolean {
  const now = Date.now();
  const hits = (rateMap.get(key) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= max) return false;
  hits.push(now);
  rateMap.set(key, hits);
  return true;
}

function authorize(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const u = new URL(req.url || '/', 'http://localhost');
  return u.searchParams.get('token') === TOKEN
    || req.headers.authorization?.replace('Bearer ', '') === TOKEN;
}

function readBody(req: http.IncomingMessage, max = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { req.destroy(); reject(new Error('Body too large')); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── Baseline agent config ──────────────────────────────────
function makeConfig(): AgentConfig {
  return {
    name: 'BaselineAgent',
    systemPrompt: SYSTEM_PROMPT,
    tools: baselineTools,
    executeTool,
    model: process.env.BASELINE_MODEL || 'qwen/qwen3.6-plus',
    maxToolCalls: 40,
  };
}

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url  = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  const ip   = req.socket.remoteAddress ?? 'unknown';

  if (path.startsWith('/api/')) {
    if (!authorize(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (!rateLimit(`${ip}:${path}`, path === '/api/events' ? 120 : 30)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Too many requests' })); return; }
  }

  // ── GET /api/events  (SSE) ──────────────────────────────
  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'Connection': 'keep-alive' });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'init', sessionId, processing: isProcessing, messageCount: history.filter(m => m.role === 'user').length, telemetry, replayEvents: [] })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── POST /api/chat ──────────────────────────────────────
  if (req.method === 'POST' && path === '/api/chat') {
    if (isProcessing) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Research in progress, please wait.' })); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 10_000) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid message' })); return; }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      isProcessing = true;
      broadcast({ type: 'status', processing: true });
      history.push({ role: 'user', content: message });

      try {
        const result = await runAgentLoop(history, makeConfig());
        if (result.history) history = result.history;
        broadcast({ type: 'response', content: result.finalResponse ?? '' });
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

  // ── GET /api/history ────────────────────────────────────
  if (path === '/api/history') {
    const visible = history
      .filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0 && !(m as any).tool_calls?.length))
      .map(m => ({ role: m.role, content: m.content }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(visible));
    return;
  }

  // ── POST /api/reset ─────────────────────────────────────
  if (req.method === 'POST' && path === '/api/reset') {
    if (isProcessing) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Research in progress' })); return; }
    history = []; telemetry = zeroTelemetry(); sessionId = makeSessionId();
    broadcast({ type: 'reset', sessionId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Root: helpful message ───────────────────────────────
  if (path === '/' || path === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem;background:#04060b;color:#e8ecf4">
<h2>🧪 OSINT Baseline Agent — API Server</h2>
<p>This is the backend API (port ${PORT}). Open the React UI at:</p>
<p><a href="http://localhost:5173" style="color:#00d4ff">http://localhost:5173</a></p>
<p style="margin-top:1rem;color:#4a5f80">Tools available: ${baselineTools.length} (graph/obsidian tools excluded)</p>
</body></html>`);
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
  const model = process.env.BASELINE_MODEL || 'deepseek/deepseek-v4-pro';
  process.stderr.write(`\n🧪 OSINT Baseline Agent API: http://localhost:${PORT}\n`);
  process.stderr.write(`   Tools: ${baselineTools.length}/${allTools.length} (graph/obsidian excluded)\n`);
  process.stderr.write(`   Model: ${model}\n`);
  process.stderr.write(`   UI:    cd react-ui && npm run dev  →  http://localhost:5173\n\n`);
});

process.on('SIGINT', async () => {
  process.stderr.write('\nShutting down...\n');
  await closeNeo4j();
  server.close();
  process.exit(0);
});

/**
 * OSINT Agent — Live Log Server
 * Streams progressEmitter events to the browser via SSE.
 * Usage: npm run chat → starts automatically → http://localhost:3334
 */

import http from 'http';
import { progressEmitter } from './lib/progressEmitter.js';
import type { LLMTelemetryEvent } from './lib/llmTelemetry.js';
import { formatLLMTelemetryLine } from './lib/llmTelemetry.js';

const PORT = Number(process.env.LOG_PORT) || 3334;
const BUFFER_SIZE = 2000;

interface LogEntry {
  id?: string;
  ts: string;
  msg: string;
  agentCtx?: string;  // which agent produced this (identity/media/academic/strategy/supervisor)
  detail?: string;    // full tool output (optional)
  hasDetail?: boolean;
  kind?: 'telemetry';
  telemetry?: LLMTelemetryEvent;
  replay?: boolean;
}

const logBuffer: LogEntry[] = [];
const clients = new Set<http.ServerResponse>();
function createServerSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let serverSessionId = createServerSessionId();
let nextEntryId = 1;

type TelemetrySummary = {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  estimatedCostCalls: number;
  lastModel: string;
  lastLatencyMs: number | null;
  lastContextPercent: number | null;
  lastInputTokens: number | null;
  lastInputEstimated: boolean;
  lastContextWindow: number | null;
};

function createEmptyTelemetrySummary(): TelemetrySummary {
  return {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    estimatedCostCalls: 0,
    lastModel: '-',
    lastLatencyMs: null,
    lastContextPercent: null,
    lastInputTokens: null,
    lastInputEstimated: false,
    lastContextWindow: null,
  };
}

let telemetrySummarySnapshot: TelemetrySummary = createEmptyTelemetrySummary();

function applyTelemetrySummary(telemetry: LLMTelemetryEvent): void {
  telemetrySummarySnapshot = {
    calls: telemetrySummarySnapshot.calls + 1,
    errors: telemetrySummarySnapshot.errors + (telemetry.status === 'error' ? 1 : 0),
    promptTokens: telemetrySummarySnapshot.promptTokens + (telemetry.promptTokens ?? 0),
    completionTokens: telemetrySummarySnapshot.completionTokens + (telemetry.completionTokens ?? 0),
    costUsd: telemetrySummarySnapshot.costUsd + (telemetry.totalCostUsd ?? 0),
    estimatedCostCalls: telemetrySummarySnapshot.estimatedCostCalls + (telemetry.totalCostUsd != null ? 1 : 0),
    lastModel: telemetry.actualModel || telemetry.requestedModel || '-',
    lastLatencyMs: telemetry.latencyMs,
    lastContextPercent: telemetry.contextPct ?? null,
    lastInputTokens: telemetry.promptTokens ?? telemetry.approxPromptTokens,
    lastInputEstimated: telemetry.promptTokens === undefined,
    lastContextWindow: telemetry.contextLimit ?? null,
  };
}

// Agent context tracker — which agent are we in?
let currentAgentCtx: string | null = null;

// pending detail: to attach to the last sent ✓ line
let pendingDetailKey: string | null = null;

function broadcastInitEvent(target?: http.ServerResponse): void {
  const payload = `data: ${JSON.stringify({ type: 'init', sessionId: serverSessionId, telemetrySummary: telemetrySummarySnapshot })}\n\n`;
  if (target) {
    target.write(payload);
    return;
  }
  for (const client of clients) {
    client.write(payload);
  }
}

function resetLogSession(): void {
  serverSessionId = createServerSessionId();
  nextEntryId = 1;
  logBuffer.length = 0;
  telemetrySummarySnapshot = createEmptyTelemetrySummary();
  currentAgentCtx = null;
  pendingDetailKey = null;
  broadcastInitEvent();
}

function agentCtxFromTelemetry(agent: string): string | undefined {
  const lowered = agent.toLowerCase();
  if (lowered.includes('identity')) return 'identity';
  if (lowered.includes('media')) return 'media';
  if (lowered.includes('academic')) return 'academic';
  if (lowered.includes('strategy')) return 'strategy';
  if (lowered.includes('supervisor')) return 'supervisor';
  return undefined;
}

function detectAgentCtx(msg: string): void {
  // Open context when an agent starts
  if (msg.includes('IdentityAgent →') || msg.includes('🕵')) currentAgentCtx = 'identity';
  else if (msg.includes('MediaAgent →') || (msg.includes('📸') && msg.includes('→'))) currentAgentCtx = 'media';
  else if (msg.includes('AcademicAgent →') || (msg.includes('📚') && msg.includes('→'))) currentAgentCtx = 'academic';
  else if (msg.includes('🧠') && (msg.includes('Strategy') || msg.includes('[Strategy'))) currentAgentCtx = 'strategy';
  else if (msg.includes('Supervisor') && msg.includes('→')) currentAgentCtx = 'supervisor';
  // Close context when an agent finishes
  if (msg.includes('tamamlandı') || msg.includes('[DONE]') || msg.includes('sentezlendi') ||
      msg.includes('completed') || msg.includes('synthesized')) {
    currentAgentCtx = null;
  }
}

function broadcast(entry: LogEntry): void {
  if (entry.id == null) entry.id = `${serverSessionId}:${nextEntryId++}`;
  if (logBuffer.length >= BUFFER_SIZE) logBuffer.shift();
  logBuffer.push(entry);
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

progressEmitter.on('progress', (msg: string) => {
  const ts = new Date().toTimeString().slice(0, 8);
  detectAgentCtx(msg);
  const entry: LogEntry = { ts, msg };
  if (currentAgentCtx) entry.agentCtx = currentAgentCtx;
  // ✓ line → the next detail event will be attached to this line
  if (msg.trimStart().startsWith('✓ ')) {
    pendingDetailKey = ts + msg.slice(0, 60);
    entry.hasDetail = false; // detail not yet received
  } else {
    pendingDetailKey = null;
  }
  broadcast(entry);
});

progressEmitter.on('detail', ({ toolName, output }: { toolName: string; output: string }) => {
  if (!pendingDetailKey) return;
  // Son log entry'sine detail ekle
  const last = logBuffer[logBuffer.length - 1];
  if (last && last.msg.includes(toolName)) {
    last.detail = output;
    last.hasDetail = true;
    // Already sent — send a patch event
    const data = `data: ${JSON.stringify({ type: 'patch', id: last.id, detail: output })}\n\n`;
    for (const client of clients) {
      client.write(data);
    }
  }
  pendingDetailKey = null;
});

progressEmitter.on('telemetry', (telemetry: LLMTelemetryEvent) => {
  applyTelemetrySummary(telemetry);
  const entry: LogEntry = {
    ts: new Date().toTimeString().slice(0, 8),
    msg: formatLLMTelemetryLine(telemetry),
    agentCtx: agentCtxFromTelemetry(telemetry.agent),
    kind: 'telemetry',
    telemetry,
  };
  broadcast(entry);
});

progressEmitter.on('session-reset', () => {
  resetLogSession();
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OSINT Agent — Live Logs</title>
<style>
  :root {
    --bg: #0d1117;
    --bg2: #161b22;
    --bg3: #21262d;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --tool: #58a6ff;
    --success: #3fb950;
    --error: #f85149;
    --strategy: #d2a8ff;
    --warn: #d29922;
    --identity: #79c0ff;
    --media: #f0883e;
    --academic: #56d364;
    --retry: #a5d6ff;
    --supervisor: #ffa657;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }

  .logo { color: var(--tool); font-weight: bold; font-size: 14px; }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
    animation: pulse 2s infinite;
  }
  .status-dot.disconnected { background: var(--error); box-shadow: 0 0 6px var(--error); animation: none; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

  .header-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .counter {
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 2px 10px;
    font-size: 11px;
    color: var(--muted);
  }

  .btn {
    background: var(--bg3);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    transition: background 0.15s;
  }
  .btn:hover { background: var(--border); }
  .btn.active { background: var(--tool); color: #fff; border-color: var(--tool); }

  .toolbar {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 6px 16px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .filter-label { color: var(--muted); font-size: 11px; margin-right: 4px; }

  .search-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .metrics-bar {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    display: grid;
    grid-template-columns: repeat(6, minmax(120px, 1fr));
    gap: 8px;
    flex-shrink: 0;
  }

  .metric-card {
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    min-height: 58px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
  }

  .metric-label {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .metric-value {
    color: var(--text);
    font-size: 18px;
    font-weight: 700;
  }

  .metric-subvalue {
    color: var(--muted);
    font-size: 11px;
  }

  input[type="text"] {
    background: var(--bg3);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-family: inherit;
    width: 200px;
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--tool); }
  input[type="text"]::placeholder { color: var(--muted); }

  #log-area {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    scroll-behavior: smooth;
  }

  .log-line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 2px 16px;
    line-height: 1.6;
    border-left: 2px solid transparent;
    transition: background 0.1s;
  }
  .log-line:hover { background: var(--bg2); }

  .ts { color: var(--muted); font-size: 11px; flex-shrink: 0; }
  .msg { flex: 1; white-space: pre-wrap; word-break: break-all; }

  /* Kategori renkleri */
  .line-tool     { border-left-color: var(--tool); }
  .line-tool .msg { color: var(--tool); }

  .line-success  { border-left-color: var(--success); }
  .line-success .msg { color: var(--success); }

  .line-error    { border-left-color: var(--error); }
  .line-error .msg { color: var(--error); }

  .line-strategy { border-left-color: var(--strategy); }
  .line-strategy .msg { color: var(--strategy); }

  .line-warn     { border-left-color: var(--warn); }
  .line-warn .msg { color: var(--warn); }

  .line-identity { border-left-color: var(--identity); }
  .line-identity .msg { color: var(--identity); }

  .line-media    { border-left-color: var(--media); }
  .line-media .msg { color: var(--media); }

  .line-academic { border-left-color: var(--academic); }
  .line-academic .msg { color: var(--academic); }

  .line-supervisor { border-left-color: var(--supervisor); }
  .line-supervisor .msg { color: var(--supervisor); }

  .line-retry    { border-left-color: var(--retry); }
  .line-retry .msg { color: var(--retry); }

  .line-default .msg { color: var(--text); }

  .expand-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--tool);
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    cursor: pointer;
    margin-left: 6px;
    font-family: inherit;
    flex-shrink: 0;
    transition: background 0.1s;
  }
  .expand-btn:hover { background: var(--bg3); }

  .badge {
    display: inline-block;
    background: rgba(255,255,255,0.12);
    color: inherit;
    font-size: 9px;
    padding: 0 5px;
    border-radius: 10px;
    margin-left: 4px;
    min-width: 16px;
    text-align: center;
    vertical-align: middle;
  }

  /* Tool lines inherit the context agent's color but slightly muted */
  .line-identity .msg { color: var(--identity); }
  .line-media    .msg { color: var(--media); }
  .line-academic .msg { color: var(--academic); }

  /* Context tool lines are indented */
  .log-line.indented { padding-left: 32px; }
  .log-line.indented .ts { opacity: 0.6; }

  .tool-detail {
    display: none;
    margin: 4px 0 4px 48px;
    padding: 8px 12px;
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 400px;
    overflow-y: auto;
    line-height: 1.5;
  }
  .tool-detail.open { display: block; }

  .highlight { background: rgba(255,195,0,0.25); border-radius: 2px; }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--muted);
  }
  .empty-state .icon { font-size: 40px; }

  footer {
    background: var(--bg2);
    border-top: 1px solid var(--border);
    padding: 5px 16px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted);
  }

  .legend { display: flex; gap: 12px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }

  @media (max-width: 1100px) {
    .metrics-bar { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
  }

  @media (max-width: 700px) {
    .metrics-bar { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    .search-wrap { width: 100%; margin-left: 0; }
    input[type="text"] { width: 100%; }
  }
</style>
</head>
<body>

<header>
  <div class="logo">🕵️ OSINT Agent</div>
  <div class="status-dot" id="status-dot"></div>
  <span id="status-text" style="color: var(--muted); font-size: 11px;">Connecting...</span>
  <div class="header-right">
    <div class="counter" id="line-count">0 lines</div>
    <button class="btn" id="btn-scroll" onclick="toggleScroll()">⬇ Auto-Scroll: ON</button>
    <button class="btn" onclick="clearLogs()">🗑 Clear</button>
  </div>
</header>

<div class="toolbar">
  <span class="filter-label">FILTER:</span>
  <button class="btn active" onclick="setFilter('all', this)">All</button>
  <button class="btn" onclick="setFilter('tool', this)">🔧 Tools<span class="badge" id="badge-tool"></span></button>
  <button class="btn" onclick="setFilter('strategy', this)">🧠 Strategy<span class="badge" id="badge-strategy"></span></button>
  <button class="btn" onclick="setFilter('identity', this)">🕵️ Identity<span class="badge" id="badge-identity"></span></button>
  <button class="btn" onclick="setFilter('media', this)">📸 Media<span class="badge" id="badge-media"></span></button>
  <button class="btn" onclick="setFilter('academic', this)">📚 Academic<span class="badge" id="badge-academic"></span></button>
  <button class="btn" onclick="setFilter('error', this)">❌ Errors<span class="badge" id="badge-error"></span></button>
  <button class="btn" onclick="setFilter('success', this)">✅ Success<span class="badge" id="badge-success"></span></button>
  <div class="search-wrap">
    <input type="text" id="search" placeholder="Search logs..." oninput="applySearch(this.value)">
  </div>
</div>

<div class="metrics-bar">
  <div class="metric-card">
    <div class="metric-label">LLM Calls</div>
    <div class="metric-value" id="metric-calls">0</div>
    <div class="metric-subvalue" id="metric-errors">0 errors</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Prompt Tokens</div>
    <div class="metric-value" id="metric-prompt">0</div>
    <div class="metric-subvalue">cumulative</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Completion Tokens</div>
    <div class="metric-value" id="metric-completion">0</div>
    <div class="metric-subvalue">cumulative</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Estimated Cost</div>
    <div class="metric-value" id="metric-cost">$0.00000</div>
    <div class="metric-subvalue" id="metric-cost-note">known models only</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Last Model</div>
    <div class="metric-value" id="metric-model" style="font-size:13px;">-</div>
    <div class="metric-subvalue" id="metric-latency">-</div>
  </div>
  <div class="metric-card">
    <div class="metric-label">Context Usage</div>
    <div class="metric-value" id="metric-context">n/a</div>
    <div class="metric-subvalue" id="metric-context-note">last call</div>
  </div>
</div>

<div id="log-area">
  <div class="empty-state" id="empty-state">
    <div class="icon">📡</div>
    <div>Waiting for agent to start...</div>
    <div style="font-size: 11px;">Logs will appear here when <code>npm run chat</code> is running</div>
  </div>
</div>

<footer>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--tool)"></div> Tool</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--strategy)"></div> Strategy</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--identity)"></div> Identity</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--success)"></div> Success</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--error)"></div> Error</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--warn)"></div> Warning</div>
  </div>
  <span style="margin-left:auto">
    Port: ${PORT} · 
    <a href="http://localhost:3333" target="_blank" style="color:var(--tool);text-decoration:none">Graf Sunucusu →</a>
  </span>
</footer>

<script>
  let autoScroll = true;
  let currentFilter = 'all';
  let searchQuery = '';
  let allLines = [];
  const seenEntryIds = new Set();
  let replayAllowedGeneration = 0; // generation at last connect/init — replay accepted only if no clear happened since
  let currentServerSessionId = null;
  let localClearGeneration = 0;

  const logArea = document.getElementById('log-area');
  const emptyState = document.getElementById('empty-state');
  const lineCount = document.getElementById('line-count');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const btnScroll = document.getElementById('btn-scroll');
  const metricCalls = document.getElementById('metric-calls');
  const metricErrors = document.getElementById('metric-errors');
  const metricPrompt = document.getElementById('metric-prompt');
  const metricCompletion = document.getElementById('metric-completion');
  const metricCost = document.getElementById('metric-cost');
  const metricCostNote = document.getElementById('metric-cost-note');
  const metricModel = document.getElementById('metric-model');
  const metricLatency = document.getElementById('metric-latency');
  const metricContext = document.getElementById('metric-context');
  const metricContextNote = document.getElementById('metric-context-note');

  const telemetrySummary = {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    estimatedCostCalls: 0,
    lastModel: '-',
    lastLatencyMs: null,
    lastContextPercent: null,
    lastInputTokens: null,
    lastInputEstimated: false,
    lastContextWindow: null,
  };

  function categorize(msg, agentCtx) {
    // First check message content
    if (msg.includes('❌') || msg.includes('Error:') || (msg.includes('hata') && !msg.includes('kapat'))) return 'error';
    if (msg.includes('🧠') || msg.includes('[Strategy') || msg.includes('Strategy Agent')) return 'strategy';
    if (msg.includes('⚠️')) return 'warn';
    if (msg.includes('🕵') || msg.includes('IdentityAgent')) return 'identity';
    if (msg.includes('MediaAgent')) return 'media';
    if (msg.includes('AcademicAgent')) return 'academic';
    if (msg.includes('Supervisor →') || msg.includes('Koordinatör') || msg.includes('Coordinator')) return 'supervisor';
    if (msg.includes('✅') || msg.includes('tamamlandı') || msg.includes('completed')) return 'success';
    if (msg.includes('🔄') || msg.includes('tekrar çalışıyor') || msg.includes('retrying')) return 'retry';
    // Tool lines → show in the agent's category if agentCtx is set
    if (msg.trimStart().startsWith('🔧') || msg.trimStart().startsWith('✓ ')) {
      if (agentCtx) return agentCtx;
      return 'tool';
    }
    if (agentCtx) return agentCtx;
    return 'default';
  }

  function matchesFilter(cat, agentCtx) {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'tool') return cat === 'tool' || (agentCtx == null && (cat === 'tool'));
    if (currentFilter === 'success') return cat === 'success';
    if (currentFilter === 'error') return cat === 'error';
    // Agent filters: own lines + tool calls made within that agent
    return cat === currentFilter || agentCtx === currentFilter;
  }

  function matchesSearch(msg) {
    if (!searchQuery) return true;
    return msg.toLowerCase().includes(searchQuery.toLowerCase());
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function formatInteger(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value || 0);
  }

  function formatCost(value) {
    return '$' + Number(value || 0).toFixed(5);
  }

  function formatContextPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
    return value.toFixed(value >= 10 ? 1 : 2) + '%';
  }

  function updateTelemetrySummary() {
    metricCalls.textContent = formatInteger(telemetrySummary.calls);
    metricErrors.textContent = formatInteger(telemetrySummary.errors) + ' errors';
    metricPrompt.textContent = formatInteger(telemetrySummary.promptTokens);
    metricCompletion.textContent = formatInteger(telemetrySummary.completionTokens);
    metricCost.textContent = formatCost(telemetrySummary.costUsd);
    metricCostNote.textContent = telemetrySummary.estimatedCostCalls > 0
      ? formatInteger(telemetrySummary.estimatedCostCalls) + ' calls priced'
      : 'known models only';
    metricModel.textContent = telemetrySummary.lastModel || '-';
    metricLatency.textContent = telemetrySummary.lastLatencyMs == null
      ? '-'
      : formatInteger(telemetrySummary.lastLatencyMs) + ' ms';
    metricContext.textContent = formatContextPercent(telemetrySummary.lastContextPercent);
    metricContextNote.textContent = telemetrySummary.lastInputTokens == null || telemetrySummary.lastContextWindow == null
      ? 'last call'
      : formatInteger(telemetrySummary.lastInputTokens) + (telemetrySummary.lastInputEstimated ? ' est' : '') + ' / ' + formatInteger(telemetrySummary.lastContextWindow) + ' tokens';
  }

  function applyTelemetrySummarySnapshot(snapshot) {
    telemetrySummary.calls = snapshot?.calls || 0;
    telemetrySummary.errors = snapshot?.errors || 0;
    telemetrySummary.promptTokens = snapshot?.promptTokens || 0;
    telemetrySummary.completionTokens = snapshot?.completionTokens || 0;
    telemetrySummary.costUsd = snapshot?.costUsd || 0;
    telemetrySummary.estimatedCostCalls = snapshot?.estimatedCostCalls || 0;
    telemetrySummary.lastModel = snapshot?.lastModel || '-';
    telemetrySummary.lastLatencyMs = snapshot?.lastLatencyMs ?? null;
    telemetrySummary.lastContextPercent = snapshot?.lastContextPercent ?? null;
    telemetrySummary.lastInputTokens = snapshot?.lastInputTokens ?? null;
    telemetrySummary.lastInputEstimated = snapshot?.lastInputEstimated === true;
    telemetrySummary.lastContextWindow = snapshot?.lastContextWindow ?? null;
    updateTelemetrySummary();
  }

  function consumeTelemetry(entry) {
    const telemetry = entry && entry.telemetry;
    if (!telemetry) return;

    telemetrySummary.calls += 1;
    if (telemetry.status === 'error') telemetrySummary.errors += 1;
    telemetrySummary.promptTokens += telemetry.promptTokens || 0;
    telemetrySummary.completionTokens += telemetry.completionTokens || 0;
    if (typeof telemetry.totalCostUsd === 'number' && Number.isFinite(telemetry.totalCostUsd)) {
      telemetrySummary.costUsd += telemetry.totalCostUsd;
      telemetrySummary.estimatedCostCalls += 1;
    }
    telemetrySummary.lastModel = telemetry.actualModel || telemetry.requestedModel || '-';
    telemetrySummary.lastLatencyMs = typeof telemetry.latencyMs === 'number' ? telemetry.latencyMs : null;
    telemetrySummary.lastContextPercent = typeof telemetry.contextPct === 'number'
      ? telemetry.contextPct
      : null;
    telemetrySummary.lastInputTokens = typeof telemetry.promptTokens === 'number'
      ? telemetry.promptTokens
      : typeof telemetry.approxPromptTokens === 'number'
        ? telemetry.approxPromptTokens
      : null;
    telemetrySummary.lastInputEstimated = typeof telemetry.promptTokens !== 'number' && typeof telemetry.approxPromptTokens === 'number';
    telemetrySummary.lastContextWindow = typeof telemetry.contextLimit === 'number'
      ? telemetry.contextLimit
      : null;
    updateTelemetrySummary();
  }

  function highlightSearch(msg) {
    if (!searchQuery) return escapeHtml(msg);
    const escaped = escapeHtml(msg);
    const lc = escaped.toLowerCase();
    const qlc = searchQuery.toLowerCase();
    let result = '';
    let i = 0;
    while (i < escaped.length) {
      const j = lc.indexOf(qlc, i);
      if (j === -1) { result += escaped.slice(i); break; }
      result += escaped.slice(i, j) + '<span class="highlight">' + escaped.slice(j, j + qlc.length) + '</span>';
      i = j + qlc.length;
    }
    return result;
  }

  function buildLine(entry, idx) {
    const cat = categorize(entry.msg, entry.agentCtx);
    if (!matchesFilter(cat, entry.agentCtx) || !matchesSearch(entry.msg)) return null;

    const wrap = document.createElement('div');
    wrap.dataset.idx = String(idx);
    if (entry.id != null) wrap.dataset.entryId = String(entry.id);

    const div = document.createElement('div');
    // Tool lines inherit context color but are indented
    const lineCat = (entry.agentCtx && (entry.msg.trimStart().startsWith('🔧') || entry.msg.trimStart().startsWith('✓ ')))
      ? entry.agentCtx
      : cat;
    div.className = 'log-line line-' + lineCat;
    div.dataset.cat = cat;
    div.dataset.msg = entry.msg;

    const hasDetail = entry.detail && entry.detail.length > 0;
    div.innerHTML =
      '<span class="ts">' + entry.ts + '</span>' +
      '<span class="msg">' + highlightSearch(entry.msg) + '</span>' +
      (hasDetail
        ? '<button class="expand-btn" onclick="toggleDetail(this)">▶ detail</button>'
        : (entry.hasDetail === false ? '<button class="expand-btn" style="opacity:0.4" disabled>⏳</button>' : ''));
    wrap.appendChild(div);

    if (hasDetail) {
      const detailDiv = document.createElement('div');
      detailDiv.className = 'tool-detail';
      detailDiv.textContent = entry.detail;
      wrap.appendChild(detailDiv);
    }
    return wrap;
  }

  function toggleDetail(btn) {
    const wrap = btn.closest('[data-idx]');
    const dd = wrap && wrap.querySelector('.tool-detail');
    if (!dd) return;
    const open = dd.classList.toggle('open');
    btn.textContent = open ? '▼ hide' : '▶ detail';
  }

  function mergeEntry(entry) {
    if (!entry || entry.id == null) return false;
    const idx = allLines.findIndex(existing => existing && existing.id === entry.id);
    if (idx < 0) return false;

    const existing = allLines[idx];
    allLines[idx] = {
      ...existing,
      ...entry,
      detail: entry.detail ?? existing.detail,
      hasDetail: entry.hasDetail ?? existing.hasDetail,
    };

    if (entry.detail && entry.detail.length > 0) {
      patchDetail(entry.id, entry.detail);
    }

    return true;
  }

  function addEntry(entry) {
    if (entry && entry.id != null) {
      if (seenEntryIds.has(entry.id)) {
        mergeEntry(entry);
        return;
      }
      seenEntryIds.add(entry.id);
    }
    const idx = allLines.length;
    allLines.push(entry);
    if (entry.kind === 'telemetry' && !entry.replay) consumeTelemetry(entry);
    if (emptyState.style.display !== 'none') emptyState.style.display = 'none';

    const el = buildLine(entry, idx);
    if (el) logArea.insertBefore(el, emptyState);

    // Update category count badges
    const cat = categorize(entry.msg, entry.agentCtx);
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    updateBadge(cat);

    lineCount.textContent = allLines.length + ' lines';
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  // Badge counters on filter buttons
  const catCounts = {};
  function updateBadge(cat) {
    const mapToBtn = { tool: 'tool', success: 'success', error: 'error', identity: 'identity', media: 'media', academic: 'academic', strategy: 'strategy' };
    const btnCat = mapToBtn[cat];
    if (!btnCat) return;
    const badge = document.getElementById('badge-' + btnCat);
    if (badge) badge.textContent = catCounts[cat] || '';
  }

  function patchDetail(entryId, detail) {
    const idx = allLines.findIndex(entry => entry && entry.id === entryId);
    if (idx < 0) return;
    allLines[idx].detail = detail;
    allLines[idx].hasDetail = true;
    // Update DOM
    const wrap = logArea.querySelector('[data-entry-id="' + entryId + '"]');
    if (!wrap) return;
    const btn = wrap.querySelector('.expand-btn');
    if (btn) { btn.textContent = '▶ detay'; btn.disabled = false; btn.style.opacity = '1'; }
    if (!wrap.querySelector('.tool-detail')) {
      const dd = document.createElement('div');
      dd.className = 'tool-detail';
      dd.textContent = detail;
      wrap.appendChild(dd);
    }
  }

  function rebuildLog() {
    logArea.textContent = '';
    logArea.appendChild(emptyState);
    if (allLines.length === 0) {
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < allLines.length; i++) {
      const el = buildLine(allLines[i], i);
      if (el) frag.appendChild(el);
    }
    logArea.insertBefore(frag, emptyState);
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  function setFilter(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.toolbar .btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    rebuildLog();
  }

  function applySearch(q) {
    searchQuery = q;
    rebuildLog();
  }

  function toggleScroll() {
    autoScroll = !autoScroll;
  btnScroll.textContent = autoScroll ? '⬇ Auto-Scroll: ON' : '⏸ Auto-Scroll: OFF';
    btnScroll.classList.toggle('active', autoScroll);
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  function clearLogs() {
    localClearGeneration += 1;
    allLines = [];
    seenEntryIds.clear();
    Object.keys(catCounts).forEach(k => delete catCounts[k]);
    document.querySelectorAll('.badge').forEach(b => { b.textContent = ''; });
    telemetrySummary.calls = 0;
    telemetrySummary.errors = 0;
    telemetrySummary.promptTokens = 0;
    telemetrySummary.completionTokens = 0;
    telemetrySummary.costUsd = 0;
    telemetrySummary.estimatedCostCalls = 0;
    telemetrySummary.lastModel = '-';
    telemetrySummary.lastLatencyMs = null;
    telemetrySummary.lastContextPercent = null;
    telemetrySummary.lastInputTokens = null;
    telemetrySummary.lastInputEstimated = false;
    telemetrySummary.lastContextWindow = null;
    updateTelemetrySummary();
    rebuildLog();
    lineCount.textContent = '0 lines';
  }

  // Disable auto-scroll when user manually scrolls
  logArea.addEventListener('wheel', () => {
    const atBottom = logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      btnScroll.textContent = '⏸ Auto-Scroll: OFF';
      btnScroll.classList.remove('active');
    }
  });

  // SSE connection
  function connect() {
    const es = new EventSource('/events');

    es.onopen = () => {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Connected — live';
    };

    es.onerror = () => {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Disconnected — reconnecting...';
      es.close();
      setTimeout(connect, 3000);
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'init') {
          const sessionChanged = currentServerSessionId !== null && currentServerSessionId !== data.sessionId;
          currentServerSessionId = data.sessionId || null;
          if (sessionChanged) clearLogs();
          replayAllowedGeneration = localClearGeneration; // allow replays at this generation
          applyTelemetrySummarySnapshot(data.telemetrySummary);
          void replayAllowedGeneration; // used below
        } else if (data.type === 'patch') {
          patchDetail(data.id, data.detail);
        } else {
          if (!data.replay || localClearGeneration === replayAllowedGeneration) addEntry(data);
        }
      } catch { /* malformed */ }
    };
  }

  btnScroll.classList.add('active');
  updateTelemetrySummary();
  connect();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    clients.add(res);

    broadcastInitEvent(res);

    // Send buffer to newly connected client
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify({ ...entry, replay: true })}\n\n`);
    }

    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end();
});

let started = false;

export function startLogServer(): void {
  if (started) return;
  started = true;
  server.listen(PORT, '127.0.0.1', () => {
    // Do not write to stdout — would break TUI. Notify via progressEmitter.
    progressEmitter.emit(
      'progress',
      `📊 Log panel ready → http://localhost:${PORT}`,
    );
  });
  server.on('error', () => { /* skip silently if port is busy */ });
}

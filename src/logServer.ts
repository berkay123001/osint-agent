/**
 * OSINT Agent — Canlı Log Sunucusu
 * progressEmitter'ı SSE üzerinden tarayıcıya aktarır.
 * Kullanım: npm run chat → otomatik başlar → http://localhost:3334
 */

import http from 'http';
import { progressEmitter } from './lib/progressEmitter.js';

const PORT = Number(process.env.LOG_PORT) || 3334;
const BUFFER_SIZE = 2000;

interface LogEntry {
  ts: string;
  msg: string;
  detail?: string;   // tam araç çıktısı (opsiyonel)
  hasDetail?: boolean;
}

const logBuffer: LogEntry[] = [];
const clients = new Set<http.ServerResponse>();

// pending detail: son gönderilen ✓ satırına bağlamak için
let pendingDetailKey: string | null = null;

function broadcast(entry: LogEntry): void {
  if (logBuffer.length >= BUFFER_SIZE) logBuffer.shift();
  logBuffer.push(entry);
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

progressEmitter.on('progress', (msg: string) => {
  const ts = new Date().toTimeString().slice(0, 8);
  const entry: LogEntry = { ts, msg };
  // ✓ satırı → bir sonraki detail event'i bu satıra bağlanacak
  if (msg.trimStart().startsWith('✓ ')) {
    pendingDetailKey = ts + msg.slice(0, 60);
    entry.hasDetail = false; // detail henüz gelmedi
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
    // Zaten gönderildi — patch event gönder
    const data = `data: ${JSON.stringify({ type: 'patch', idx: logBuffer.length - 1, detail: output })}\n\n`;
    for (const client of clients) {
      client.write(data);
    }
  }
  pendingDetailKey = null;
});

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OSINT Agent — Canlı Loglar</title>
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
  }
  .expand-btn:hover { background: var(--bg3); }

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
</style>
</head>
<body>

<header>
  <div class="logo">🕵️ OSINT Agent</div>
  <div class="status-dot" id="status-dot"></div>
  <span id="status-text" style="color: var(--muted); font-size: 11px;">Bağlanıyor...</span>
  <div class="header-right">
    <div class="counter" id="line-count">0 satır</div>
    <button class="btn" id="btn-scroll" onclick="toggleScroll()">⬇ Oto-Kaydır: AÇ</button>
    <button class="btn" onclick="clearLogs()">🗑 Temizle</button>
  </div>
</header>

<div class="toolbar">
  <span class="filter-label">FİLTRE:</span>
  <button class="btn active" onclick="setFilter('all', this)">Tümü</button>
  <button class="btn" onclick="setFilter('tool', this)">🔧 Araçlar</button>
  <button class="btn" onclick="setFilter('strategy', this)">🧠 Strateji</button>
  <button class="btn" onclick="setFilter('identity', this)">🕵️ Kimlik</button>
  <button class="btn" onclick="setFilter('media', this)">📸 Medya</button>
  <button class="btn" onclick="setFilter('academic', this)">📚 Akademik</button>
  <button class="btn" onclick="setFilter('error', this)">❌ Hatalar</button>
  <button class="btn" onclick="setFilter('success', this)">✅ Başarılı</button>
  <div class="search-wrap">
    <input type="text" id="search" placeholder="Logda ara..." oninput="applySearch(this.value)">
  </div>
</div>

<div id="log-area">
  <div class="empty-state" id="empty-state">
    <div class="icon">📡</div>
    <div>Agent başlatılmayı bekleniyor...</div>
    <div style="font-size: 11px;">npm run chat komutu çalıştırıldığında loglar burada görünecek</div>
  </div>
</div>

<footer>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--tool)"></div> Araç</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--strategy)"></div> Strateji</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--identity)"></div> Kimlik</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--success)"></div> Başarılı</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--error)"></div> Hata</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--warn)"></div> Uyarı</div>
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

  const logArea = document.getElementById('log-area');
  const emptyState = document.getElementById('empty-state');
  const lineCount = document.getElementById('line-count');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const btnScroll = document.getElementById('btn-scroll');

  function categorize(msg) {
    if (msg.includes('🔧') || msg.includes('✓ ')) return 'tool';
    if (msg.includes('✅') || msg.includes('[DONE]') || msg.includes('tamamlandı')) return 'success';
    if (msg.includes('❌') || msg.includes('Error') || msg.includes('hata') || msg.includes('Hata')) return 'error';
    if (msg.includes('🧠') || msg.includes('Strategy') || msg.includes('Strateji') || msg.includes('[Strategy')) return 'strategy';
    if (msg.includes('⚠️') || msg.includes('warn') || msg.includes('Uyarı')) return 'warn';
    if (msg.includes('🕵') || msg.includes('IdentityAgent') || msg.includes('Kimlik')) return 'identity';
    if (msg.includes('📸') || msg.includes('MediaAgent') || msg.includes('Medya') || msg.includes('Media')) return 'media';
    if (msg.includes('📚') || msg.includes('AcademicAgent') || msg.includes('Akademik')) return 'academic';
    if (msg.includes('🔄') || msg.includes('tekrar') || msg.includes('retry') || msg.includes('Retry')) return 'retry';
    if (msg.includes('Supervisor') || msg.includes('supervisor') || msg.includes('🌐 Koordinatör')) return 'supervisor';
    return 'default';
  }

  function matchesFilter(cat) {
    if (currentFilter === 'all') return true;
    return cat === currentFilter;
  }

  function matchesSearch(msg) {
    if (!searchQuery) return true;
    return msg.toLowerCase().includes(searchQuery.toLowerCase());
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
    const cat = categorize(entry.msg);
    if (!matchesFilter(cat) || !matchesSearch(entry.msg)) return null;

    const wrap = document.createElement('div');
    wrap.dataset.idx = String(idx);

    const div = document.createElement('div');
    div.className = 'log-line line-' + cat;
    div.dataset.cat = cat;
    div.dataset.msg = entry.msg;

    const hasDetail = entry.detail && entry.detail.length > 0;
    div.innerHTML =
      '<span class="ts">' + entry.ts + '</span>' +
      '<span class="msg">' + highlightSearch(entry.msg) + '</span>' +
      (hasDetail
        ? '<button class="expand-btn" onclick="toggleDetail(this)">▶ detay</button>'
        : (entry.hasDetail === false ? '<button class="expand-btn" onclick="toggleDetail(this)" style="opacity:0.4" disabled>⏳</button>' : ''));
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
    btn.textContent = open ? '▼ gizle' : '▶ detay';
  }

  function addEntry(entry) {
    const idx = allLines.length;
    allLines.push(entry);
    if (emptyState.style.display !== 'none') emptyState.style.display = 'none';

    const el = buildLine(entry, idx);
    if (el) logArea.appendChild(el);

    lineCount.textContent = allLines.length + ' satır';
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  function patchDetail(idx, detail) {
    if (idx < 0 || idx >= allLines.length) return;
    allLines[idx].detail = detail;
    allLines[idx].hasDetail = true;
    // DOM güncelle
    const wrap = logArea.querySelector('[data-idx="' + idx + '"]');
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
    while (logArea.firstChild && logArea.firstChild !== emptyState) {
      logArea.removeChild(logArea.firstChild);
    }
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
    btnScroll.textContent = autoScroll ? '⬇ Oto-Kaydır: AÇ' : '⏸ Oto-Kaydır: KAPALI';
    btnScroll.classList.toggle('active', autoScroll);
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  function clearLogs() {
    allLines = [];
    rebuildLog();
    lineCount.textContent = '0 satır';
  }

  // Kullanıcı scroll yapınca oto-kaydırmayı kapat
  logArea.addEventListener('wheel', () => {
    const atBottom = logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      btnScroll.textContent = '⏸ Oto-Kaydır: KAPALI';
      btnScroll.classList.remove('active');
    }
  });

  // SSE bağlantısı
  function connect() {
    const es = new EventSource('/events');

    es.onopen = () => {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Bağlı — canlı';
    };

    es.onerror = () => {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Bağlantı kesildi — yeniden bağlanıyor...';
      es.close();
      setTimeout(connect, 3000);
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'patch') {
          patchDetail(data.idx, data.detail);
        } else {
          addEntry(data);
        }
      } catch { /* malformed */ }
    };
  }

  btnScroll.classList.add('active');
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

    // Yeni bağlanan istemciye tamponu gönder
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    clients.add(res);
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
    // stdout'a yazma — TUI bozulur. progressEmitter üzerinden bildir.
    progressEmitter.emit(
      'progress',
      `📊 Log paneli hazır → http://localhost:${PORT}`,
    );
  });
  server.on('error', () => { /* port meşgulse sessizce geç */ });
}

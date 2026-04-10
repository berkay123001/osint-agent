/* ═══════════════════════════════════════════════════════
   OSINT Agent — Intelligence Platform (Client)
   SSE + Chat + Graph + Background + Notifications
   ═══════════════════════════════════════════════════════ */

/* ── State ─────────────────────────────────────────── */
const state = {
  connected: false,
  processing: false,
  messages: [],       // {role, content}
  feedCount: 0,
  toolCount: 0,
  graphLoaded: false,
};

/* ── DOM refs (cached after DOMContentLoaded) ──────── */
let $messages, $welcome, $input, $sendBtn, $typing, $typingText;
let $feedArea, $toolsArea, $graphSvg, $graphInfo;
let $msgCount, $feedBadge, $toolsBadge, $toasts;
let $connStatus;

/* ── Token (from URL or sessionStorage) ────────────── */
function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || sessionStorage.getItem('osint_token') || '';
}
function tokenParam() {
  const t = getToken();
  return t ? `?token=${encodeURIComponent(t)}` : '';
}

/* ═══ SSE Connection ═══════════════════════════════ */
let evtSource = null;
let reconnectTimer = null;

function connectSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  clearTimeout(reconnectTimer);

  evtSource = new EventSource(`/api/events${tokenParam()}`);

  evtSource.onopen = () => {
    state.connected = true;
    updateConnectionUI(true);
  };

  evtSource.onmessage = (e) => {
    try { handleSSE(JSON.parse(e.data)); }
    catch { /* ignore parse errors */ }
  };

  evtSource.onerror = () => {
    state.connected = false;
    updateConnectionUI(false);
    evtSource.close();
    reconnectTimer = setTimeout(connectSSE, 3000);
  };
}

function handleSSE(data) {
  switch (data.type) {
    case 'init':
      state.processing = data.processing;
      updateProcessingUI();
      break;

    case 'user_message':
      addMessage('user', data.content);
      break;

    case 'response':
      addMessage('assistant', data.content);
      state.processing = false;
      updateProcessingUI();
      if (!state.graphLoaded) loadGraph();
      else setTimeout(loadGraph, 500);
      break;

    case 'status':
      state.processing = data.processing;
      updateProcessingUI();
      break;

    case 'progress':
      addFeedLine(data.msg, data.ts);
      updateAgentStatus(data.msg);
      break;

    case 'detail':
      addToolCard(data.toolName, data.output);
      break;

    case 'error':
      showToast(data.message || 'Hata oluştu', 'error');
      state.processing = false;
      updateProcessingUI();
      break;

    case 'reset':
      resetUI();
      break;
  }
}

/* ═══ Chat ═════════════════════════════════════════ */
function addMessage(role, content) {
  if (!content) return;
  state.messages.push({ role, content });
  renderMessage(role, content);
  hideWelcome();
  updateMsgCount();
  scrollToBottom();
}

function renderMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message msg-${role}`;

  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = '🤖';
    div.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'assistant' && typeof marked !== 'undefined') {
    bubble.innerHTML = marked.parse(content, { breaks: true, gfm: true });
    // Open links in new tab
    bubble.querySelectorAll('a').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  } else {
    bubble.textContent = content;
  }

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);

  div.appendChild(bubble);
  $messages.appendChild(div);
}

async function sendMessage(text) {
  if (!text.trim() || state.processing) return;

  state.processing = true;
  updateProcessingUI();

  try {
    const resp = await fetch(`/api/chat${tokenParam()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text.trim() }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || `Hata: ${resp.status}`, 'error');
      state.processing = false;
      updateProcessingUI();
    }
  } catch (e) {
    showToast('Bağlantı hatası', 'error');
    state.processing = false;
    updateProcessingUI();
  }
}

function sendFromInput() {
  const text = $input.value;
  if (!text.trim()) return;
  $input.value = '';
  autoResize($input);
  sendMessage(text);
}

function quickSend(text) {
  sendMessage(text);
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFromInput();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/* ═══ Live Feed ════════════════════════════════════ */
let feedEmpty = true;

function addFeedLine(msg, ts) {
  if (feedEmpty) {
    $feedArea.innerHTML = '';
    feedEmpty = false;
  }

  const line = document.createElement('div');
  line.className = `feed-line cat-${categorizeFeed(msg)}`;

  const tsSpan = document.createElement('span');
  tsSpan.className = 'feed-ts';
  tsSpan.textContent = ts || new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const msgSpan = document.createElement('span');
  msgSpan.className = 'feed-msg';
  msgSpan.textContent = msg;

  line.appendChild(tsSpan);
  line.appendChild(msgSpan);
  $feedArea.appendChild(line);

  state.feedCount++;
  $feedBadge.textContent = state.feedCount > 99 ? '99+' : state.feedCount;

  // Auto-scroll
  $feedArea.scrollTop = $feedArea.scrollHeight;
}

function categorizeFeed(msg) {
  if (!msg) return 'default';
  const m = msg.toLowerCase();
  if (m.includes('🔧') || m.includes('tool') || m.includes('çağr') || m.includes('call'))    return 'tool';
  if (m.includes('✅') || m.includes('tamamlan') || m.includes('bulundu'))                     return 'success';
  if (m.includes('❌') || m.includes('hata') || m.includes('error') || m.includes('başarısız')) return 'error';
  if (m.includes('strateji') || m.includes('strategy') || m.includes('🧠'))                    return 'strategy';
  if (m.includes('identity') || m.includes('kimlik') || m.includes('🕵'))                      return 'identity';
  if (m.includes('media') || m.includes('medya') || m.includes('📸'))                           return 'media';
  if (m.includes('akademi') || m.includes('academic') || m.includes('📚'))                      return 'academic';
  return 'default';
}

/* ═══ Tool Cards ═══════════════════════════════════ */
function addToolCard(name, output) {
  const card = document.createElement('div');
  card.className = 'tool-card';

  const header = document.createElement('div');
  header.className = 'tool-card-header';
  header.onclick = () => card.classList.toggle('open');

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-card-name';
  nameEl.textContent = name || 'tool';

  const argsEl = document.createElement('span');
  argsEl.className = 'tool-card-args';
  argsEl.textContent = (output || '').slice(0, 80) + (output && output.length > 80 ? '…' : '');

  const statusEl = document.createElement('span');
  statusEl.className = 'tool-card-status';
  statusEl.textContent = '▶';

  header.appendChild(nameEl);
  header.appendChild(argsEl);
  header.appendChild(statusEl);

  const body = document.createElement('div');
  body.className = 'tool-card-body';
  body.textContent = output || '(çıktı yok)';

  card.appendChild(header);
  card.appendChild(body);
  $toolsArea.appendChild(card);

  state.toolCount++;
  $toolsBadge.textContent = state.toolCount > 99 ? '99+' : state.toolCount;

  $toolsArea.scrollTop = $toolsArea.scrollHeight;
}

/* ═══ Agent Status ═════════════════════════════════ */
const agentMap = {
  supervisor: ['koordinatör', 'supervisor', 'yönlend', 'routing'],
  identity:   ['identity', 'kimlik', 'identityagent'],
  media:      ['media', 'medya', 'mediaagent', 'görsel'],
  academic:   ['academic', 'akademik', 'academicagent'],
  strategy:   ['strategy', 'strateji', 'strategyagent'],
};

function updateAgentStatus(msg) {
  if (!msg) return;
  const m = msg.toLowerCase();

  for (const [agent, keywords] of Object.entries(agentMap)) {
    const el = document.getElementById(`ind-${agent}`);
    if (!el) continue;

    const isActive = keywords.some(kw => m.includes(kw));
    const isDone = m.includes('tamamlandı') || m.includes('completed') || m.includes('✅');

    if (isActive && !isDone) {
      el.classList.add('active');
    } else if (isActive && isDone) {
      el.classList.remove('active');
    }
  }

  // Clear all when processing stops
  if (!state.processing) {
    document.querySelectorAll('.agent-ind').forEach(el => el.classList.remove('active'));
  }
}

/* ═══ D3 Knowledge Graph ═══════════════════════════ */
let simulation = null;

const nodeColors = {
  Person:     '#00d4ff',
  Username:   '#4da6ff',
  Email:      '#ff8c00',
  Platform:   '#7b2dff',
  Finding:    '#00e87b',
  Claim:      '#ffc107',
  Source:      '#ff4466',
  Evidence:   '#ff8c00',
  default:    '#8899b8',
};

async function loadGraph() {
  try {
    const resp = await fetch(`/api/graph${tokenParam()}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.nodes || data.nodes.length === 0) {
      $graphInfo.textContent = 'Graf boş';
      return;
    }
    renderGraph(data.nodes, data.edges || data.links || []);
    state.graphLoaded = true;
  } catch { /* silent */ }
}

function renderGraph(nodes, edges) {
  const container = document.getElementById('graph-container');
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 400;

  // Clear previous
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  $graphInfo.textContent = `${nodes.length} düğüm · ${edges.length} bağlantı`;

  // Build D3 graph data
  const nodeById = new Map(nodes.map(n => [n.id, { ...n }]));
  const links = edges
    .filter(e => nodeById.has(e.source) && nodeById.has(e.target))
    .map(e => ({ source: e.source, target: e.target, type: e.type }));

  const gNodes = Array.from(nodeById.values());

  simulation = d3.forceSimulation(gNodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide(20));

  // Defs for glow filter
  const defs = svg.append('defs');
  const filter = defs.append('filter').attr('id', 'glow');
  filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
  const feMerge = filter.append('feMerge');
  feMerge.append('feMergeNode').attr('in', 'coloredBlur');
  feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

  const g = svg.append('g');

  // Zoom
  svg.call(d3.zoom()
    .scaleExtent([0.3, 4])
    .on('zoom', (e) => g.attr('transform', e.transform)));

  // Links
  const link = g.append('g').selectAll('line')
    .data(links).join('line')
    .attr('class', 'link-line');

  // Link labels
  const linkLabel = g.append('g').selectAll('text')
    .data(links).join('text')
    .attr('font-size', 7)
    .attr('fill', 'rgba(136,153,184,0.5)')
    .attr('text-anchor', 'middle')
    .attr('font-family', 'var(--font-mono)')
    .text(d => d.type || '');

  // Nodes
  const node = g.append('g').selectAll('circle')
    .data(gNodes).join('circle')
    .attr('class', 'node-circle')
    .attr('r', d => d.label === 'Person' ? 12 : 8)
    .attr('fill', d => nodeColors[d.label] || nodeColors.default)
    .attr('filter', 'url(#glow)')
    .attr('opacity', 0.85)
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  // Node labels
  const label = g.append('g').selectAll('text')
    .data(gNodes).join('text')
    .attr('class', 'node-label')
    .attr('dy', d => (d.label === 'Person' ? 20 : 16))
    .attr('text-anchor', 'middle')
    .text(d => (d.id || '').slice(0, 20));

  // Title tooltips
  node.append('title').text(d => `[${d.label}] ${d.id}`);

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    linkLabel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    node
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
    label
      .attr('x', d => d.x)
      .attr('y', d => d.y);
  });
}

/* ═══ Background Animation ═════════════════════════ */
function initBackground() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let w, h;
  const particles = [];
  const COUNT = 45;
  const CONNECT_DIST = 140;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      r: Math.random() * 1.5 + 0.5,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);

    // Connections
    for (let i = 0; i < COUNT; i++) {
      for (let j = i + 1; j < COUNT; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT_DIST) {
          const alpha = 0.035 * (1 - dist / CONNECT_DIST);
          ctx.strokeStyle = `rgba(0, 212, 255, ${alpha})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }

    // Dots
    for (const p of particles) {
      ctx.fillStyle = 'rgba(0, 212, 255, 0.15)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();

      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }

    requestAnimationFrame(draw);
  }
  draw();
}

/* ═══ Toasts ═══════════════════════════════════════ */
function showToast(text, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = text;
  $toasts.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/* ═══ UI Helpers ═══════════════════════════════════ */
function updateConnectionUI(connected) {
  const el = document.getElementById('conn-status');
  el.className = connected ? 'conn-status connected' : 'conn-status';
  el.querySelector('.conn-text').textContent = connected ? 'Bağlı' : 'Bağlanıyor...';
  if (connected) showToast('Sunucuya bağlandı', 'success');
}

function updateProcessingUI() {
  $typing.className = state.processing ? 'typing-indicator' : 'typing-indicator hidden';
  $sendBtn.disabled = state.processing;
  $input.disabled = state.processing;

  if (state.processing) {
    $typingText.textContent = 'Araştırılıyor...';
  }
}

function updateMsgCount() {
  const count = state.messages.length;
  $msgCount.textContent = count > 0 ? `${count} mesaj` : '';
}

function hideWelcome() {
  if ($welcome) $welcome.style.display = 'none';
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  const content = document.getElementById(`content-${name}`);
  if (content) content.classList.add('active');

  if (name === 'graph' && !state.graphLoaded) loadGraph();
}

async function resetSession() {
  if (state.processing) {
    showToast('Araştırma devam ederken sıfırlanamaz', 'error');
    return;
  }
  try {
    await fetch(`/api/reset${tokenParam()}`, { method: 'POST' });
  } catch { /* ignore */ }
}

function resetUI() {
  state.messages = [];
  state.feedCount = 0;
  state.toolCount = 0;
  state.graphLoaded = false;
  state.processing = false;

  $messages.innerHTML = '';
  $feedArea.innerHTML = '<div class="feed-empty"><span>📡</span><p>Agent başlatıldığında loglar burada akacak</p></div>';
  feedEmpty = true;
  $toolsArea.innerHTML = '';
  $feedBadge.textContent = '';
  $toolsBadge.textContent = '';
  $msgCount.textContent = '';
  d3.select('#graph-svg').selectAll('*').remove();
  $graphInfo.textContent = '';

  // Restore welcome
  if (!$welcome) {
    const w = document.createElement('div');
    w.id = 'welcome';
    w.className = 'welcome-screen';
    w.innerHTML = `
      <div class="welcome-icon">🔍</div>
      <h3>OSINT Araştırma Platformu</h3>
      <p>Kişi, kullanıcı adı, email, haber doğrulama veya akademik araştırma sorgusu yazın.</p>
      <div class="welcome-chips">
        <button class="chip" onclick="quickSend('defunkt GitHub hesabını araştır')">🐙 GitHub OSINT</button>
        <button class="chip" onclick="quickSend('İstanbul depremi haberlerini doğrula')">📰 Fact-check</button>
        <button class="chip" onclick="quickSend('Attention is All You Need makalesinin etkisini analiz et')">📚 Akademik</button>
      </div>`;
    $messages.appendChild(w);
    $welcome = w;
  } else {
    $welcome.style.display = '';
  }

  updateProcessingUI();
  document.querySelectorAll('.agent-ind').forEach(el => el.classList.remove('active'));
  showToast('Oturum sıfırlandı', 'info');
}

/* ═══ Load Previous History ════════════════════════ */
async function loadHistory() {
  try {
    const resp = await fetch(`/api/history${tokenParam()}`);
    if (!resp.ok) return;
    const msgs = await resp.json();
    if (msgs.length > 0) {
      hideWelcome();
      for (const m of msgs) {
        state.messages.push(m);
        renderMessage(m.role, m.content);
      }
      updateMsgCount();
      scrollToBottom();
    }
  } catch { /* ignore */ }
}

/* ═══ Init ═════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM refs
  $messages   = document.getElementById('messages');
  $welcome    = document.getElementById('welcome');
  $input      = document.getElementById('input');
  $sendBtn    = document.getElementById('send-btn');
  $typing     = document.getElementById('typing');
  $typingText = document.querySelector('.typing-text');
  $feedArea   = document.getElementById('feed-area');
  $toolsArea  = document.getElementById('tools-area');
  $graphSvg   = document.getElementById('graph-svg');
  $graphInfo  = document.getElementById('graph-info');
  $msgCount   = document.getElementById('msg-count');
  $feedBadge  = document.getElementById('feed-badge');
  $toolsBadge = document.getElementById('tools-badge');
  $toasts     = document.getElementById('toasts');
  $connStatus = document.getElementById('conn-status');

  // Save token to sessionStorage for clean URLs
  const t = new URLSearchParams(window.location.search).get('token');
  if (t) {
    sessionStorage.setItem('osint_token', t);
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Configure marked
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
  }

  // Start systems
  initBackground();
  connectSSE();
  loadHistory();

  // Focus input
  $input.focus();
});

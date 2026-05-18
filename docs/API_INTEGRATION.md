# OSINT Agent — REST API Entegrasyon Rehberi

Bu doküman, OSINT Agent REST API'sini kendi projene nasıl entegre edeceğini adım adım açıklar.

---

## İçindekiler

1. [Başlangıç](#1-başlangıç)
2. [Kimlik Doğrulama](#2-kimlik-doğrulama)
3. [Temel Kullanım Akışı](#3-temel-kullanım-akışı)
4. [Endpoint Referansı](#4-endpoint-referansı)
5. [SSE Canlı Olay Akışı](#5-sse-canlı-olay-akışı)
6. [Frontend React Örneği](#6-frontend-react-örneği)
7. [Frontend Vue/Nuxt Örneği](#7-frontend-vuenuxt-örneği)
8. [cURL Örnekleri](#8-curl-örnekleri)
9. [Python Örneği](#9-python-örneği)
10. [Tool Doğrudan Çağırma](#10-tool-doğrudan-çağırma)
11. [Graf (Neo4j) Sorguları](#11-graf-neo4j-sorguları)
12. [Hata Yönetimi](#12-hata-yönetimi)
13. [Rate Limiting](#13-rate-limiting)
14. [Ortam Değişkenleri](#14-ortam-değişkenleri)

---

## 1. Başlangıç

### Sunucuyu Başlat

```bash
npm run api
```

Sunucu varsayılan olarak **port 3002**'de başlar.

```
🕵️  OSINT Agent REST API: http://localhost:3002
📄  API Docs:        http://localhost:3002/api/v1/docs
📡  SSE Stream:      http://localhost:3002/api/v1/events
🧭  Health Check:    http://localhost:3002/api/v1/health
🔧  Tools:           http://localhost:3002/api/v1/tools
```

### OpenAPI Spec

Tam API spesifikasyonunu al:

```bash
curl http://localhost:3002/api/v1/docs
```

Bu URL'yi [Swagger Editor](https://editor.swagger.io)'e yapıştırarak interaktif dokümantasyonu görüntüleyebilirsin.

### Sağlık Kontrolü

```bash
curl http://localhost:3002/api/v1/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": "2h 15m",
  "neo4j": "connected (142 nodes, 89 rels)",
  "sessionId": "mpbeq38h-3sxdxc",
  "toolCount": 48
}
```

---

## 2. Kimlik Doğrulama

`.env` dosyasında `WEB_TOKEN` tanımlıysa, tüm `/api/v1/*` isteklerine token eklemen gerekir.

**İki yöntem:**

### Yöntem 1: Authorization Header (Önerilen)

```javascript
fetch('http://localhost:3002/api/v1/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer senin-token-buraya'
  },
  body: JSON.stringify({ message: 'Araştır...' })
})
```

### Yöntem 2: Query Parameter

```javascript
fetch('http://localhost:3002/api/v1/chat?token=senin-token-buraya', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Araştır...' })
})
```

**Token yoksa** (`.env`'de `WEB_TOKEN` boş veya yoksa) tüm endpoint'ler kimlik doğrulama gerektirmeden erişilebilir.

**401 Yanıtı:**

```json
{
  "error": "Unauthorized. Provide token via ?token= or Authorization: Bearer <token>",
  "statusCode": 401
}
```

---

## 3. Temel Kullanım Akışı

Tipik bir araştırma şu adımlardan oluşur:

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  POST /chat  │────▶│  GET /events │────▶│  GET /status  │────▶│ GET /history │
│  Soru gönder │     │  SSE dinle   │     │  Durum kontrol│     │  Sonuç al    │
└─────────────┘     └──────────────┘     └───────────────┘     └──────────────┘
```

### Adım 1: SSE Bağlantısını Aç (Önce)

```javascript
const es = new EventSource('http://localhost:3002/api/v1/events');
es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  console.log(data.type, data);
};
```

### Adım 2: Araştırma Sorusu Gönder

```javascript
await fetch('http://localhost:3002/api/v1/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Investigate username: torvalds' })
});
```

### Adım 3: SSE'den Gerçek Zamanlı Sonuçları Dinle

```
event: progress  → "🕵️ IdentityAgent: Starting investigation..."
event: detail    → { toolName: "search_web", output: "..." }
event: telemetry → { summary: { calls: 3, costUsd: 0.05 } }
event: response  → { content: "## Investigation Results\n..." }
event: status    → { processing: false }  ← Bitti!
```

### Adım 4: Geçmişi ve Grafı Al

```javascript
const history = await fetch('/api/v1/history').then(r => r.json());
const graph = await fetch('/api/v1/graph/session').then(r => r.json());
```

---

## 4. Endpoint Referansı

### Araştırma

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `POST` | `/api/v1/chat` | Araştırma başlat (asenkron) |
| `GET` | `/api/v1/status` | İşleme durumu |
| `GET` | `/api/v1/history` | Sohbet geçmişi |
| `POST` | `/api/v1/reset` | Oturumu sıfırla |

### Araçlar

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/v1/tools` | 48 aracı listele |
| `POST` | `/api/v1/tools/:name` | Doğrudan araç çağır |

### Graf (Neo4j)

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/v1/graph` | Tam graf verisi |
| `GET` | `/api/v1/graph/session` | Oturum graf haritası |
| `GET` | `/api/v1/graph/query/:value` | Entity bağlantı sorgula |
| `GET` | `/api/v1/graph/stats` | İstatistikler |
| `GET` | `/api/v1/graph/nodes` | Node listesi |

### Sistem

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/v1/events` | SSE canlı akış |
| `GET` | `/api/v1/telemetry` | LLM telemetri |
| `GET` | `/api/v1/health` | Sağlık kontrolü |
| `GET` | `/api/v1/docs` | OpenAPI 3.1 JSON spec |

---

## 5. SSE Canlı Olay Akışı

`GET /api/v1/events` bir **Server-Sent Events (SSE)** stream'dir. Her olay `data: {JSON}\n\n` formatında gönderilir.

### Bağlantı Açma

```javascript
const es = new EventSource('http://localhost:3002/api/v1/events');
```

### İlk Olay (`init`)

Bağlantı açıldığında mevcut durum ve geçmiş olaylar gönderilir:

```json
{
  "type": "init",
  "sessionId": "mpbeq38h-3sxdxc",
  "processing": false,
  "messageCount": 0,
  "telemetry": { "calls": 0, "costUsd": 0 },
  "replayEvents": []
}
```

### Olay Tipleri

| `type` | Ne Zaman Gelir | Payload |
|--------|----------------|---------|
| `init` | SSE bağlantısı açıldığında | `sessionId`, `processing`, `messageCount`, `telemetry`, `replayEvents` |
| `user_message` | `POST /chat` çağrıldığında | `content` — kullanıcının mesajı |
| `status` | İşlem durumu değiştiğinde | `processing` — `true` veya `false` |
| `progress` | Araştırma ilerlerken | `msg` — ilerleme mesajı, `ts` — zaman damgası |
| `detail` | Bir araç çalıştırıldığında | `toolName`, `toolCallId`, `output` |
| `telemetry` | LLM çağrısı yapıldığında | `msg`, `ts`, `telemetry`, `summary` |
| `response` | Araştırma tamamlandığında | `content` — Supervisor'ın formatlanmış yanıtı |
| `error` | Hata oluştuğunda | `message` — hata mesajı |
| `reset` | Oturum sıfırlandığında | `sessionId` — yeni session ID |
| `session_graph_dirty` | Oturum grafı güncellendi | Grafı yeniden çekmek için sinyal |

### Örnek SSE Akışı

```
data: {"type":"init","sessionId":"abc123","processing":false,"messageCount":0}

data: {"type":"user_message","content":"Investigate username: torvalds"}

data: {"type":"status","processing":true}

data: {"type":"progress","msg":"🕵️ IdentityAgent: Starting investigation...","ts":"14:32:05"}

data: {"type":"progress","msg":"Routing to IdentityAgent for username analysis","ts":"14:32:05"}

data: {"type":"detail","toolName":"search_web","toolCallId":"call_abc123","output":"Search results for torvalds..."}

data: {"type":"telemetry","msg":"[Tele] IdentityAgent → qwen3.6-plus | 3200ms","ts":"14:32:08","summary":{"calls":3,"costUsd":0.05}}

data: {"type":"detail","toolName":"run_github_osint","toolCallId":"call_def456","output":"GitHub profile found: torvalds..."}

data: {"type":"session_graph_dirty"}

data: {"type":"response","content":"## Investigation Results\n\n### torvalds\n\nFound on GitHub, Twitter..."}

data: {"type":"status","processing":false}
```

---

## 6. Frontend React Örneği

### Tam Çalışan Chat Bileşeni

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = 'http://localhost:3002/api/v1';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ToolResult {
  toolName: string;
  output: string;
}

export function OsintChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [processing, setProcessing] = useState(false);
  const [toolResults, setToolResults] = useState<ToolResult[]>([]);
  const [progress, setProgress] = useState<string[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  // SSE bağlantısını yönet
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events`);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);

      switch (data.type) {
        case 'init':
          console.log('Connected:', data.sessionId);
          break;

        case 'progress':
          setProgress(prev => [...prev, data.msg]);
          break;

        case 'detail':
          setToolResults(prev => [...prev, {
            toolName: data.toolName,
            output: data.output.slice(0, 500)
          }]);
          break;

        case 'response':
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: data.content
          }]);
          break;

        case 'status':
          setProcessing(data.processing);
          break;

        case 'error':
          console.error('Error:', data.message);
          break;
      }
    };

    es.onerror = () => {
      console.log('SSE disconnected, reconnecting...');
    };

    eventSourceRef.current = es;

    return () => {
      es.close();
    };
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || processing) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setToolResults([]);
    setProgress([]);

    await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMessage })
    });
  }, [input, processing]);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 20 }}>
      <h2>🕵️ OSINT Agent</h2>

      {/* Mesajlar */}
      <div style={{ minHeight: 300, border: '1px solid #333', borderRadius: 8, padding: 16 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{
            textAlign: msg.role === 'user' ? 'right' : 'left',
            margin: '8px 0'
          }}>
            <span style={{
              background: msg.role === 'user' ? '#2563eb' : '#1f2937',
              padding: '8px 16px',
              borderRadius: 12,
              display: 'inline-block',
              maxWidth: '70%',
              whiteSpace: 'pre-wrap'
            }}>
              {msg.content}
            </span>
          </div>
        ))}
      </div>

      {/* İlerleme */}
      {processing && progress.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
          {progress.slice(-3).map((p, i) => <div key={i}>{p}</div>)}
        </div>
      )}

      {/* Tool sonuçları */}
      {toolResults.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>🔧 {toolResults.length} araç çalıştırıldı</summary>
          {toolResults.map((t, i) => (
            <div key={i} style={{ background: '#111', padding: 8, margin: '4px 0', borderRadius: 4 }}>
              <strong>{t.toolName}</strong>
              <pre style={{ fontSize: 11, overflow: 'auto' }}>{t.output}</pre>
            </div>
          ))}
        </details>
      )}

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder="Araştırma sorusu yaz..."
          disabled={processing}
          style={{ flex: 1, padding: 12, borderRadius: 8, border: '1px solid #333', background: '#111', color: '#fff' }}
        />
        <button
          onClick={sendMessage}
          disabled={processing || !input.trim()}
          style={{ padding: '12px 24px', borderRadius: 8, background: '#2563eb', color: '#fff', border: 'none' }}
        >
          {processing ? '⏳' : ' gönder'}
        </button>
      </div>
    </div>
  );
}
```

---

## 7. Frontend Vue/Nuxt Örneği

```vue
<template>
  <div class="osint-chat">
    <h2>🕵️ OSINT Agent</h2>

    <div class="messages">
      <div v-for="(msg, i) in messages" :key="i" :class="msg.role">
        {{ msg.content }}
      </div>
    </div>

    <div v-if="processing" class="progress">
      <div v-for="(p, i) in progress.slice(-3)" :key="i">{{ p }}</div>
    </div>

    <form @submit.prevent="send">
      <input v-model="input" :disabled="processing" placeholder="Araştır..." />
      <button :disabled="processing">Gönder</button>
    </form>
  </div>
</template>

<script setup>
const API = 'http://localhost:3002/api/v1';

const messages = ref([]);
const input = ref('');
const processing = ref(false);
const progress = ref([]);
let eventSource = null;

onMounted(() => {
  eventSource = new EventSource(`${API}/events`);

  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    switch (data.type) {
      case 'progress':
        progress.value.push(data.msg);
        break;
      case 'response':
        messages.value.push({ role: 'assistant', content: data.content });
        break;
      case 'status':
        processing.value = data.processing;
        if (!data.processing) progress.value = [];
        break;
      case 'error':
        alert('Hata: ' + data.message);
        break;
    }
  };
});

onUnmounted(() => eventSource?.close());

async function send() {
  if (!input.value.trim() || processing.value) return;

  messages.value.push({ role: 'user', content: input.value });
  const msg = input.value;
  input.value = '';

  await $fetch(`${API}/chat`, {
    method: 'POST',
    body: { message: msg }
  });
}
</script>
```

---

## 8. cURL Örnekleri

### Sağlık Kontrolü

```bash
curl http://localhost:3002/api/v1/health
```

### Araştırma Başlat

```bash
curl -X POST http://localhost:3002/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Investigate username: torvalds on all platforms"}'
```

### İşlem Durumu

```bash
curl http://localhost:3002/api/v1/status
```

### Sohbet Geçmişi

```bash
curl http://localhost:3002/api/v1/history
```

### Oturumu Sıfırla

```bash
curl -X POST http://localhost:3002/api/v1/reset
```

### Tool Listesi

```bash
curl http://localhost:3002/api/v1/tools
```

### Tool Çalıştır — Web Arama

```bash
curl -X POST http://localhost:3002/api/v1/tools/search_web \
  -H "Content-Type: application/json" \
  -d '{"args": {"query": "OpenAI GPT-5 release date"}}'
```

### Tool Çalıştır — Sherlock

```bash
curl -X POST http://localhost:3002/api/v1/tools/run_sherlock \
  -H "Content-Type: application/json" \
  -d '{"args": {"username": "torvalds"}}'
```

### Tool Çalıştır — Email Breach Kontrolü

```bash
curl -X POST http://localhost:3002/api/v1/tools/check_email_registrations \
  -H "Content-Type: application/json" \
  -d '{"args": {"email": "test@gmail.com"}}'
```

### Graf İstatistikleri

```bash
curl http://localhost:3002/api/v1/graph/stats
```

### Entity Bağlantı Sorgula

```bash
curl http://localhost:3002/api/v1/graph/query/torvalds
```

### Node Listesi (Filtreli)

```bash
curl "http://localhost:3002/api/v1/graph/nodes?label=Username&limit=20"
```

### Oturum Graf Haritası

```bash
curl http://localhost:3002/api/v1/graph/session
```

### LLM Telemetri

```bash
curl http://localhost:3002/api/v1/telemetry
```

### SSE Canlı Akış (Terminal'de İzle)

```bash
curl -N http://localhost:3002/api/v1/events
```

### Token ile Kimlik Doğrulama

```bash
# Header ile
curl -H "Authorization: Bearer senin-token" http://localhost:3002/api/v1/status

# Query ile
curl "http://localhost:3002/api/v1/status?token=senin-token"
```

---

## 9. Python Örneği

```python
import requests
import json
import sseclient

API_BASE = "http://localhost:3002/api/v1"

# Sağlık kontrolü
health = requests.get(f"{API_BASE}/health").json()
print(f"Status: {health['status']}, Tools: {health['toolCount']}")

# Araştırma başlat
response = requests.post(f"{API_BASE}/chat", json={
    "message": "Investigate username: torvalds"
})
print(f"Started: {response.json()}")

# SSE akışını dinle
client = sseclient.SSEClient(f"{API_BASE}/events")
for event in client.events():
    data = json.loads(event.data)

    if data["type"] == "progress":
        print(f"[{data['ts']}] {data['msg']}")

    elif data["type"] == "detail":
        print(f"  Tool: {data['toolName']}")

    elif data["type"] == "response":
        print(f"\nSonuç:\n{data['content'][:500]}")

    elif data["type"] == "status" and not data["processing"]:
        print("Araştırma tamamlandı!")
        break

# Geçmişi al
history = requests.get(f"{API_BASE}/history").json()
for msg in history["messages"]:
    print(f"[{msg['role']}] {msg['content'][:100]}")

# Tool doğrudan çağır
result = requests.post(f"{API_BASE}/tools/search_web", json={
    "args": {"query": "OpenAI latest news"}
})
print(f"Search result: {result.json()['result'][:200]}")
```

---

## 10. Tool Doğrudan Çağırma

Agent'a soru sormak yerine, 48 OSINT aracını tek tek çağırabilirsin.

### Kullanılabilir Araçları Listele

```bash
curl http://localhost:3002/api/v1/tools
```

Yanıt:

```json
{
  "count": 48,
  "tools": [
    {
      "name": "search_web",
      "description": "Search the web using...",
      "parameters": {
        "query": { "type": "string", "description": "Search query" }
      },
      "required": ["query"]
    }
  ]
}
```

### Popüler Araçlar ve Parametreleri

| Araç | Açıklama | Zorunlu Parametreler |
|------|----------|---------------------|
| `search_web` | Web arama | `query` |
| `search_web_multi` | Çoklu web arama | `queries` (array) |
| `run_sherlock` | Username araştırma (300+ platform) | `username` |
| `run_maigret` | Username araştırma (1000+ site) | `username` |
| `run_github_osint` | GitHub profil analizi | `username` |
| `check_email_registrations` | Email kayıt kontrolü | `email` |
| `check_breaches` | Veri ihlali kontrolü | `email` |
| `web_fetch` | URL içeriğini çek | `url` |
| `reverse_image_search` | Ters görsel arama | `image_url` |
| `extract_metadata` | Dosya/dosya metadata çıkarma | `url` |
| `search_academic_papers` | Akademik yayın arama | `query` |
| `wayback_search` | Wayback Machine arşivi | `url` |
| `verify_claim` | Haber doğrulama | `claim` |
| `scrape_profile` | Profil sayfası çekme | `url` |
| `search_person` | Kişi arama | `name` |
| `nitter_profile` | Nitter/Twitter profil | `username` |

### Çağırma Formatı

```bash
curl -X POST http://localhost:3002/api/v1/tools/<araç-adı> \
  -H "Content-Type: application/json" \
  -d '{"args": { <parametreler> }}'
```

### Yanıt Formatı

```json
{
  "ok": true,
  "tool": "search_web",
  "result": "Arama sonuçları...",
  "error": null
}
```

**Hata durumunda:**

```json
{
  "ok": false,
  "tool": "run_sherlock",
  "result": null,
  "error": "Tool error: username parameter is required"
}
```

---

## 11. Graf (Neo4j) Sorguları

> **Not:** Graf endpoint'leri Neo4j veritabanı çalıştığında veri döndürür. Neo4j kapalıysa HTTP 503 döner.

### Tam Graf Verisi

```bash
curl http://localhost:3002/api/v1/graph
```

```json
{
  "nodes": [
    { "id": "torvalds", "label": "Username", "caption": "torvalds" },
    { "id": "github", "label": "Platform", "caption": "GitHub" }
  ],
  "edges": [
    { "from": "torvalds", "to": "github", "label": "FOUND_ON", "caption": "confidence: 0.95" }
  ]
}
```

### Oturum Graf Haritası

Araştırma sırasında oluşturulan ajen-tool-entity ilişki haritası:

```bash
curl http://localhost:3002/api/v1/graph/session
```

### Entity Bağlantıları

Belirli bir username, email veya entity için tüm bağlantıları sorgula:

```bash
curl http://localhost:3002/api/v1/graph/query/torvalds
```

```json
{
  "value": "torvalds",
  "connectionCount": 5,
  "connections": [
    {
      "from": "torvalds",
      "to": "Linus Torvalds",
      "relation": "IDENTITY",
      "toLabel": "Person",
      "confidence": "high",
      "source": "run_github_osint"
    }
  ]
}
```

### İstatistikler

```bash
curl http://localhost:3002/api/v1/graph/stats
```

```json
{
  "nodes": 142,
  "relationships": 89
}
```

### Node Listesi (Filtrelenebilir)

```bash
# Tüm node'lar
curl http://localhost:3002/api/v1/graph/nodes

# Sadece Username node'ları
curl "http://localhost:3002/api/v1/graph/nodes?label=Username"

# İlk 20 node
curl "http://localhost:3002/api/v1/graph/nodes?limit=20"
```

### Frontend'de Graf Görselleştirme

```javascript
// Graf verisini al
const graphData = await fetch('/api/v1/graph/session').then(r => r.json());

// D3.js, vis.js veya Cytoscape ile görselleştir
// graphData.nodes → node'lar
// graphData.edges → bağlantılar
```

---

## 12. Hata Yönetimi

### HTTP Durum Kodları

| Kod | Anlamı |
|-----|--------|
| `200` | Başarılı |
| `400` | Geçersiz istek (eksik/hatalı parametre) |
| `401` | Kimlik doğrulama gerekli (token eksik/yanlış) |
| `404` | Endpoint veya araç bulunamadı |
| `409` | Çakışma (araştırma devam ediyor, sıfırlama reddedildi) |
| `429` | Rate limit aşıldı |
| `500` | Sunucu iç hatası |
| `503` | Neo4j bağlantı hatası (graf endpoint'leri) |

### Hata Yanıt Formatı

```json
{
  "error": "Açıklayıcı hata mesajı",
  "statusCode": 400
}
```

### 404 ile Tool Bulunamadı

```json
{
  "error": "Tool not found: invalid_tool_name",
  "statusCode": 404,
  "availableTools": ["search_web", "run_sherlock", "..."]
}
```

### Frontend'de Hata Yönetimi

```javascript
async function apiCall(endpoint, options = {}) {
  const response = await fetch(`/api/v1${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

// Kullanım
try {
  await apiCall('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'Test' }),
  });
} catch (err) {
  if (err.message.includes('Research in progress')) {
    console.log('Devam eden araştırma var, bekleyin');
  }
}
```

---

## 13. Rate Limiting

| Endpoint Grubu | Limit |
|----------------|-------|
| Genel (`/chat`, `/status`, `/history`, vb.) | IP başına 60 istek/dakika |
| SSE (`/events`) | IP başına 120 istek/dakika |
| Graf (`/graph`, `/graph/*`) | IP başına 120 istek/dakika |

**Aşımda:**

```json
{
  "error": "Too many requests",
  "statusCode": 429
}
```

---

## 14. Ortam Değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `API_PORT` | `3002` | API sunucu portu |
| `WEB_TOKEN` | (boş) | Kimlik doğrulama token'ı (boşsa auth devre dışı) |
| `OPENROUTER_API_KEY` | (zorunlu) | LLM API anahtarı |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j bağlantı URI |
| `NEO4J_USER` | `neo4j` | Neo4j kullanıcı adı |
| `NEO4J_PASSWORD` | (boş) | Neo4j şifre |

### .env Dosyası

```env
API_PORT=3002
WEB_TOKEN=
OPENROUTER_API_KEY=sk-or-v1-xxxxx
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_password
```

---

## Mimari Diyagram

```
Frontend (React/Vue/...)
    │
    ├── POST /api/v1/chat ──────────▶ Supervisor Agent
    │                                     │
    ├── GET  /api/v1/events (SSE) ◀──────┤── progressEmitter
    │                                     │
    │                               ┌─────┴──────┐
    │                               │  Sub-Agents │
    │                               │             │
    │                               │ Identity    │── run_sherlock
    │                               │ Agent       │── run_maigret
    │                               │             │── check_email
    │                               │             │── run_github_osint
    │                               │             │
    │                               │ Media       │── reverse_image
    │                               │ Agent       │── extract_metadata
    │                               │             │
    │                               │ Academic    │── search_papers
    │                               │ Agent       │
    │                               │             │
    │                               │ Strategy    │── Orkestrasyon
    │                               │ Agent       │
    │                               └─────┬──────┘
    │                                     │
    ├── GET /api/v1/graph ◀──────── Neo4j Database
    │
    ├── GET /api/v1/tools ◀──────── Tool Registry (48 araç)
    │
    └── GET /api/v1/telemetry ◀───── LLM Telemetry
```

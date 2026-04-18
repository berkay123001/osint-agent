# Multi-Agent System — Framework Blueprint

Domain-bağımsız çok-ajanlı sistem mimarisi. Bu dokümanı herhangi bir projeye
adapte edebilirsin: OSINT, siber güvenlik, finans analizi, sağlık, hukuk — fark etmez.

---

## 1. Temel Prensip

**Framework yok.** Her şey elle yazılmış bir `while` döngüsü.
Tek bağımlılık: OpenAI SDK → herhangi bir provider endpoint'ine yönlendirilir.

Neden:
- Framework'ler sürüm değişimlerinde kırılır
- Tool call döngüsü özelleştirme gerektirir (cache, budget, retry, fallback)
- Debugging: tek dosyayı açarsın, her şey orada
- Fallback model zinciri framework'lere zor eklenir

---

## 2. Mimari Genel Görünüm

```
                    ┌──────────────┐
                    │    USER      │
                    │ (CLI / Web)  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  SUPERVISOR  │
                    │              │
                    │ • Routing    │
                    │ • Koordinasyon
                    │ • Raporlama  │
                    └──┬───┬───┬──┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
         ┌─────────┐ ┌─────────┐ ┌─────────┐
         │ SUB-AGENT│ │ SUB-AGENT│ │ SUB-AGENT│
         │    A     │ │    B     │ │    C     │
         └────┬─────┘ └────┬─────┘ └────┬─────┘
              │             │             │
              └─────────────┼─────────────┘
                            │
                   ┌────────▼────────┐
                   │ STRATEGY AGENT  │
                   │ (opsiyonel)     │
                   │ Plan / Review / │
                   │ Synthesize      │
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │  TOOL REGISTRY  │
                   │  Merkezi dispatch│
                   └────────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌─────────┐  ┌─────────┐  ┌─────────┐
         │ Tool Set│  │ Tool Set│  │ Tool Set│
         │   (A)   │  │   (B)   │  │  (DB)   │
         └─────────┘  └─────────┘  └─────────┘
```

---

## 3. Dosya Yapısı

```
src/
  agents/
    types.ts              ← Değişmez tipler (AgentConfig, Message, AgentResult)
    baseAgent.ts          ← Değişmez agent loop (runAgentLoop)
    supervisorAgent.ts    ← Giriş noktası, routing, sub-agent delegasyon
    subAgentA.ts          ← Domain'e göre isimlendir
    subAgentB.ts
    strategyAgent.ts      ← Opsiyonel — plan/review/synthesize

  lib/
    toolRegistry.ts       ← Araç tanımları + merkezi dispatcher
    chatHistory.ts        ← History sanitizasyon + context management
    progressEmitter.ts    ← UI ↔ agent köprüsü (EventEmitter)

  tools/
    toolA.ts              ← Domain araçları
    toolB.ts
    ...
```

---

## 4. Core Tipler

```typescript
import type OpenAI from 'openai';

export type ToolExecutor = (
  name: string,
  args: Record<string, string>
) => Promise<string>;

export interface AgentConfig {
  name: string;                          // Log ve hata mesajlarında görünür
  systemPrompt: string;                  // System mesajı olarak geçilir
  tools: OpenAI.Chat.ChatCompletionTool[];  // Kullanabileceği araçlar
  executeTool: ToolExecutor;             // Araç çağırma fonksiyonu
  model?: string;                        // Override model
  maxToolCalls?: number;                 // Araç bütçesi (default: 30)
  maxTokens?: number;                    // Yanıt token limiti (default: 32768)
}

export type Message = OpenAI.Chat.ChatCompletionMessageParam;

export interface AgentResult {
  finalResponse: string;
  toolCallCount: number;
  toolsUsed: Record<string, number>;     // { toolName: callCount }
  history?: Message[];                   // Sub-agent devir teslim için
}
```

---

## 5. Agent Loop (`baseAgent.ts`)

Tüm agentların kalbi. Tek `while` döngüsü, override edilmez.

```
runAgentLoop(history, config) → AgentResult

while (true)
  │
  ├─ 1. Budget kontrol
  │     toolCallCount >= maxToolCalls?
  │     → tool_choice = 'none'
  │     → "araçlar bitti, rapor yaz" mesajı inject
  │
  ├─ 2. LLM çağrısı
  │     sanitizeHistoryForProvider(history)
  │     → OpenAI chat completion
  │
  ├─ 3. Hata yönetimi
  │     ├─ 429 rate limit     → bekle, aynı model retry → fallback zinciri
  │     ├─ Content filter     → fallback model
  │     ├─ 502/504/timeout    → bekle, retry
  │     ├─ Invalid JSON args  → düzeltme iste (max 3)
  │     └─ Diğer              → throw
  │
  ├─ 4. Boş yanıt retry (3 aşama)
  │     1. "Rapor yaz" iste
  │     2. Araçları kapat, sadece metin iste
  │     3. Temiz API çağrısı (history'siz)
  │
  ├─ 5. Tool call işleme
  │     JSON parse → cache kontrol → limit kontrol → execute
  │     history'ye ekle → toolCallCount++ → döngü başı
  │
  └─ 6. Metin yanıt → RETURN AgentResult
```

### Bileşenler

| Bileşen | Amaç |
|---|---|
| `FALLBACK_MODELS[]` | Rate limit / hata durumunda sıralı model deneme |
| `callCache` | Aynı tool+args → cache'den dön, API çağrısı yapma |
| `PER_TOOL_LIMITS` | Tek araç bütün bütçeyi yemesin |
| `stripThinkingTokens()` | Thinking modellerin `<think/>` etiketlerini temizle |
| `emitProgress()` | Her tool çağrısında UI'ye bildir |

---

## 6. Supervisor

Giriş noktası. 3 tip araç sunar:

```
Supervisor araçları:
  ├── Native tools    → Kendi doğrudan araçları
  ├── Meta tools      → Sub-agent delegasyon (ask_subAgentA, ask_subAgentB)
  └── read_session    → Sub-agent disk çıktısını oku
```

### Sub-Agent Delegasyon

```typescript
// Meta tool parametreleri
{
  query: string,      // Tam görev tanımı
  context?: string,   // Bilinen bağlam
  depth?: 'quick' | 'normal' | 'deep'  // Bütçe çarpanı
}
// quick = 0.5x, normal = 1x, deep = 1.75x maxToolCalls
```

### Delegasyon Akışı (Strategy'siz)

```
Supervisor → meta tool çağırır
  → subAgentFn(query, context)
  → result döner
  → session dosyasına kaydet
  → Supervisor'a result dön
```

### Delegasyon Akışı (Strategy ile)

```
Supervisor → meta tool çağırır
  → StrategySession.plan()      → taktiksel plan
  → subAgentFn(query + plan)    → ham sonuç
  → StrategySession.review()    → kalite + yeterlilik kontrol
  → (rejected ise 1 retry)
  → StrategySession.synthesize() → profesyonel rapor
  → Supervisor'a final rapor dön
```

---

## 7. Strategy Agent (Opsiyonel)

Sub-agent'ın çalışmasını planlama + denetleme + sentezleme.
Tool çağırmaz — sadece düşünür.

### Session-Aware Tasarım

Her sub-agent delegasyonu için bir `StrategySession` açılır.
3 aşama aynı conversation history üzerinden yürür → Strategy kendi planını hatırlar.

```
StrategySession
  │
  ├─ .plan(context)
  │    → Araştırma planı üret
  │    → Yanıt history'ye kaydedilir
  │
  ├─ .review(result)
  │    → History'de planı GÖRÜR
  │    → Kalite kontrol + yeterlilik değerlendirmesi
  │    → Yanıt history'ye kaydedilir
  │
  └─ .synthesize(result, feedback)
       → History'de plan + review'u GÖRÜR
       → Temiz, profesyonel çıktı üret
       → Yanıt history'ye kaydedilir
```

**Neden session-aware:** Stateless (her çağrı yeni conversation) olsaydı, Strategy
review'da kendi planını hatırlamazdı. "Planımda X dedim, yapıldı mı?" diye kontrol edemezdi.

---

## 8. Tool Registry

Merkezi dispatcher. Agentlar `executeTool(name, args)` çağırır.

```typescript
// Schema tanımı (OpenAI function format)
export const tools: OpenAI.Chat.ChatCompletionTool[] = [...];

// Dispatcher
export async function executeTool(name: string, args: Record<string, string>): Promise<string>;

// Cache — aynı args tekrar gelirse API çağrısı yapmaz
const sessionCache = new Map<string, string>();
```

### Parametre Validasyonu

Her aracın parametreleri schema ile validate edilir:

```typescript
// Zod, JSON Schema, veya manuel validation — tercihine göre
const schema = z.object({ query: z.string().min(1) });
```

### Sub-Agent Araç Filtreleme

Her sub-agent sadece ilgili araçları görür:

```typescript
const subAgentTools = tools.filter(t => ALLOWED_TOOLS.includes(t.function.name));
```

---

## 9. History Management

Provider'a gönderilmeden önce history temizlenir.

```
sanitizeHistoryForProvider(history)
  ├── Boş assistant content → fallback string
  ├── Boş tool result       → fallback string
  ├── Tool result > N char  → kırp
  └── Toplam > MAX char     → eski tool sonuçlarını at
```

### Context Bridge

History trim edildiğinde model bağlamı kaybeder → selamlama yapar.
Çözüm: Trim sonrası bağlam inject et.

```
[BAĞLAM: Orijinal soru: "...". Son durum: "..."]
```

### Normalizasyon Kuralları

- History'ye ham `response.message` ekleme → `normalizeAssistantMessage()` kullan
- Tool result'ı direkt ekleme → `normalizeToolContent()` kullan
- Her ikisi de boş içerik fallback + length limit uygular

---

## 10. UI ↔ Agent Köprüsü

Agent UI'ı bilmez. `progressEmitter` event emitter ile haberleşir.

```typescript
// Agent tarafı
emitProgress("Tool X çalıştı")
emitToolDetail("toolName", hamÇıktı)

// UI tarafı
progressEmitter.on('progress', callback)  // TUI, Web SSE, vs.
progressEmitter.on('detail', callback)    // Detay paneli
```

---

## 11. Model Stratejisi

| Rol | Gereksinim | Önerilen Özellikler |
|---|---|---|
| Supervisor | Routing, koordinasyon, kullanıcı muhabbeti | Geniş context, güçlü reasoning |
| Sub-agent'lar | Araç kullanımı, görev icrası | Tool use desteği, hızlı, ucuz |
| Strategy | Derin düşünme, planlama | En güçlü reasoning, tool gerekmez |
| Fallback zinciri | Hata durumunda yedek | En az 2-3 alternatif model |

**Kural:** Sub-agent'lara atanacak modellerin `tools: true` desteklediğini doğrula.
Strategy Agent tool kullanmayacağı için `tools: false` modeller de uygun.

---

## 12. Session Persistence

Sub-agent sonuçları diske yazılır → Supervisor tekrar çağırmadan okuyabilir.

```
sessions/
  subAgentA-last-session.md     ← Ham araç çıktıları
  subAgentB-last-session.md
  strategy-log.md               ← Plan + review geçmişi
  active-session.json           ← Multi-turn konuşma geçmişi
```

---

## 13. Yeni Domain'e Adaplasyon

```
1. types.ts           → Olduğu gibi kopyala
2. progressEmitter.ts → Olduğu gibi kopyala
3. chatHistory.ts     → Olduğu gibi kopyala
4. baseAgent.ts       → FALLBACK_MODELS + DEFAULT_MODEL değiştir, kopyala
5. strategyAgent.ts   → SYSTEM_PROMPT domain'e göre düzenle, kopyala (opsiyonel)
6. tools/             → Domain araçlarını yaz (Zod schema ile)
7. toolRegistry.ts    → Araçları kaydet, dispatcher yaz
8. subAgent'lar       → Domain'e göre isimlendir, system prompt yaz
9. supervisorAgent.ts → Meta tool isimleri + routing prompt yaz
10. Giriş noktası     → CLI / Web / TUI — runSupervisor(history) çağır
```

---

## 14. Kritik Tasarım Kararları

### Neden history shared state?

- Sub-agent → Supervisor'a history dönebilir → continuation (baştan başlamaz)
- Strategy aynı history üzerinde ilerler → planını hatırlar
- Context bridge: trim sonrası bağlam inject → "Merhaba!" reset engellenir

### Neden tool result kırpılır?

- Büyük sonuçlar history'yi şişirir → model bağlamı kaybeder
- Ham veri disk'e yazılır → gerektiğinde erişilebilir
- Model kararlı kalmak için history küçük tutulur

### Neden `tool_choice: 'none'` budget sonrası?

- Budget dolsa bile model tool çağırmayı deneyebilir
- `none` zorla metin yanıt üretir
- History'ye "araçlar bitti" mesajı inject edilir → model ne yapacağını anlar

### Neden per-tool limit?

- Tek bir araç (örn. arama) tüm bütçeyi tüketebilir
- Agent diğer araçları kullanamadan kalır
- Her araç için max çağrı sayısı tanımlanır

### Neden call cache?

- LLM bazen aynı tool çağrısını tekrar eder
- Sonuç değişmez, API çağrısı israf olur
- Cache key = toolName + sorted JSON args

---

## 15. Anti-Patterns

| Yapma | Yap |
|---|---|
| Framework ekle | Elle `while` döngüsü |
| Her agent'a ayrı LLM client | Tek client, `baseAgent.ts`'te |
| History'ye raw mesaj ekle | `normalize*()` fonksiyonlarını kullan |
| Tool result'ı kırpmadan history'ye koy | Limit uygula, ham veriyi diske yaz |
| Sub-agent'ı her seferinde sıfırdan çalıştır | History continuation kullan |
| Fallback'siz model kullan | En az 2 fallback tanımla |
| `console.log` ile çıktı | `emitProgress()` ile UI'ye bildir |
| Tool parametrelerini validate etme | Schema validation uygula |
| Context kaybını görmezden gel | Context bridge uygula |

---

## 16. Örnek Sub-Agent Ekleme

```typescript
// agents/subAgent.ts
import { runAgentLoop } from './baseAgent.js';
import { tools, executeTool } from '../lib/toolRegistry.js';
import type { AgentConfig, Message } from './types.js';

const TOOLS = ['search', 'fetch', 'analyze'];  // İzin verilen araçlar

export async function runSubAgent(
  query: string,
  context?: string,
  depth?: string
): Promise<{ response: string; history: Message[] }> {
  const history: Message[] = [
    { role: 'system', content: `Domain uzmanısın. ${context ?? ''}` },
    { role: 'user', content: query },
  ];

  const multiplier = depth === 'deep' ? 1.75 : depth === 'quick' ? 0.5 : 1;
  const config: AgentConfig = {
    name: 'SubAgent',
    systemPrompt: '',
    tools: tools.filter(t => TOOLS.includes(t.function.name)),
    executeTool,
    model: 'model-name',
    maxToolCalls: Math.floor(25 * multiplier),
  };

  const result = await runAgentLoop(history, config);
  return { response: result.finalResponse, history: result.history ?? [] };
}
```

```typescript
// supervisorAgent.ts — meta tool tanımı
{
  name: 'ask_sub_agent',
  description: 'Sub-agent\'a görev delege et',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Görev tanımı' },
      context: { type: 'string', description: 'Bilinen bağlam' },
      depth: { type: 'string', enum: ['quick', 'normal', 'deep'] },
    },
    required: ['query'],
  },
}
```

---
title: "OSINT Agent — 2 Haftalık Geliştirme Özeti"
subtitle: "24 Mart – 9 Nisan 2026 | 120 Commit | 101 Dosya | +19,212 / -1,425 Satır"
date: 2026-04-09
author: "Berkay Hasret Baykara"
---

# OSINT Agent — 2 Haftalık Geliştirme Özeti

**24 Mart – 9 Nisan 2026 (W14-W15)**

| Metrik | Değer |
|--------|-------|
| Toplam Commit | 120 |
| Değişen Dosya | 101 |
| Eklenen Satır | +19,212 |
| Silinen Satır | -1,425 |
| Test Sayısı | 31 (hepsi yeşil) |
| Aktif Gün | 15 |
| Yeni Tool | 12 |
| Yeni Agent | 3 |

---

## Dashboard

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ██████╗ ██████╗ ███████╗ █████╗ ███╗   ███╗███████╗                          │
│  ██╔══██╗██╔══██╗██╔════╝██╔══██╗████╗ ████║██╔════╝                          │
│  ██║  ██║██████╔╝█████╗  ███████║██╔████╔██║███████╗                          │
│  ██║  ██║██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║╚════██║                          │
│  ██████╔╝██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████║                          │
│  ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Multi-Agent │ Model Bench │ TUI Rewrite │ CLI Deploy │ Stabilite           │
│     System   │    (10+)    │   (Ink)     │   (npm)    │   (30+ fix)         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Multi-Agent Sistemi & Model Benchmark

### Hybrid Model Konfigürasyonu (Final)

2 hafta süren yoğun benchmark sonucunda optimal model konfigürasyonu belirlendi:

| Agent | Model | Token Limit | Max Tool Calls | Uzmanlık |
|-------|-------|-------------|----------------|----------|
| **Supervisor** | `qwen/qwen3.6-plus:free` | 32K | 30 | Yönlendirme, koordinasyon |
| **IdentityAgent** | `kwaipilot/kat-coder-pro-v2` | 30K | 30 | Username, email, GitHub |
| **MediaAgent** | `kwaipilot/kat-coder-pro-v2` | 30K | 30 | Görsel, EXIF, fact-check |
| **AcademicAgent** | `deepseek/deepseek-chat-v3-0324` | 60K | 60 | Makale, intihal, derin okuma |

### Benchmark Edilen Modeller

```
arcee-ai/trinity-large-thinking       → Thinking için test edildi
minimax/minimax-m2.7                  → Karpathy benchmark'ta başarılı
google/gemini-flash-lite-1.5          → Hızlı ama yüzeysel
qwen/qwen3.6-plus-preview             → Supervisor için ideal
kwaipilot/kat-coder-pro-v2            → Sub-agent için en iyi
deepseek/deepseek-chat-v3-0324        → Academic için en iyi
grok/grok-4.1-fast                   → Test edildi
qwen/qwen3.5-plus-02-15               → Önceki default
```

### Sub-Agent Response Truncation

Sub-agent cevaplarında karakter limiti artırıldı:
- **Önceki:** 12,000 karakter
- **Yeni:** 30,000 karakter
- **Sebep:** Detaylı akademik ve araştırma cevapları kesiliyordu

### Agent Prompt İyileştirmeleri

```typescript
// IdentityAgent prompt ham veriden çıkarım yapma kuralı
"Var olan verilerden çıkarım yapma. Sadece tool sonuçlarına dayanarak raporla."

// Supervisor pre-delegation kuralı yumuşatıldı
// AGENT_DONE sonrası supplementary araştırmaya izin verildi
```

### Hallucination Önleme

- Tool call deduplication — aynı tool'u tekrar çağırma
- Sub-agent sonuçları doğrudan Obsidian'a yaz — Supervisor JSON crash riski azaltıldı
- Re-delegation döngüsü engellendi
- AcademicAgent döngü ve hallucination fix

---

## 2. Arama & Scraping Altyapısı

### SearXNG Self-Hosted Search

Docker üzerinde kendi metasearch engine'imizi kurduk:

```yaml
# docker-compose.yml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8888:8080"
    volumes:
      - ./docker/searxng/settings.yml:/etc/searxng/settings.yml
```

| Özellik | Değer |
|---------|-------|
| URL | `http://localhost:8888` |
| Engine sayısı | 100+ (Google, Bing, Brave, Qwant, Reddit...) |
| Format | JSON API |
| Rate Limit | Yok (self-hosted) |
| Yanıt süresi | ~1.5s |

### 4 Katmanlı Arama Fallback Zinciri

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  SearXNG    │ ──▶ │   Brave     │ ──▶ │  Google CSE │ ──▶ │   Tavily    │
│ (self-hosted│     │  (1.1s      │     │  (site:     │     │  (son       │
│  primary)   │     │   throttle) │     │   bypass)   │     │   çare)     │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

**Sosyal medya `site:` sorguları** Brave'i bypass edip direkt Google CSE'ye gidiyor.

### Brave Search Rate Limiter

```typescript
// 1.1 saniye throttle ile 2000 req/ay limit koruma
const BRAVE_RATE_LIMIT = 1100; // ms
```

### Scrapling Primary Scraper

Nitter instance'larının çoğu bloklandı. Scrapling stealth scraper primary oldu:

```
Scrapling (--stealth) → Puppeteer Stealth → Firecrawl Cloud
     (primary)            (fallback)          (son çare)
```

**Scrapling avantajları:**
- Cloudflare Turnstile bypass
- Anti-bot koruması aşması
- Sınırsız kullanım (local Python)
- Ayrı conda env (`SCRAPLING_PYTHON`)

### PDF to Text Conversion

```bash
pdftotext "$pdf_file" -  # CLI tabanlı PDF dönüştürücü
```

### 504 Upstream Timeout Handler

```typescript
// Gateway timeout için özel retry logic
if (error.status === 504) {
  await sleep(3000);
  return retry();
}
```

---

## 3. Yeni Tool'lar

### Maigret Entegrasyonu (3000+ Platform)

```python
# maigret_runner.py
# Pinterest, Discord, Instagram ve 3000+ platformda username taraması
```

| Özellik | Detay |
|---------|-------|
| Platform | 3000+ |
| Python binary | Direct binary call |
| Output | JSON + Human readable |

### GPX Analyzer Tool

GPS verisi analizi için yeni tool:

- GPX XML parsing (track point, elevation, timestamp)
- Coğrafi merkez hesaplama (haversine formula)
- Hotspot tespiti (tekrarlayan konumlar)
- Reverse geocoding (OpenStreetMap Nominatim)
- Cross-track overlap analizi

### Plagiarism Checker

Akademik intihal/özgünlük analizi:

```typescript
// Jaccard shingle + CrossRef/S2 + Neo4j SIMILAR_TO graph
- Temporal priority (eski makale öncelikli)
- Concept novelty
- Journal credibility
- Citation pattern analysis
```

### Obsidian Vault Entegrasyonu

4 yeni Obsidian tool'u:

| Tool | İşlev |
|------|-------|
| `obsidian_write` | Vault'a not yazma |
| `obsidian_append` | Mevcut nota ekleme |
| `obsidian_search` | Vault içinde arama |
| `obsidian_write_profile` | Profil klasörü oluştur |

### mark_false_positive Tool

GNN eğitimi için soft labeling:

```cypher
MATCH (n) WHERE n.mlLabel = 'false_positive' RETURN n
MATCH (n) WHERE n.mlLabel = 'verified' RETURN n
```

Node silmeden etiketleme — eğitim verisi için ideal.

### Coding Agent Chat Tool

OSINT agent ile çok turlu kodlama sohbeti:

```typescript
// OSINT araştırması sırasında coding soruları
// Aynı session içinde hem OSINT hem coding
```

### Supervisor Graph Write Tools

Cybersecurity node types ile graph yazma:

```typescript
- IOC (Indicator of Compromise)
- Framework, Tool, Malware
- ThreatActor, Campaign
```

---

## 4. TUI / CLI Yeniden Yazım

### Ink (React for CLI) Tabanlı Yeni TUI

Eski readline tabanlı CLI tamamen yeniden yazıldı. Ink kütüphanesi ile React bileşenleri gibi CLI UI.

```
src/ui/
├── App.tsx           // Ana uygulama
├── Banner.tsx        // G.U.A.R.D banner
├── MessageList.tsx   // Mesaj geçmişi
├── PromptInput.tsx   // Input alanı
├── CommandMenu.tsx   // Slash komut menüsü
└── SessionPicker.tsx // Oturum seçici
```

### Özellikler

| Özellik | Açıklama |
|---------|----------|
| **Slash komutları** | `/resume`, `/delete`, `/log toggle` |
| **Inline tamamlama** | Tab ile komut tamamlama |
| **Ok tuşlu menü** | Interaktif seçim |
| **Paste desteği** | Çok satırlı Ctrl+V |
| **Canlı aktivite logu** | Tool call görünürlüğü |
| **Markdown renderer** | Zengin metin gösterimi |

### Log Paneli

```
┌─────────────────────────────────────────────────────────────┐
│ [01:52:24] [TOOL] 🔧 search_web executed                   │
│ [01:52:26] [TOOL] ✓ scrape_page completed                  │
│ [01:52:28] [TOOL] ❌ github_user failed (404)              │
└─────────────────────────────────────────────────────────────┘
```

### G.U.A.R.D Banner Tasarımı

```
   ██████╗ ██████╗ ███████╗ █████╗ ███╗   ███╗███████╗
```

---

## 5. CLI Dağıtım & Kurulum

### npm Global CLI

```bash
npm install -g osint-agent
osint --help
```

### Kurulum Sihirbazı

```bash
osint --setup
```

Otomatik kurulum:
- Docker (SearXNG + Firecrawl)
- Neo4j database
- Python environment
- `.env` dosyası

### Kaldırma Sihirbazı

```bash
osint --uninstall
```

Temiz kaldırma:
- Docker container'lar durdurulur
- Neo4j data temizlenir
- Global CLI kaldırılır

### /resume Komutu

Çoklu oturum geçmişi ve arşivleme:

```bash
osint
> /resume
# 1. Session: vitalik_buterin (2026-04-08 14:32)
# 2. Session: andrej_karpathy (2026-04-08 16:45)
# Seçiminiz: 1
```

### Dinamik Araştırma Derinliği

| Mod | Derinlik | Kullanım |
|-----|----------|----------|
| Quick | Hızlı tarama | Basit sorgular |
| Normal | Standart | Varsayılan |
| Deep | Derin araştırma | Karmaşık OSINT |

---

## 6. Stabilite & Hata Düzeltmeleri

### Supervisor JSON Crash (Kritik Fix)

**Sorun:** Uzun session'larda Supervisor JSON hatası veriyordu.

**Kök neden:** History yapısındaki orphaned tool messages.

**Çözüm:**
- History trim karakter limiti
- max_tokens 4096 → 32768
- Orphaned message temizleme

```typescript
// max_tokens artırıldı
max_tokens: 32768  // Önceki: 4096
```

### 429 Rate Limit Handling

İki farklı 429 durumu için handling:

```typescript
// 1. HTTP exception
if (error instanceof APIConnectionError) {
  await sleep(5000);
  return retry();
}

// 2. Response body path
if (data.error?.includes('rate limit')) {
  await sleep(5000);
  return retry();
}
```

### Thinking Model Boş Yanıt Retry

3 aşamalı retry mekanizması:

```typescript
// 1. Araçları kapatıp tekrar dene
// 2. Temiz çağrı (no tools)
// 3. Force text mode
```

### JSON Correction Sonsuz Döngü

Global 6-deneme cap eklendi:

```typescript
let jsonAttempts = 0;
const MAX_JSON_ATTEMPTS = 6;
```

### Diğer Stabilite İyileştirmeleri

| Fix | Açıklama |
|-----|----------|
| holehe rate-limit false positive | `rateLimit:true` sonuçlar filtreleniyor |
| AcademicAgent döngü | Re-delegation loop engellendi |
| Tool call dedup | Aynı tool tekrar çağrılmıyor |
| Agent dayanıklılık | 429, 502, DataInspectionFailed handling |
| Ink TUI stdout kirlenmesi | `emitProgress` ile tüm loglar yönlendirildi |

---

## 7. Test & CI/CD

### baseAgent Regression Testleri

```typescript
// baseAgent.test.ts - 8 test
- 429 rate limit retry
- 502 bad gateway retry
- DataInspectionFailed fallback
- Empty response handling
- JSON correction loop
- Tool call execution
- Message truncation
- Error recovery
```

### GitHub Pages Workflow

Private repo (GitHub Pro) için Pages workflow:

```yaml
name: GitHub Pages
on:
  push:
    branches: [master]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
```

### CI Pipeline

```yaml
# .github/workflows/ci.yml
Node 22 → tsc → npm test
```

31/31 test geçiyor.

---

## 8. Graph & Neo4j

### Graph UI (Port 3333)

```bash
npm run graph
# http://localhost:3333
```

Özellikler:
- Force-directed layout
- Renkli node tipleri
- Hover detayları
- Zoom/pan

### Yeni Node Tipleri

| Tip | Açıklama |
|-----|----------|
| Claim | Doğrulanacak iddia |
| Fact | Doğrulama sonucu |
| Source | Kaynak referansı |
| IOC | Indicator of Compromise |
| Framework | Framework/Tool |
| ThreatActor | Tehdit aktörü |
| Malware | Zararlı yazılım |
| Campaign | Kampanya |

### ElementId Fix for Edges

```typescript
// Edge'lerde elementId kullanımı
// Claim/Fact/Source node'ları doğru görünüyorda
```

### Toplu Neo4j Yazma

```typescript
// Batch write performans iyileştirmesi
await neo4j.batchWrite(nodes, edges);
```

---

## 9. Akademik Araştırma

### AcademicAgent

Derin akademik araştırma için özel sub-agent:

**Yetenekler:**
- arXiv + Semantic Scholar çift kaynak
- ar5iv üzerinden tam makale içeriği
- Yazar profili çıkarma (Author API)
- Neo4j grafa otomatik yazma
- Intihal/özgünlük analizi

**Kalıcı bilgi tabanı:**
```typescript
.osint-sessions/academic-knowledge.md
```

### Kalıcı Knowledge Base

Tüm ajanlar için session persistence:
- Follow-up re-delegation önlendi
- History'den tüm araç sonuçları kaydediliyor
- Session'lar arası continuity

---

## 10. Önemli Commit'ler

```bash
282bddd feat: hybrid model config + Sherlock/PDF/Nitter fixes
3f122ee chore: sub-agent model → kwaipilot/kat-coder-pro-v2
bd663e9 feat: Maigret entegrasyonu — run_maigret aracı eklendi
e627cc2 fix: thinking model boş yanıt için 3 aşamalı retry
911e424 fix: 504 upstream timeout handler
e6f4d3d refactor: UI sıfırdan yazıldı — minimal ClaudeCode tarzı
48b965e feat: Ink (React for CLI) tabanlı yeni TUI
18c8126 feat: kurulum sihirbazi (osint --setup)
c8a3c14 feat: /resume komutu ile çoklu oturum geçmişi
dd6b196 feat: Obsidian vault entegrasyonu
4bf16fe feat: add check_plagiarism tool
3c25b6e fix: supervisor generate_report tool whitelist
317d6df fix: max_tokens 4096→32768 — JSON crash kök nedeni
7ec958a fix: JSON correction sonsuz döngü — global 6-deneme cap
4bc60db feat: mark_false_positive — GNN soft label
3c536ac feat: Twitter/X — Nitter → Scrapling stealth scraper
73868c2 feat: Brave → Google CSE → Tavily üç katmanlı arama
ddb ecd feat: add AcademicAgent sub-agent
```

---

## 11. Klasör Yapısı

```
osint-agent/
├── docker/
│   ├── searxng/
│   │   └── settings.yml          # SearXNG konfigürasyonu
│   └── firecrawl/
├── src/
│   ├── agents/
│   │   ├── baseAgent.ts          # ReAct loop + error handling
│   │   ├── supervisorAgent.ts    # Yönlendirme + koordinasyon
│   │   ├── identityAgent.ts      # Identity sub-agent
│   │   ├── mediaAgent.ts         # Media sub-agent
│   │   ├── academicAgent.ts      # Academic sub-agent
│   │   └── types.ts              # AgentConfig, Message, AgentResult
│   ├── tools/
│   │   ├── gpxAnalyzerTool.ts    # GPS analizi
│   │   ├── plagiarismTool.ts     # İntihal kontrolü
│   │   ├── maigretTool.ts        # 3000+ platform taraması
│   │   ├── obsidianTool.ts       # Obsidian entegrasyonu
│   │   ├── searchTool.ts         # 4 katmanlı arama
│   │   ├── scrapeTool.ts         # Scrapling → Puppeteer → Firecrawl
│   │   └── ... (30+ tool)
│   ├── lib/
│   │   ├── toolRegistry.ts       # Central tool dispatch
│   │   ├── neo4j.ts              # Graph database
│   │   ├── logger.ts             # Yapılandırılmış logging
│   │   └── sessionStore.ts       # Session persistence
│   ├── ui/                       # Ink TUI bileşenleri
│   │   ├── App.tsx
│   │   ├── MessageList.tsx
│   │   ├── PromptInput.tsx
│   │   └── ...
│   ├── cli.ts                    # Global CLI entry point
│   └── chat.ts                   # Legacy CLI
├── docs/
│   ├── WEEKLY_REPORT_2026_W13.md
│   ├── WEEKLY_REPORT_2026_W14-W15.md
│   └── evidence/
├── docker-compose.yml            # SearXNG + Firecrawl
├── start.sh                      # Graph UI starter
├── stop.sh                       # Graph UI stopper
└── package.json
```

---

## 12. Teknik Borç ve Bilinen Sınırlar

| Sorun | Durum | Öncelik |
|-------|-------|---------|
| Tool isolation (agent başına tool filtreleme) | Plan | Yüksek |
| Paralel tool execution | Plan | Yüksek |
| Session'lar arası dream memory | Plan | Orta |
| Context compaction | Plan | Orta |
| Twitter/X scraping güvenilirliği | Scrapling ile kısmen çözüldü | Düşük |
| GPX landmark identification | Nominatim zoom iyileştirilebilir | Düşük |

---

## 13. Performans Metrikleri

| Metrik | Önceki | Sonraki | İyileştirme |
|--------|--------|---------|-------------|
| Supervisor JSON crash | Sık | Hiç | %100 |
| Rate limit recovery | Manuel | Otomatik | ∞ |
| Tool call dedup | Yok | Var | Kalite ↑ |
| Sub-agent token limit | 12K | 30K | %150 |
| max_tokens | 4096 | 32768 | %800 |
| Test coverage | %70 | %85 | %15 |

---

## 14. Sonraki Adımlar

1. **Tool Isolation** — Her agent sadece ilgili tool'ları görsün
2. **Paralel Tool Execution** — Concurrent tool calls (hız 2-3x ↑)
3. **Dream Memory** — Session'lar arası kalıcı hafıza
4. **Context Compaction** — Uzun araştırmalarda otomatik özetleme
5. **MCP Server** — Python tool'larını standart arayüze sarma
6. **GNN Training** — `mark_false_positive` etiketleri ile model eğitimi
7. **Real-time Graph Updates** — Canlı graph değişiklikleri
8. **Multi-language Support** — Türkçe, İngilizce, Almanca...

---

## 15. Kullanım İstatistikleri

```
Toplam araştırma sorgusu: 847
Başarılı tarama: 791 (%93.4)
Graf yazma işlemi: 124
Oturum sayısı: 53
Ortalama oturum süresi: 8.5 dakika
```

---

## 16. Teşekkür

Bu 2 haftalık dönemde:
- 10+ model benchmark edildi
- 3 yeni sub-agent oluşturuldu
- 12 yeni tool eklendi
- 30+ stability fix yapıldı
- TUI sıfırdan yazıldı
- CLI global paket olarak dağıtıldı

OSINT Agent artık production-ready.

---

*Bu rapor OSINT Agent projesinin 24 Mart – 9 Nisan 2026 tarihleri arasında yapılan çalışmalarının özetidir.*

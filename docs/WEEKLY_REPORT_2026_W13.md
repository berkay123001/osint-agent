---
title: "OSINT Agent — Haftalık Geliştirme Raporu"
subtitle: "24 Mart – 2 Nisan 2026 | 67 Commit | 44 Dosya | +6,959 / -557 Satır"
date: 2026-04-02
author: "Berkay Hasret Baykara"
---

# OSINT Agent — Haftalık Geliştirme Raporu

**24 Mart – 2 Nisan 2026**

| Metrik | Değer |
|--------|-------|
| Toplam Commit | 67 |
| Değişen Dosya | 44 |
| Eklenen Satır | +6,959 |
| Silinen Satır | -557 |
| Test Sayısı | 31 (hepsi yeşil) |

---

## 1. Arama Altyapısı — Kendi Sunucumuzda Arama

### SearXNG Self-Hosted Metasearch Engine

**Sorun:** Dış arama API'lerine (Brave, Google CSE, Tavily) bağımlıydık. Rate limit, maliyet ve kota sorunları yaşıyorduk.

**Çözüm:** Docker üzerinde kendi SearXNG instance'ımızı kurduk. 100+ arama motorunu tek noktada toplayan bir metasearch engine.

```
Kullanıcı → Agent → SearXNG (localhost:8888) → Google, Bing, Brave, Qwant, Reddit...
                                    ↓ (hata olursa)
                              Brave → Google CSE → Tavily
```

| Özellik | Detay |
|---------|-------|
| URL | `http://localhost:8888` |
| Engine sayısı | 12 aktif (Google, Bing, Brave, Qwant, Wikipedia, Reddit, GitHub...) |
| Format | JSON API |
| Limit | Yok (self-hosted) |
| Yanıt süresi | ~1.5s |

**4 katmanlı fallback zinciri:** SearXNG → Brave → Google CSE → Tavily

### Brave Search Rate Limiter

Brave API'nin 2000 req/ay ücretsiz limitini korumak için global throttle eklendi (1.1 saniye aralık). Sosyal medya `site:` sorguları Brave'i bypass edip direkt Google CSE'ye gidiyor.

---

## 2. Scraping Altyapısı — Scrapling Primary Scraper

### Önceki Durum

```
Firecrawl Cloud (500 req/ay) → Puppeteer → Scrapling
```

### Yeni Zincir

```
Scrapling (--stealth) → Puppeteer Stealth → Firecrawl Cloud (son çare)
```

**Neden Scrapling primary?**

- Python tabanlı, Cloudflare Turnstile bypass yapabiliyor
- Anti-bot korumasını aşıyor (referer spoofing, browser fingerprint)
- Sınırsız kullanım (local Python process)
- Her URL'de otomatik stealth/dynamic mod seçimi

---

## 3. Multi-Agent Sistem — Akademik Araştırma Ajanı

### AcademicAgent (Yeni)

Akademik araştırma için özel sub-agent eklendi. Supervisor akademik sorguları otomatik olarak AcademicAgent'a yönlendiriyor.

**Yetenekleri:**
- arXiv + Semantic Scholar çift kaynaktan makale arama
- Derin okuma: ar5iv üzerinden tam makale içeriği çekme
- Yazar profili çıkarma (Semantic Scholar Author API)
- Neo4j grafa otomatik yazma: 125 makale, ~700 yazar bağlantısı tek sorguda
- Intihal/özgünlük analizi (`check_plagiarism` tool'u)

**Kalıcı bilgi tabanı:** Her araştırma sonucu `.osint-sessions/academic-knowledge.md` dosyasına kaydediliyor. Session'lar arası continuity sağlanıyor.

### Mevcut Ajanlar

| Agent | Model | Maks Tool Call | Uzmanlık |
|-------|-------|---------------|----------|
| Supervisor | qwen3.6-plus-preview | 30 | Yönlendirme, genel arama, rapor |
| IdentityAgent | qwen3.6-plus-preview | 30 | Username, email, GitHub, breach |
| MediaAgent | qwen3.6-plus-preview | 30 | Görsel analizi, fact-check, EXIF |
| AcademicAgent | qwen3.6-plus-preview | 30 | Makale, intihal, akademik profil |

---

## 4. Obsidian Vault Entegrasyonu

Agent'ın tüm çıktıları otomatik olarak Obsidian vault'una yazılıyor:

```
Agent Raporu → .osint-sessions/reports/
                  ↓ (otomatik sync)
              ~/Agent_Knowladges/OSINT/OSINT-Agent/
                  ├── 02 - Literatür Araştırması/
                  ├── 04 - Araştırma Raporları/
                  └── 08 - Profiller/
```

**Obsidian tool'ları:** `obsidian_write`, `obsidian_append`, `obsidian_read`, `obsidian_search`, `obsidian_write_profile`, `obsidian_daily_log`

---

## 5. Neo4j Graph Veritabanı

### Yeni Node Tipleri

- `Cybersecurity` — IOCs, tehdit aktörleri, malware
- `Claim`, `Fact`, `Source` — Fact-check düğümleri
- `Publication` — Akademik makale, `SIMILAR_TO` ilişkisi

### ML Label Sistemi

`mark_false_positive` tool'u ile GNN eğitimi için soft labeling:

```cypher
MATCH (n) WHERE n.mlLabel = 'false_positive' RETURN n  -- negatif örnek
MATCH (n) WHERE n.mlLabel = 'verified' RETURN n         -- pozitif örnek
```

### Graph Visualization UI

`npm run graph` ile interaktif graph browser (port 3333). NodeXL-benzeri force-directed layout, renkli node tipleri.

---

## 6. GPX Analyzer Tool (Yeni)

Fitness tracker / GPS verisi analizi için yeni tool:

**Özellikler:**
- GPX XML parsing (track point, elevation, timestamp)
- Coğrafi merkez hesaplama (haversine)
- Hotspot tespiti (tekrar eden konumlar, kümeleme)
- Reverse geocoding (OpenStreetMap Nominatim)
- Cross-track overlap analizi

**Test:** OSINT Challenges Challenge 10 başarıyla çözüldü — GPX dosyalarından Eyfel Kulesi konumu tespit edildi.

---

## 7. Model ve API Yönetimi

### Model Geçmişi

| Dönem | Model | Durum |
|-------|-------|-------|
| Başlangıç | qwen/qwen3.5-flash | Yetersiz kalite |
| Optimizasyon | qwen/qwen3.5-plus-02-15 | İyi ama ücretli |
| **Şu an** | **qwen/qwen3.6-plus-preview:free** | **Ücretsiz, daha iyi** |

### Hata Toleransı

| Senaryo | Davranış |
|---------|----------|
| 429 Rate Limit | 5s bekle → retry |
| 502 Bad Gateway | 3s bekle → retry |
| DataInspectionFailed (Alibaba PII filtresi) | Gemini'ye otomatik fallback |
| JSON parse hatası | Model kendini düzeltir (max 6 deneme) |
| Boş yanıt | 3 deneme → forceText modu |
| Tüm fallback'ler başarısız | Graceful degradation (crash yok) |

---

## 8. Yapılandırılmış Logging

`console.log` → `logger` geçişi tamamlandı. Renkli, seviyeli log sistemi:

```
[01:52:24] [INFO]  [AGENT] ⚙️  [Supervisor] Düşünüyor...
[01:52:42] [TOOL]  🔬 Akademik Araştırma: LLM quantization...
[01:52:45] [GRAPH] 💾 Grafa yazıldı: 25 makale
[01:52:42] [WARN]  [AGENT] Rate limit (429) — 5s bekleniyor...
[01:52:42] [ERROR] [AGENT] OpenRouter upstream hatası: ...
```

---

## 9. Test Altyapısı

31 regresyon testi, hepsi yeşil:

| Test Dosyası | Test Sayısı | Kapsam |
|-------------|-------------|--------|
| `baseAgent.test.ts` | 8 | 429 retry, DataInspectionFailed fallback, 502 retry |
| `chatHistory.test.ts` | 5 | Mesaj normalizasyonu, null content |
| `githubTool.test.ts` | 6 | Profil çekme, fork filtreleme, email çıkarma |
| `githubGpgUtils.test.ts` | 2 | Placeholder detection, real key |
| `osintHeuristics.test.ts` | 6 | Username detection, Turkish names |
| `sherlockTool.test.ts` | 5 | JSON parsing, text fallback, spawn error |

**Agent loop injectable mock client:** `runAgentLoop` fonksiyonu `_clientOverride` parametresi ile test edilebilir hale getirildi.

---

## 10. Klasör Yapısı

```
osint-agent/
├── docker/
│   └── searxng/settings.yml      ← SearXNG konfigürasyonu
├── src/
│   ├── agents/
│   │   ├── baseAgent.ts           ← ReAct loop + error handling
│   │   ├── supervisorAgent.ts     ← Yönlendirme + rapor
│   │   ├── academicAgent.ts       ← Akademik araştırma
│   │   └── types.ts               ← AgentConfig, Message, AgentResult
│   ├── tools/
│   │   ├── gpxAnalyzerTool.ts     ← GPS analizi (YENİ)
│   │   ├── searchTool.ts          ← 4 katmanlı arama
│   │   ├── scrapeTool.ts          ← Scrapling → Puppeteer → Firecrawl
│   │   ├── academicSearchTool.ts  ← arXiv + Semantic Scholar
│   │   ├── plagiarismTool.ts      ← İntihal/özgünlük
│   │   ├── obsidianTool.ts        ← Obsidian vault sync
│   │   └── ... (30+ tool)
│   ├── lib/
│   │   ├── toolRegistry.ts        ← Central tool dispatch
│   │   ├── neo4j.ts               ← Graph veritabanı
│   │   ├── logger.ts              ← Yapılandırılmış logging
│   │   └── osintHeuristics.ts     ← Username/identity tespiti
│   └── chat.ts                    ← CLI interface
├── docker-compose.yml             ← SearXNG
├── .osint-sessions/               ← Session persistence
└── package.json
```

---

## 11. Teknik Borç ve Bilinen Sınırlar

| Sorun | Durum |
|-------|-------|
| Tool isolation (agent başına tool filtreleme) | Plan |
| Paralel tool execution | Plan |
| Session'lar arası dream memory | Plan |
| Context compaction | Plan |
| Twitter/X scraping güvenilirliği | Nitter bloklu, Scrapling ile kısmen çözüldü |
| Alibaba PII filtresi | Gemini fallback ile çözüldü |
| GPX landmark identification | Nominatim zoom seviyesi iyileştirilebilir |

---

## 12. Sonraki Adımlar

1. **Tool Isolation** — Her agent sadece ilgili tool'ları görsün (kalite ↑)
2. **Paralel Tool Execution** — Concurrent tool calls (hız 2-3x ↑)
3. **Dream Memory** — Session'lar arası kalıcı hafıza (verimlilik ↑)
4. **Context Compaction** — Uzun araştırmalarda otomatik özetleme (stabilite ↑)
5. **MCP Server** — Python tool'larını standart arayüze sarma (modülerlik ↑)

---

*Bu rapor OSINT Agent projesinin 24 Mart – 2 Nisan 2026 haftasında yapılan çalışmaların özetidir.*

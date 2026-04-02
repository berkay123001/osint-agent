<div align="center">

# 🕵️ OSINT Agent

**Çok ajanlı, açık kaynak istihbarat sistemi**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org)
[![Neo4j](https://img.shields.io/badge/neo4j-5.x-008CC1)](https://neo4j.com)
[![OpenRouter](https://img.shields.io/badge/LLM-OpenRouter-purple)](https://openrouter.ai)

Kişi, kullanıcı adı, e-posta ve medya içeriklerini araştırmak; sosyal medya hesaplarını çapraz doğrulamak; sahte içerik ve akademik intihal tespit etmek için tasarlanmış multi-agent OSINT sistemi.

</div>

---

> **Yasal Uyarı:** Bu araç yalnızca etik OSINT araştırmaları, gazetecilik ve siber güvenlik çalışmaları içindir. Yalnızca kamusal kaynaklardan veri toplar. Kullanım sorumluluğu tamamen kullanıcıya aittir.

---

## Neler Yapabilir?

| Alan | Kapasite |
|------|----------|
| Kimlik Araştırması | 400+ platformda kullanıcı adı taraması (Sherlock), e-posta kayıt kontrolü (Holehe), GitHub derin analiz, veri sızıntısı kontrolü |
| Medya Doğrulama | Tersine görsel arama, EXIF/metadata analizi, perceptual hash karşılaştırması, Wayback Machine arşivi |
| Akademik Araştırma | arXiv, Semantic Scholar, ORCID entegrasyonu; intihal ve özgünlük tespiti |
| Graf Analizi | Neo4j tabanlı bağlantı haritası, D3.js canlı görselleştirme |
| İddia Doğrulama | Çok kaynaklı bağımsız doğrulama, Reddit topluluk analizi, kaynak güvenilirlik etiketleri |
| Obsidian Sync | Raporlar otomatik Obsidian vault'a kopyalanır + günlük not sistemi |

---

## Mimari

```
Kullanıcı → Supervisor (Qwen3.6-Plus)
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
  Identity   Media   Academic
   Agent     Agent    Agent
  (Plus)    (Plus)   (Plus)
       │        │        │
       └────────┼────────┘
                ▼
        Tool Registry (35+ araç)
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
     Neo4j   Search    Python
    (Graf)   Zinciri  (Sherlock
                       Holehe
                       Scrapling)
```

| Ajan | Model | Sorumluluk |
|------|-------|------------|
| **Supervisor** | Qwen3.6-Plus | Koordinasyon, sentez, graf sorguları, rapor |
| **Identity Agent** | Qwen3.6-Plus | Kullanıcı adı, e-posta, GitHub, veri sızıntısı |
| **Media Agent** | Qwen3.6-Plus | Görsel doğrulama, fact-check, EXIF analizi |
| **Academic Agent** | Qwen3.6-Plus | Makale taraması, araştırmacı profili, intihal |

---

## Kurulum

### Seçenek 1: Hızlı Kurulum (npm)

```bash
# Global kurulum
npm install -g osint-agent

# Kurulum sihirbazı (Docker, Neo4j, Python, .env)
osint --setup
```

### Seçenek 2: Geliştirici Kurulumu (kaynak koddan)

```bash
git clone https://github.com/kullanici/osint-agent.git
cd osint-agent
npm install
npm run build

# Kurulum sihirbazı
node dist/cli.js --setup

# veya doğrudan tsx ile
npx tsx src/cli.ts --setup
```

### Kurulum Sihirbazi Ne Yapar?

`osint --setup` 5 adımlı interaktif sihirbaz çalıştırır:

| Adım | Kontrol | Otomatik Eylem |
|------|---------|----------------|
| 1. Docker | Versiyon kontrolü | — |
| 2. SearXNG + Firecrawl | URL erişim testi | Çalışmıyorsa `docker compose up -d` |
| 3. Neo4j | Bağlantı testi | Başarısızsa Docker ile kurulum + şifre belirleme |
| 4. Python | Versiyon + paket kontrolü | Eksikse `pip install sherlock-project holehe scrapling` |
| 5. .env | Dosya varlık kontrolü | `.env.example`'den kopyalar veya interaktif oluşturur |

### Kaldırma

```bash
osint --uninstall
```

Kaldırma sihirbazı:
- Docker container'ları durdurur ve kaldırır (osint-searxng, osint-neo4j)
- `docker compose down` ile tüm servisleri kapatır
- `.osint-sessions/` oturum dosyalarını siler
- `.env` dosyasını onaylı siler (API key koruması)
- Kalan adımları gösterir: `npm uninstall -g osint-agent`

### Gereksinimler

| Bileşen | Zorunlu mu? | Notlar |
|---------|-------------|--------|
| Node.js >= 18 | ✅ Evet | `npm install -g` için |
| OpenRouter API key | ✅ Evet | LLM erişimi |
| Docker | Opsiyonel | SearXNG + Firecrawl + Neo4j (önerilir) |
| Python >= 3.10 | Opsiyonel | Sherlock, Holehe, Scrapling |
| Neo4j >= 5.x | Opsiyonel | Graf analizi (Docker ile otomatik) |

### Ortam Değişkenleri

```bash
cp .env.example .env
```

```env
# Zorunlu
OPENROUTER_API_KEY=sk-or-v1-...

# Docker servisleri (docker compose up -d)
SEARXNG_URL=http://localhost:8888
FIRECRAWL_URL=http://localhost:3002/v1/scrape

# Arama motorları (en az birini doldur)
BRAVE_SEARCH_API_KEY=BSA...
GOOGLE_SEARCH_API_KEY=AIza...
GOOGLE_SEARCH_CX=abc123...
TAVILY_API_KEY=tvly-...

# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=sifre123

# Python (Sherlock + Holehe + Scrapling)
PYTHON_PATH=/path/to/python

# İsteğe bağlı
GITHUB_TOKEN=ghp_...
HIBP_API_KEY=...
SERP_API_KEY=...
SEMANTIC_SCHOLAR_API_KEY=...
GRAPH_PORT=3333
FIRECRAWL_API_KEY=...
```

---

## Kullanım

### Interaktif REPL

```bash
osint                  # npm global
npm run chat           # geliştirici modu
```

```
        ╔════════════════════════╗
        ║   G . U . A . R . D   ║
        ╚════════════════════════╝

  Supervisor : qwen/qwen3.6-plus:free
  Alt ajan   : qwen/qwen3.6-plus:free

  Komutlar: /reset · /history · /resume · exit

  ❯ torvalds GitHub hesabını araştır
```

**REPL Komutları:**

| Komut | Açıklama |
|-------|----------|
| `/reset` | Oturumu sıfırla, mevcut oturumu arşivle |
| `/history` | Oturum istatistikleri (soru/yanıt sayısı) |
| `/resume` | Kayıtlı oturumları listele, seçip devam et |
| `exit` | Oturumu arşivleyip çık |

**Oturum Sistemi:**
- Her konuşma otomatik `.osint-sessions/` dizinine kaydedilir
- `exit` ve `/reset` mevcut oturumu tarih damgalı dosyaya arşivler
- `/resume` ile geçmiş oturumlardan birini seçip kaldığınız yerden devam edebilirsiniz

### Tek Soru Modu

```bash
osint "torvalds GitHub hesabını araştır"
```

### Graf Görselleştirme

```bash
osint --graph     # veya ./start.sh
# → http://localhost:3333
```

Node renkleri: Kırmızı (Person), Mavi (Username/Platform), Yeşil (Fact), Turuncu (Claim), Sarı (Source)

---

## Arama Zinciri

Dört katmanlı kademeli fallback:

```
SearXNG (self-hosted) → Brave Search → Google CSE → Tavily
  (100+ motor, limitsiz)   (2000/ay)    (100/gün)    (son çare)
```

- Sosyal medya `site:` sorguları Brave'i atlayıp direkt Google CSE'ye gider
- `search_web_multi`: 3 paralel sorgu, URL bazlı tekilleştirme, max 30 sonuç

---

## Kaynak Güvenilirlik Sistemi

Her arama sonucuna otomatik etiket eklenir:

| Etiket | Anlamı |
|--------|--------|
| `Resmi kurum sitesi (.gov/.edu)` | Devlet/üniversite kaynağı |
| `Referans kaynağı` | Wikipedia, archive.org |
| `Teknoloji basını` | TechCrunch, Wired, Ars Technica |
| `Topluluk tartışması` | Reddit (oy sayısıyla), HN, StackOverflow |
| `Ürünün kendi sayfası` | Vendor iddia + çıkar çatışması uyarısı |
| `Genel blog platformu` | Medium, dev.to — yazar uzmanlığı doğrulanmamış |

### İddia Doğrulama (`verify_claim`)

Çok kaynaklı kanıt birleştirme:

1. Birincil kaynağı scrape et
2. Reddit/HN gibi topluluk kaynaklarda araştır
3. Reddit JSON API ile tartışma detaylarını çek (post skoru, yorum skorları, fikir akımları)
4. Login wall tespiti — giriş duvarı olan sayfalar işaretlenir

**Önemli:** Bir sitede iddianın yazılmaması = iddianın yanlış olduğu anlamına gelmez. Sonuç `inconclusive` olarak döner.

---

## Obsidian Entegrasyonu

Raporlar otomatik olarak Obsidian vault'una sync edilir:

```
Agent_Knowladges/OSINT/OSINT-Agent/
├── 04 - Araştırma Raporları/    ← generate_report ile otomatik
├── 06 - Günlük/                 ← obsidian_daily
├── 07 - Notlar/                 ← Serbest notlar
└── 08 - Profiller/              ← Kişi profilleri ([[username]] wikilink)
```

Araçlar: `obsidian_write`, `obsidian_read`, `obsidian_search`, `obsidian_daily`, `obsidian_write_profile`

---

## Araç Referansı

<details>
<summary><strong>Kimlik Araçları</strong></summary>

| Araç | Açıklama |
|------|----------|
| `run_sherlock` | 400+ platformda kullanıcı adı taraması |
| `run_github_osint` | GitHub profil, GPG key, following analizi (deep mode) |
| `check_email_registrations` | Holehe ile e-posta platform kayıtları |
| `check_breaches` | HIBP ile veri sızıntısı kontrolü |
| `cross_reference` | E-posta/username pivot bağlantısı |
| `verify_profiles` | Bulunan profilleri canlı doğrulama |
| `search_person` | İsim + kurum ile kişi arama |
| `parse_gpg_key` | GitHub GPG keyinden gizli e-posta çıkarma |

</details>

<details>
<summary><strong>Medya Araçları</strong></summary>

| Araç | Açıklama |
|------|----------|
| `reverse_image_search` | Google Lens / SerpApi tersine görsel arama |
| `compare_images_phash` | Perceptual hash ile görsel benzerlik |
| `extract_metadata` | URL/dosya EXIF ve metadata çıkarımı |
| `wayback_search` | Wayback Machine arşiv araması |
| `nitter_profile` | Twitter/X profil bilgileri (Scrapling stealth) |
| `fact_check_to_graph` | İddia doğrulama sonucunu graf'a kaydet |

</details>

<details>
<summary><strong>Akademik Araçları</strong></summary>

| Araç | Açıklama |
|------|----------|
| `search_academic_papers` | arXiv + Semantic Scholar makale taraması |
| `search_researcher_papers` | Araştırmacı profili + yayın listesi |
| `check_plagiarism` | CrossRef/web üzerinden intihal tespiti |

</details>

<details>
<summary><strong>Arama & Doğrulama</strong></summary>

| Araç | Açıklama |
|------|----------|
| `search_web` | SearXNG → Brave → Google CSE → Tavily zinciri |
| `search_web_multi` | 3 paralel sorgu, URL dedup, max 30 sonuç |
| `verify_claim` | Çok kaynaklı iddia doğrulama + Reddit topluluk analizi |
| `scrape_profile` | Firecrawl → Puppeteer stealth → Scrapling zinciri |
| `web_fetch` | Sayfa içeriği çekme (akademik URL'ler 50K char limit) |

</details>

<details>
<summary><strong>Graf & Veritabanı</strong></summary>

| Araç | Açıklama |
|------|----------|
| `query_graph` | Neo4j bağlantı sorgusu |
| `list_graph_nodes` | Node listesi (label filtresiyle) |
| `graph_stats` | Toplam node/ilişki istatistiği |
| `save_finding` | Doğrulanmış bulguyu graf'a yaz |
| `save_ioc` | Siber tehdit göstergesi kaydet |
| `link_entities` | İki node arasında ilişki kur |
| `mark_false_positive` | ML etiketi ile işaretle (GNN eğitimi için) |
| `remove_false_positive` | Noise node kalıcı sil |
| `add_custom_node` | Özel node ekle (CryptoWallet, Malware vb.) |
| `add_custom_relationship` | Özel ilişki ekle (OWNS, DISTRIBUTES vb.) |

</details>

<details>
<summary><strong>Rapor & Obsidian</strong></summary>

| Araç | Açıklama |
|------|----------|
| `generate_report` | Markdown rapor oluştur + Obsidian sync |
| `obsidian_write` | Vault'a not yaz |
| `obsidian_append` | Mevcut notu genişlet |
| `obsidian_read` | Not oku |
| `obsidian_daily` | Günlük defter güncelle |
| `obsidian_write_profile` | Kişi profili oluştur ([[wikilink]]) |
| `obsidian_list` | Dizin içeriğini listele |
| `obsidian_search` | Tam metin arama |

</details>

---

## CLI Referansı

```bash
osint                       # İnteraktif REPL
osint "soru"                # Tek soru modu
osint --setup               # Kurulum sihirbazı
osint --uninstall           # Kaldırma sihirbazı
osint --graph               # Graf görselleştirme (port 3333)
osint --version             # Versiyon
osint --help                # Yardım
```

---

## Güvenlik

| Koruma | Detay |
|--------|-------|
| SSRF koruması | localhost, 192.168.x, 10.x, 172.16-31.x engelli |
| Neo4j inject | Tüm Cypher sorguları parametrize |
| Graf silme | `NEO4J_ALLOW_CLEAR=1` + `isSafeClearTarget()` (localhost only) |
| Holehe inject | E-posta regex doğrulama, subprocess'e ham input gitmez |
| API key koruma | .env gitignore'da, loglarda maskelenmiş |
| Login wall tespiti | Giriş/kayıt duvarı olan sayfalar işaretlenir |

---

## Testler

```bash
npm test                              # Unit testler (64 test)
npm run test:tools                    # Araç testleri
npm run test:graph:local              # Neo4j entegrasyon (Docker gerekli)
```

---

## Proje Yapısı

```
src/
├── agents/
│   ├── supervisorAgent.ts            # Koordinatör ajan
│   ├── identityAgent.ts              # Kimlik araştırması
│   ├── mediaAgent.ts                 # Görsel doğrulama
│   ├── academicAgent.ts              # Akademik araştırma
│   ├── baseAgent.ts                  # Ortak ajan döngüsü
│   └── types.ts                      # AgentConfig, Message, AgentResult
├── lib/
│   ├── toolRegistry.ts               # 35+ araç merkezi dispatcher
│   ├── neo4j.ts                      # Graf veritabanı işlemleri
│   ├── chatHistory.ts                # Oturum yönetimi
│   ├── sourceCredibility.ts          # Kaynak etiketleme + Reddit analizi
│   ├── pivotAnalyzer.ts              # Pivot önerileri
│   ├── osintHeuristics.ts            # Username/email doğrulama
│   └── logger.ts                     # Renkli log sistemi
├── tools/
│   ├── searchTool.ts                 # SearXNG → Brave → Google → Tavily
│   ├── scrapeTool.ts                 # Scrapling → Puppeteer → Firecrawl
│   ├── verifyClaimTool.ts            # Çok kaynaklı iddia doğrulama
│   ├── setupCommand.ts               # Kurulum + kaldırma sihirbazı
│   ├── githubTool.ts, sherlockTool.ts, holeheTool.ts, ...
│   └── obsidianTool.ts               # Obsidian vault entegrasyonu
├── cli.ts                            # Global CLI giriş noktası (osint komutu)
├── chat.ts                           # İnteraktif REPL (oturum sistemi)
└── graphServer.ts                    # Graf UI sunucusu
```

---

## npm Yayınlama

Paketi npm registry'ye yayınlamak için:

```bash
# 1. Gerekli dosyaları hazırla
npm run build

# 2. Paket içeriğini kontrol et
npm pack --dry-run

# 3. İlk yayınlama
npm publish --access public

# Güncelleme
npm version patch    # 1.0.0 → 1.0.1
npm publish
```

**Yayınlanan dosyalar** (`files` field in package.json):
- `dist/` — Derlenmiş JS
- `src/tools/scrapling_runner.py` — Python scrape runner
- `src/tools/holehe_runner.py` — Python holehe runner
- `.env.example` — Örnek çevre değişkenleri

**npm install -g osint-agent** sonrası kullanıcı sadece:
1. `osint --setup` çalıştırır
2. `.env`'e API key yazar
3. `osint` ile başlar

---

## Lisans

MIT — Detaylar için [LICENSE](LICENSE) dosyasına bakın.

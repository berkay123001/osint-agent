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
| Kimlik Arastirmasi | 400+ platformda kullanici adi taramasi (Sherlock), e-posta kayit kontrolu (Holehe), GitHub derin analiz, veri sizintisi kontrolu |
| Medya Dogrulama | Ters gorsel arama, EXIF/metadata analizi, perceptual hash karsilastirmasi, Wayback Machine arsivi |
| Akademik Arastirma | arXiv, Semantic Scholar, ORCID entegrasyonu; intihal ve ozgunluk tespiti |
| Graf Analizi | Neo4j tabanli baglanti haritasi, D3.js canli gorsellestirme |
| Iddia Dogrulama | Cok kaynakli bagimsiz dogrulama, Reddit topluluk analizi, kaynak guvenilirlik etiketleri |
| Obsidian Sync | Raporlar otomatik Obsidian vault'a kopyalanir + guncel not sistemi |

---

## Mimari

```
Kullanici → Supervisor (Qwen3.6-Plus)
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
  Identity   Media   Academic
   Agent     Agent    Agent
  (Flash)   (Flash)  (Plus)
       │        │        │
       └────────┼────────┘
                ▼
        Tool Registry (35+ arac)
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
| **Supervisor** | Qwen3.6-Plus | Koordinasyon, sentez, graf sorgulari, rapor |
| **Identity Agent** | Qwen3.5-Flash | Kullanici adi, e-posta, GitHub, veri sizintisi |
| **Media Agent** | Qwen3.5-Flash | Gorsel dogrulama, fact-check, EXIF analizi |
| **Academic Agent** | Qwen3.5-Plus | Makale taramasi, arastirmaci profili, intihal |

---

## Kurulum

### Hizli Kurulum (npm)

```bash
# Global kurulum
npm install -g osint-agent

# Ilk calistirmada kurulum sihirbazi
osint --setup
```

### Manuel Kurulum

#### 1. Repoyu klonla

```bash
git clone https://github.com/kullanici/osint-agent.git
cd osint-agent
npm install
```

#### 2. Docker servisleri (SearXNG + Firecrawl)

```bash
docker compose up -d
```

| Servis | Port | Aciklama |
|--------|------|----------|
| **SearXNG** | `localhost:8888` | Self-hosted metasearch, 100+ arama motoru, API key gerektirmez |
| **Firecrawl** | `localhost:3002` | Self-hosted web scraper, aylik limit yok |

SearXNG calismiyorsa sistem otomatik olarak Brave → Google CSE → Tavily zincirine duser.

#### 3. Python ortami (Sherlock + Holehe + Scrapling)

```bash
conda create -n scrapling python=3.11
conda activate scrapling
pip install sherlock-project holehe scrapling playwright
playwright install chromium
```

#### 4. Neo4j (Docker)

```bash
docker run -d \
  --name osint-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/sifre123 \
  neo4j:5
```

#### 5. Ortam degiskenleri

```bash
cp .env.example .env
# .env dosyasini API anahtarlarinizla doldurun
```

---

## Kullanim

### Interaktif REPL

```bash
# npm global
osint

# veya gelistirici modu
npm run chat
```

```
  ██████╗ ███████╗██╗███╗   ██╗████████╗
  ██╔═══██╗██╔════╝██║████╗  ██║╚══██╔══╝
  ...
  D I J I T A L   M U F E T T I S

  Supervisor : qwen/qwen3.6-plus-preview:free
  Alt ajan   : qwen/qwen3.5-flash

  ❯ torvalds GitHub hesabini arastir
```

REPL komutlari: `!reset` (oturum sifirla), `!history` (gecmis), `exit` (cikis + kaydet)

### Tek Soru Modu

```bash
osint "torvalds GitHub hesabini arastir"
```

### Graf Gorsellestirme

```bash
osint --graph     # veya ./start.sh
# → http://localhost:3333
```

Node renkleri: Kirmizi (Person), Mavi (Username/Platform), Yesil (Fact), Turuncu (Claim), Sari (Source)

### CLI Araci

```bash
npx tsx src/tools/agentCli.ts "soru"     # Tek soru
npx tsx src/tools/agentCli.ts --history   # Gecmis
npx tsx src/tools/agentCli.ts --reset     # Sifirla
```

---

## Arama Zinciri

Dort katmanli kademeli fallback:

```
SearXNG (self-hosted) → Brave Search → Google CSE → Tavily
  (100+ motor, limitsiz)   (2000/ay)    (100/gun)    (son care)
```

- Sosyal medya `site:` sorgulari Brave'i atlayip direkt Google CSE'ye gider
- `search_web_multi`: 3 paralel sorgu, URL bazli tekillestirme, max 30 sonuc

---

## Kaynak Guvenilirlik Sistemi

Her arama sonucuna otomatik etiket eklenir:

| Etiket | Anlami |
|--------|--------|
| `Resmi kurum sitesi (.gov/.edu)` | Devlet/universite kaynagi |
| `Referans kaynagi` | Wikipedia, archive.org |
| `Teknoloji basini` | TechCrunch, Wired, Ars Technica |
| `Topluluk tartismasi` | Reddit (oy sayisiyla), HN, StackOverflow |
| `Urunun kendi sayfasi` | Vendor iddia + cikar catismasi uyarisi |
| `Genel blog platformu` | Medium, dev.to — yazar uzmanligi dogrulanmamis |

### Iddia Dogrulama (`verify_claim`)

Cok kaynakli kanit birlestirme:

1. Birincil kaynagi scrape et
2. Reddit/HN gibi topluluk kaynaklarda arastir
3. Reddit JSON API ile tartisma detaylarini cek (post skoru, yorum skorlari, fikir akimlari)
4. Login wall tespiti — giris duvari olan sayfalar isaretlenir

**Onemli:** Bir sitede iddianin yazilmamasi = iddianin yanlis oldugu anlamina gelmez. Sonuc `inconclusive` olarak doner.

---

## Obsidian Entegrasyonu

Raporlar otomatik olarak Obsidian vault'una sync edilir:

```
Agent_Knowladges/OSINT/OSINT-Agent/
├── 04 - Arastirma Raporlari/    ← generate_report ile otomatik
├── 06 - Gunluk/                 ← obsidian_daily
├── 07 - Notlar/                 ← Serbest notlar
└── 08 - Profiller/              ← Kisi profilleri ([[username]] wikilink)
```

Araclar: `obsidian_write`, `obsidian_read`, `obsidian_search`, `obsidian_daily`, `obsidian_write_profile`

---

## Arac Referansi

<details>
<summary><strong>Kimlik Araclari</strong></summary>

| Arac | Aciklama |
|------|----------|
| `run_sherlock` | 400+ platformda kullanici adi taramasi |
| `run_github_osint` | GitHub profil, GPG key, following analizi (deep mode) |
| `check_email_registrations` | Holehe ile e-posta platform kayitlari |
| `check_breaches` | HIBP ile veri sizintisi kontrolu |
| `cross_reference` | E-posta/username pivot baglantisi |
| `verify_profiles` | Bulunan profilleri canli dogrulama |
| `search_person` | Isim + kurum ile kisi arama |
| `parse_gpg_key` | GitHub GPG keyinden gizli e-posta cikarma |

</details>

<details>
<summary><strong>Medya Araclari</strong></summary>

| Arac | Aciklama |
|------|----------|
| `reverse_image_search` | Google Lens / SerpApi ters gorsel arama |
| `compare_images_phash` | Perceptual hash ile gorsel benzerlik |
| `extract_metadata` | URL/dosya EXIF ve metadata cikarimi |
| `wayback_search` | Wayback Machine arsiv aramasi |
| `nitter_profile` | Twitter/X profil bilgileri (Scrapling stealth) |
| `fact_check_to_graph` | Iddia dogrulama sonucunu graf'a kaydet |

</details>

<details>
<summary><strong>Akademik Araclari</strong></summary>

| Arac | Aciklama |
|------|----------|
| `search_academic_papers` | arXiv + Semantic Scholar makale taramasi |
| `search_researcher_papers` | Arastirmaci profili + yayin listesi |
| `check_plagiarism` | CrossRef/web uzerinden intihal tespiti |

</details>

<details>
<summary><strong>Arama & Dogrulama</strong></summary>

| Arac | Aciklama |
|------|----------|
| `search_web` | SearXNG → Brave → Google CSE → Tavily zinciri |
| `search_web_multi` | 3 paralel sorgu, URL dedup, max 30 sonuc |
| `verify_claim` | Cok kaynakli iddia dogrulama + Reddit topluluk analizi |
| `scrape_profile` | Firecrawl → Puppeteer stealth → Scrapling zinciri |
| `web_fetch` | Sayfa icerigi cekme (akademik URL'ler 50K char limit) |

</details>

<details>
<summary><strong>Graf & Veritabani</strong></summary>

| Arac | Aciklama |
|------|----------|
| `query_graph` | Neo4j baglanti sorgusu |
| `list_graph_nodes` | Node listesi (label filtresiyle) |
| `graph_stats` | Toplam node/iliski istatistigi |
| `save_finding` | Dogrulanmis bulguyu graf'a yaz |
| `save_ioc` | Siber tehdit gostergesi kaydet |
| `link_entities` | Iki node arasinda iliski kur |
| `mark_false_positive` | ML etiketi ile isaretle (GNN egitimi icin) |
| `remove_false_positive` | Noise node kalici sil |
| `add_custom_node` | Ozel node ekle (CryptoWallet, Malware vb.) |
| `add_custom_relationship` | Ozel iliski ekle (OWNS, DISTRIBUTES vb.) |

</details>

<details>
<summary><strong>Rapor & Obsidian</strong></summary>

| Arac | Aciklama |
|------|----------|
| `generate_report` | Markdown rapor olustur + Obsidian sync |
| `obsidian_write` | Vault'a not yaz |
| `obsidian_append` | Mevcut notu genislet |
| `obsidian_read` | Not oku |
| `obsidian_daily` | Gunluk defteri guncelle |
| `obsidian_write_profile` | Kisi profili olustur ([[wikilink]]) |
| `obsidian_list` | Dizin icerigini listele |
| `obsidian_search` | Tam metin arama |

</details>

---

## Yapilandirma (.env)

```env
# Zorunlu
OPENROUTER_API_KEY=sk-or-v1-...

# Arama (en az birini doldur)
BRAVE_SEARCH_API_KEY=BSA...           # 2000 istek/ay ucretsiz
GOOGLE_SEARCH_API_KEY=AIza...         # 100 sorgu/gun
GOOGLE_SEARCH_CX=abc123...
TAVILY_API_KEY=tvly-...               # Son care

# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=sifre123

# Python
PYTHON_PATH=/path/to/anaconda3/envs/scrapling/bin/python

# Istege bagli
GITHUB_TOKEN=ghp_...                  # GitHub API kota artirimi
HIBP_API_KEY=...                      # Veri sizintisi kontrolu
SERP_API_KEY=...                      # Ters gorsel arama
SEMANTIC_SCHOLAR_API_KEY=...          # Akademik arastirma
GRAPH_PORT=3333                       # Graf UI portu
FIRECRAWL_URL=http://localhost:3002/v1/scrape
SEARXNG_URL=http://localhost:8888
FIRECRAWL_API_KEY=...                 # Cloud fallback (500 req/ay)
```

---

## Guvenlik

| Koruma | Detay |
|--------|-------|
| SSRF korumasi | localhost, 192.168.x, 10.x, 172.16-31.x engelli |
| Neo4j inject | Tum Cypher sorgulari parametrize |
| Graf silme | `NEO4J_ALLOW_CLEAR=1` + `isSafeClearTarget()` (localhost only) |
| Holehe inject | E-posta regex dogrulama, subprocess'e ham input gitmez |
| API key koruma | .env gitignore'da, loglarda maskelenmis |
| Login wall tespiti | Giris/kayit duvari olan sayfalar isaretlenir |

---

## Testler

```bash
npm test                              # Unit testler (33 test)
npm run test:tools                    # Arac testleri
npm run test:graph:local              # Neo4j entegrasyon (Docker gerekli)
```

---

## Proje Yapisi

```
src/
├── agents/
│   ├── supervisorAgent.ts            # Koordinator ajan
│   ├── identityAgent.ts              # Kimlik arastirmasi
│   ├── mediaAgent.ts                 # Gorsel dogrulama
│   ├── academicAgent.ts              # Akademik arastirma
│   ├── baseAgent.ts                  # Ortak ajan dongusu
│   └── types.ts                      # AgentConfig, Message, AgentResult
├── lib/
│   ├── toolRegistry.ts               # 35+ arac merkezi dispatcher
│   ├── neo4j.ts                      # Graf veritabani islemleri
│   ├── chatHistory.ts                # Oturum yonetimi
│   ├── sourceCredibility.ts          # Kaynak etiketleme + Reddit analizi
│   ├── pivotAnalyzer.ts              # Pivot onerileri
│   ├── osintHeuristics.ts            # Username/email dogrulama
│   └── logger.ts                     # Renkli log sistemi
├── tools/                            # 35+ arac implementasyonu
│   ├── searchTool.ts                 # SearXNG → Brave → Google → Tavily
│   ├── scrapeTool.ts                 # Scrapling → Puppeteer → Firecrawl
│   ├── verifyClaimTool.ts            # Cok kaynakli iddia dogrulama
│   ├── githubTool.ts, sherlockTool.ts, holeheTool.ts, ...
│   └── obsidianTool.ts               # Obsidian vault entegrasyonu
├── cli.ts                            # Global CLI giris noktasi (osint komutu)
├── chat.ts                           # Interaktif REPL
└── graphServer.ts                    # Graf UI sunucusu
```

---

## Gereksinimler

| Bilesen | Surum | Notlar |
|---------|-------|--------|
| Node.js | >= 18 | npm install -g icin |
| Python | >= 3.10 | Sherlock, Holehe, Scrapling |
| Neo4j | >= 5.x | Docker onerilir |
| Docker | herhangi | SearXNG + Firecrawl + Neo4j |
| OpenRouter API key | - | LLM erisimi (zorunlu) |

---

## Lisans

MIT — Detaylar icin [LICENSE](LICENSE) dosyasina bakin.

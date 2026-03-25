# 🕵️ OSINT Agent

Çok ajanlı (multi-agent) açık kaynak istihbarat (OSINT) sistemi. Kişi, kullanıcı adı, e-posta ve medya içeriklerini araştırmak; sosyal medya hesaplarını çapraz doğrulamak; sahte içerik ve dezenformasyon tespit etmek için tasarlanmıştır.

> **Yasal Uyarı:** Bu araç yalnızca etik OSINT araştırmaları, gazetecilik ve siber güvenlik çalışmaları için tasarlanmıştır. Yalnızca kamusal kaynaklardan veri toplar. Kullanım sorumluluğu tamamen kullanıcıya aittir.

---

## ✨ Özellikler

| Alan | Kapasiteler |
|------|-------------|
| **Kimlik Araştırması** | 400+ platformda kullanıcı adı taraması (Sherlock), e-posta kayıt kontrolü (Holehe), GitHub derin analiz, veri sızıntısı kontrolü |
| **Medya Doğrulama** | Ters görsel arama, EXIF/metadata analizi, perceptual hash karşılaştırması, Wayback Machine arşivi |
| **Akademik Araştırma** | arXiv, Semantic Scholar, ORCID, ResearchGate entegrasyonu; intihal tespiti |
| **Graf Analizi** | Neo4j tabanlı bağlantı haritası, D3.js görselleştirme (`http://localhost:3333`) |
| **Gerçek Zamanlı Chat** | Oturum yönetimi, sorgular arası hafıza, CLI ve interaktif mod |

---

## 🏗 Mimari

```
Kullanıcı ──→ Supervisor Agent (Qwen Plus)
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
     Identity   Media   Academic
      Agent     Agent    Agent
     (Flash)   (Flash)  (Plus)
          │        │        │
          └────────┼────────┘
                   ▼
           Tool Registry (30+ araç)
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
        Neo4j   Search   Python
       (Graf)   (Web)   (Sherlock
                         Holehe)
```

### Ajanlar

- **Supervisor** — Soruyu analiz eder, doğru ajana yönlendirir; aynı zamanda graf sorguları ve rapor üretir
- **Identity Agent** — Kullanıcı adı, e-posta, GitHub, veri sızıntısı araştırması
- **Media Agent** — Görsel doğrulama, fact-check, EXIF analizi
- **Academic Agent** — Akademik makale ve araştırmacı profili analizi

---

## 📋 Gereksinimler

| Bileşen | Sürüm | Notlar |
|---------|-------|--------|
| Node.js | ≥ 22 | nvm ile yönetilebilir |
| Python | ≥ 3.10 | Sherlock ve Holehe için |
| Neo4j | ≥ 5.x | Docker önerilir |
| Docker | herhangi | Neo4j container için |

---

## 🚀 Kurulum

### 1. Repoyu klonla

```bash
git clone https://github.com/kullanici/osint-agent.git
cd osint-agent
```

### 2. Node bağımlılıklarını yükle

```bash
npm install
```

### 3. Python ortamını kur (Conda önerilir)

```bash
conda create -n scrapling python=3.11
conda activate scrapling

pip install sherlock-project holehe scrapling playwright
playwright install chromium
```

### 4. Neo4j başlat (Docker)

```bash
docker run -d \
  --name osint-neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/sifre123 \
  neo4j:5
```

### 5. Ortam değişkenlerini ayarla

```bash
cp .env.example .env
# .env dosyasını editoründe aç ve API anahtarlarını doldur
```

### 6. Başlat

```bash
# Chat modu (terminal)
npm run chat

# Graf UI (http://localhost:3333)
./start.sh
```

---

## ⚙️ Yapılandırma (`.env`)

```env
# ─── Zorunlu ───────────────────────────────────────
OPENROUTER_API_KEY=sk-or-v1-...       # https://openrouter.ai

# ─── Arama Motorları (en az biri zorunlu) ──────────
BRAVE_SEARCH_API_KEY=BSA...           # https://brave.com/search/api (2000 istek/ay ücretsiz)
TAVILY_API_KEY=tvly-...               # https://tavily.com (fallback)

# ─── Neo4j Veritabanı ───────────────────────────────
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=sifre123

# ─── Python (Sherlock + Holehe + Scrapling) ─────────
PYTHON_PATH=/home/kullanici/anaconda3/envs/scrapling/bin/python

# ─── İsteğe Bağlı ───────────────────────────────────
GITHUB_TOKEN=ghp_...                  # GitHub API kota artırımı
HIBP_API_KEY=...                      # Have I Been Pwned (veri sızıntısı)
SERP_API_KEY=...                      # Ters görsel arama (SerpApi)
SEMANTIC_SCHOLAR_API_KEY=...          # Akademik araştırma kota artırımı
GRAPH_PORT=3333                       # Graf UI portu (varsayılan: 3333)
```

---

## 💡 Kullanım

### Interaktif Chat

```bash
npm run chat
```

```
🕵️ OSINT Agent
Soru: @vitalik_buterin Twitter hesabını araştır
```

Ajanlar otomatik olarak:
1. Kullanıcı adını 400+ platformda tarar
2. GitHub hesabını bağlar
3. Veri sızıntılarını kontrol eder
4. Neo4j'ye bağlantı grafiği yazar
5. Markdown rapor üretir

### Agentla Doğrudan Konuşma (CLI)

```bash
npx tsx src/tools/agentCli.ts "sorunuz"
npx tsx src/tools/agentCli.ts --history   # Oturum geçmişi
npx tsx src/tools/agentCli.ts --reset     # Oturumu sıfırla
```

### Graf Görselleştirme

```bash
./start.sh      # Başlat → http://localhost:3333
./stop.sh       # Durdur
```

Graf UI'da:
- Node'a tıkla → detay paneli açılır
- `Bağlantısız Gizle` → Sherlock'un bulamadığı platformları gizler
- Sağ panel → komşu node'ları listeler
- Ctrl+K → node arama

### Rapor Üretimi

```
Soru: Bu araştırma için rapor oluştur
```

Raporlar `.osint-sessions/reports/` klasörüne Markdown olarak kaydedilir.

---

## 🛠 Araç Referansı

<details>
<summary><strong>Kimlik Araçları</strong></summary>

| Araç | Açıklama |
|------|----------|
| `run_sherlock` | 400+ sosyal medya platformunda kullanıcı adı taraması |
| `run_github_osint` | GitHub profil, repo, GPG key, following analizi |
| `check_email_registrations` | Holehe ile e-posta platform kayıtları |
| `check_breaches` | HIBP ile veri sızıntısı kontrolü |
| `cross_reference` | E-posta/username pivot bağlantısı |
| `verify_profiles` | Bulunan profilleri canlı doğrulama |

</details>

<details>
<summary><strong>Medya Araçları</strong></summary>

| Araç | Açıklama |
|------|----------|
| `reverse_image_search` | Google Lens / SerpApi ters görsel arama |
| `compare_images_phash` | Perceptual hash ile görsel benzerlik (%0-100) |
| `extract_metadata` | URL/dosya EXIF ve metadata çıkarımı |
| `wayback_search` | Wayback Machine arşiv araması |
| `fact_check_to_graph` | İddiayı doğrula ve sonucu graf'a kaydet |

</details>

<details>
<summary><strong>Akademik Araçlar</strong></summary>

| Araç | Açıklama |
|------|----------|
| `search_academic_papers` | arXiv API makale taraması |
| `search_researcher_papers` | Semantic Scholar araştırmacı profili |
| `check_plagiarism` | CrossRef/web üzerinden intihal tespiti |

</details>

<details>
<summary><strong>Graf Araçları</strong></summary>

| Araç | Açıklama |
|------|----------|
| `query_graph` | Neo4j'de bağlantı sorgusu |
| `list_graph_nodes` | Kayıtlı node'ları listele |
| `add_custom_node` | Özel node ekle |
| `add_custom_relationship` | İki node arasında ilişki kur |
| `remove_false_positive` | Yanlış pozitif node'u temizle |
| `unexplored_pivots` | Araştırılmamış bağlantı önerileri |
| `generate_report` | OSINT/akademik/factcheck raporu oluştur |

</details>

---

## 🔒 Güvenlik Notları

### Uygulanan Korumalar

- **SSRF koruması** — `localhost`, özel IP aralıkları (192.168.x, 10.x, 172.16-31.x) engellenmiş
- **Neo4j inject koruması** — Tüm sorgular parametrize edilmiş, label sanitizasyonu uygulanmış
- **Graf silme koruması** — `NEO4J_ALLOW_CLEAR=1` ve `isSafeClearTarget()` (yalnızca localhost) gerektirir
- **API key koruması** — `.env` dosyası `.gitignore`'da, loglarda maskeleniyor

### Bilinen Kısıtlamalar

- **HIBP rate limit** — Ücretsiz plan: 1 istek/6 saniye; aşıldığında "biraz bekle" mesajı
- **Twitter/X** — Nitter instance'ları büyük çoğunlukla engelli; Scrapling stealth fallback kullanılıyor
- **Brave Search** — Ücretsiz planda 2.000/ay istek; otomatik throttle (1.1s/istek) uygulanmış

---

## 🧪 Testler

```bash
npm run test              # Unit testler
npm run test:tools        # Araç testleri
npm run test:graph:local  # Neo4j entegrasyon testleri (Docker gerekli)
```

---

## 📁 Proje Yapısı

```
src/
├── agents/
│   ├── supervisorAgent.ts    # Ana yönlendirici ajan
│   ├── identityAgent.ts      # Kimlik araştırması
│   ├── mediaAgent.ts         # Görsel/medya doğrulama
│   └── academicAgent.ts      # Akademik araştırma
├── lib/
│   ├── neo4j.ts              # Graf veritabanı işlemleri
│   ├── chatHistory.ts        # Oturum yönetimi
│   ├── toolRegistry.ts       # Araç executor (merkezi dispatcher)
│   ├── pivotAnalyzer.ts      # Araştırma pivot önerileri
│   └── osintHeuristics.ts    # Username/email doğrulama kuralları
├── tools/                    # 30+ araç implementasyonu
│   ├── searchTool.ts         # Brave + Tavily web arama
│   ├── githubTool.ts         # GitHub OSINT
│   ├── sherlockTool.ts       # Sherlock wrapper
│   ├── holeheTool.ts         # Holehe wrapper
│   ├── reverseImageTool.ts   # Görsel arama
│   └── ...
├── public/
│   └── index.html            # Graf UI (D3.js)
├── chat.ts                   # Interaktif chat girişi
└── graphServer.ts            # Graf UI web sunucusu
```

---

## 🤝 Katkıda Bulunma

1. Fork'la, özellik dalı aç (`git checkout -b feat/yeni-araç`)
2. Test yaz, geç
3. PR gönder

---

## 📄 Lisans

MIT — Detaylar için [LICENSE](LICENSE) dosyasına bakın.

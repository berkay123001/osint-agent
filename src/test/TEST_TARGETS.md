# Test Hedefleri Kullanım Kılavuzu

Bu dosya, OSINT Agent'ı **gerçekte** test etmek için kullanabileceğin hedefleri içerir.

## 🚀 Hemen Başla

### En Basit Test
```bash
cd osint-agent
npm run chat
```

Sonra agent'a yaz:
```
octocat hakkında bilgi topla
```

**Beklenen:**
- Sherlock: GitHub, Twitter, vs bulur
- GitHub API: Email, profil bilgileri
- Graph'a yazılır
- Rapor üretilir

---

## 🎯 Güvenli Test Hedefleri

### 1. `octocat` (Kolay)
GitHub'ın resmi test hesabı. **Her zaman çalışır.**

```
Sen: octocat için araştırma yap
Agent: 
  🔍 Sherlock: GitHub, Twitter, Reddit...
  🐙 GitHub API: octocat@github.com
  📊 Graph: 5+ node oluşur
```

**Doğrulama:**
- [ ] GitHub profili bulundu
- [ ] Email graph'a yazıldı
- [ ] 3+ platform tespit edildi

### 2. `torvalds` (Orta)
Linus Torvalds - Çok veri var.

```
Sen: torvalds kimdir?
Agent:
  🔍 Çok fazla platform
  🐙 GitHub: torvalds@linux-foundation.org
  📧 Eski commit emailleri
```

**Doğrulama:**
- [ ] 10+ platform bulundu
- [ ] Linux Foundation email'i çıkarıldı
- [ ] Commit emailleri bulundu

### 3. `defunkt` (Orta-Zor)
GitHub kurucularından - Aktif değil ama bilgiler var.

```
Sen: defunkt hakkında bilgi bul
```

---

## 🎮 Test Senaryoları

### Senaryo 1: Basit Username Araştırması
**Amaç:** Temel akışı test et

```
1. Agent başlat: npm run chat
2. Kullanıcı: "octocat araştır"
3. Beklenen akış:
   - Sherlock çalışır (30-60 sn)
   - GitHub API çalışır (5-10 sn)
   - LLM analiz eder
   - Graph'a yazar
   - Rapor sunar

4. Doğrulama:
   ✅ "octocat" node'u oluştu
   ✅ "octocat@github.com" email node'u var
   ✅ 3+ platform ilişkisi var
```

### Senaryo 2: Cross-Reference Testi
**Amaç:** Aynı email'in farklı platformlarda bulunması

```
1. Kullanıcı: "torvalds araştır"
2. Beklenen:
   - GitHub: torvalds@linux-foundation.org
   - Eski commitler: torvalds@osdl.org
   - İki email de graph'a yazılmalı

3. Doğrulama:
   ✅ Her iki email de node olarak var
   ✅ "torvalds" username her ikisine de bağlı
```

### Senaryo 3: Boş Sonuç
**Amaç:** Agent boş sonuçla nasıl baş ediyor

```
1. Kullanıcı: "this_user_definitely_not_exists_xyz araştır"
2. Beklenen:
   - Sherlock: Boş sonuç
   - GitHub: "not found" hatası
   - Agent: "Sonuç bulunamadı" mesajı

3. Doğrulama:
   ✅ Graph büyümemiş (eski node'lar duruyor)
   ✅ Hata mesajı anlaşılır
```

---

## 🧪 Manuel Test Scripti

```bash
# Terminal 1: Neo4j Browser'ı aç (grafı gör)
open http://localhost:7474

# Terminal 2: Agent'ı başlat
cd osint-agent
npm run chat

# Sırayla test et:
1. "octocat araştır"
2. "torvalds kimdir"  
3. "defunkt hakkında bilgi"
4. "nonexistent_xyz_123 araştır"  # Boş sonuç testi

# Her adımda Neo4j Browser'da kontrol et:
MATCH (n) RETURN n LIMIT 50
```

---

## 📊 Beklenen Graph Yapıları

### Basit Kullanıcı (octocat)
```
(:Username {value: "octocat"})
  ↓ USES_EMAIL
(:Email {value: "octocat@github.com"})
  
(:Username {value: "octocat"})
  ↓ HAS_PROFILE
(:Profile {value: "https://github.com/octocat"})
  ↓ ON_PLATFORM
(:Platform {value: "GitHub"})
```

### Karmaşık Kullanıcı (torvalds)
```
(:Username {value: "torvalds"})
  ├──→ USES_EMAIL → (:Email {value: "torvalds@linux-foundation.org"})
  ├──→ USES_EMAIL → (:Email {value: "torvalds@osdl.org"})
  ├──→ REAL_NAME → (:Person {value: "Linus Torvalds"})
  ├──→ HAS_PROFILE → (:Profile) → ON_PLATFORM → (:Platform {value: "GitHub"})
  ├──→ HAS_PROFILE → (:Profile) → ON_PLATFORM → (:Platform {value: "Twitter"})
  └──→ WORKS_AT → (:Organization {value: "Linux Foundation"})
```

---

## ⚠️ Önemli Notlar

### Rate Limit
GitHub API saatte 60 istek (anonim). Çok test yaparken:
- Bekleme süresi verin
- Veya GitHub token kullanın

### Sherlock Süresi
Sherlock 400+ platform tarar, **1-2 dk** sürebilir.

### Neo4j Temizlik
Testlerden önce graph'ı temizlemek için:
```cypher
// Neo4j Browser'da çalıştır
MATCH (n) DETACH DELETE n
```

---

## 🔧 Debug İpuçları

### Agent cevap vermiyor?
```bash
# Genkit dev server'ı kontrol et
npm run dev

# Başka terminalde chat'i çalıştır
npm run chat
```

### Sherlock çok yavaş?
```bash
# Direkt test et
cd ../osint_collection/sherlock
python -m sherlock_project octocat --print-found
```

### Graph'a yazılmıyor?
```bash
# Neo4j bağlantısını kontrol et
curl http://localhost:7474
```

---

## ✅ Test Checklist

Her yeni feature'dan önce bu checklist'i kullan:

- [ ] `octocat` başarıyla araştırılıyor
- [ ] Boş sonuçta hata vermiyor
- [ ] Graph'a node'lar yazılıyor
- [ ] Graph'dan node'lar okunabiliyor
- [ ] Cross-reference'ler bulunuyor
- [ ] Raporlar anlaşılır
- [ ] Rate limit aşılmıyor

---

## 📝 Örnek Test Oturumu

```
$ npm run chat

🤖 Agent: Merhaba! OSINT Agent'a hoş geldiniz.
Ne araştırmak istersiniz?

Sen: octocat hakkında bilgi topla

🤖 Agent: octocat için araştırma başlatıyorum...

🌐 Sherlock: 14 platform bulundu
  - GitHub: https://github.com/octocat
  - Twitter: https://twitter.com/octocat
  - Reddit: https://reddit.com/user/octocat
  ...

🐙 GitHub API: Profil bilgileri alındı
  - Email: octocat@github.com
  - Repos: 8
  - GPG Key: Var

💾 Graph'a yazıldı: 12 node, 11 ilişki

📊 ÖZET:
👤 The Octocat
📧 octocat@github.com
🌐 Aktif Platformlar: GitHub, Twitter, Reddit...
🔗 GPG Key mevcut

Başka ne araştırmak istersin?

Sen: torvalds kimdir
...
```

Bu şekilde test edebilirsin! 🎯

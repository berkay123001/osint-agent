# OSINT Agent — Copilot Çalışma Kuralları

## Ajanla Konuşma (agentCli)

Kullanıcı "ajanla konuş", "agentla test et", "agentCli kullan" veya benzeri bir şey söylediğinde
şu adımları uygula:

### 1. Önce mevcut oturumu kontrol et
```bash
npx tsx src/tools/agentCli.ts --history
```
Bu komut:
- Kaç tur yapıldığını
- Son soruyu
- Son aktiflik tarihini gösterir.

### 2. Mesaj gönder
```bash
npx tsx src/tools/agentCli.ts "kullanıcının sorusu veya test senaryosu"
```
Çıktıda `[AGENT_RESPONSE]` bloğunu oku ve kullanıcıya aktar.

### 3. Oturumu sıfırla (gerekirse)
```bash
npx tsx src/tools/agentCli.ts --reset
```

### 4. Son yanıtı tekrar oku
```bash
npx tsx src/tools/agentCli.ts --last
```

**Oturum dosyası:** `.osint-sessions/cli-session.json` — her yanıttan sonra otomatik kaydedilir.

---

## Multi-Agent Mimarisi

| Ajan | Model | Sorumluluk |
|------|-------|------------|
| Supervisor | `qwen/qwen3.5-plus-02-15` | Routing, kullanıcı iletişimi, graf sorguları |
| IdentityAgent | `qwen/qwen3.5-flash-02-23` | Kişi/username/email/GitHub araştırması |
| MediaAgent | `qwen/qwen3.5-flash-02-23` | Görsel doğrulama, metadata, fact-check |

---

## Chat'i Başlatma
```bash
npx tsx src/chat.ts
```
- Önceki oturum varsa "Devam et?" sorar
- `!reset` → sıfırla
- `!history` → istatistik
- `exit` → kaydet ve çık

---

## Bilinen Sınırlamalar
- Twitter/X: Nitter instance'ları çoğunlukla başarısız, `web_fetch` fallback kullanılır
- noreply GitHub emaili: Holehe taraması yapmaya gerek yok, atla
- Flash model: Uzun tool chain sonrası zaman zaman boş yanıt dönebilir (retry mekanizması var)

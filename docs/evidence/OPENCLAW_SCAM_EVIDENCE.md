# OpenClaw InfoStealer & Cryptocurrency Scam Incident

**Tarih:** 18 Mart 2026
**Araştırmacı:** Dijital Müfettiş (OSINT Graph Agent)
**Vaka Özeti:** "OpenClaw" adında popülerleşen sahte bir yapay zeka aracılığı üzerinden sahte GitHub repoları ve sosyal medya hesapları kurularak kurbanların bilgisayarlarına Vidar (infostealer) ve GhostSocks proxy zararlı yazılımlarının bulaştırılması, API key'lerinin ve Cryptowallet private key'lerinin çalınması. En büyük teyitli vaka: Nik Pash ($450,000 kripto para kaybı).

## 1. Tespit Edilen Sahte GitHub Hesapları ve Repolar
Bu şebeke sahte yükleyiciler (installers) ile zararlı yazılım dağıtmaktadır. Arama motoru yapay zekaları (Bing AI vb.) bu repoları organik sanarak öne çıkarmıştır.

*   **Kullanıcı:** `wgodbarrelv4`
    *   **Repo:** `openclaw-installer` (İçinde 7-Zip ile gizlenmiş Vidar barındıran `OpenClaw_x64.exe` loader'ı bulunur).
    *   **Bağlantılı Twitter:** `@godbarrel`
*   **Kullanıcı:** `pblockbDerp4`
    *   **Repo:** `ComfyUI-easy` (Malware dağıtım)
    *   **Bağlantılı Email:** `ssljrrausv886@hotmail.com`
*   **Kullanıcı:** `JSfOMGi2` (Şu anda silindi/askıya alındı)
    *   **Repo:** `simple-claw`
    *   **Bağlantılı Email:** `jessicajacksonfusg@hotmail.com`

## 2. Dolandırıcıların Kullandığı Cüzdan Adresleri (Sahte)
BoardGameGeek profilinde (`OpenClawSupport`) "Airdrop" veya ağ desteği vadiyle bağış yapılması/bağlanılması istenen cüzdanlar paylaşılmıştır. Web3 analizi sonucunda adreslerin tamamının uydurma (Invalid check-sum) olduğu, asıl amacın "Connect Wallet" (Cüzdan Bağla) butonuna tıklatıp drainer smart-contract üzerinden private key çalmak olduğu tespit edilmiştir.

*   `35LS846mCZ6KL6LozRv5OnfweEU` (Sahte BTC)
*   `3rn3gwXevsBH1PS8P38UD8FaYn4` (Sahte LTC)
*   `1PtcmSicVRrmEIJlh5wjkQziX6M` (Sahte BTC)
*   `3uvs8uvJRE9bEt86CuYOt6uHQjs` (Sahte LTC)
*   `3fKRfAZ0VxiWXcx0gHXyBUrWL8I` (Sahte LTC)

## 3. Threat Intelligence & Kurban Raporları
Reddit, Substack ve X/Twitter üzerindeki "Mağdur Analizi" (Victim Report) dorking çalışmaları:

1.  **Nik Pash ($450,000 Kayıp):** Agent cüzdana kendi erişip parayı çaldı. Olay, tüm open-source agent scamleri arasında en büyük bilinen kayıptır.
2.  **API Kredisi Hırsızlıkları:** En az iki kurban kendi Anthropic/OpenAI anahtarlarının kompromize olduğunu, toplamda ~$8,000'ı aşan faturalar çıkarıldığını raporlamıştır.
3.  **Etki Alanı:** ~/.openclaw yapılandırma klasörü hedeflenerek auth token'lar ve system device key'leri sızdırılmaktadır. En az 30,000 instances'ın maruz kaldığı varsayılmaktadır.

## 4. X (Twitter) Derin Profil Analizi: @godbarrel
*   **Handle:** `@godbarrel` (wgodbarrelv4 adlı GitHub hesabının kökü ile birebir uyumlu)
*   **Oluşturulma:** Temmuz 2013 (Tahminen hacklenmiş veya pasifken satın alınmış eski bir hesap).
*   **Aktivite:** Sadece 2 takipçi, 7 takip edilen. 
*   **Gizlilik:** Hesabın içindeki 40 tweet dışarıya tamamen kilitli ("Only approved followers"). 
*   **Bio:** "FF14, Black Desert" gibi MMORPG oyunları. 
*   **Analiz:** Bu bir aldatmaca/maskeleme (camouflage) profilidir. Scam zincirinin bir parçası olarak GitHub repolarını ve fake installer linklerini onaylanmış kapalı takipçi botları vasıtasıyla manipüle etmek için kullanılmaktadır.

## 5. Önerilen Aksiyonlar
*   **Abuse Reports:** GitHub repoları (wgodbarrelv4 ve pblockbDerp4), BoardGameGeek (OpenClawSupport profili) ve X (@godbarrel hesabı) abuse timlerine bildirilecektir.
*   **IOCs (Indicators of Compromise):** `ssljrrausv886@hotmail.com`, `jessicajacksonfusg@hotmail.com` ve `OpenClaw_x64.exe` dosyaları kurumsal firewall ve endpoint güvenlik ürünlerinde kara listeye eklenecektir.

---
*Bu rapor, OSINT Graph Agent tarafından toplanan açık kaynak istihbaratı ile The Huntress ve bağımsız mağdur blogları baz alınarak oluşturulmuştur.*

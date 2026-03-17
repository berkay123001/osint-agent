# GitHub OSINT Geliştirme Notları (18 Mart 2026)

Şu anki ajanımız Sakura Room CTO/OSINT testlerinde "kopya çekerek" (Write-up scriptlerini bulup) cevapları doğru getirsede, asıl yapması gereken saf OSINT yöntemini geliştirmemiz gerekiyor. 

### Eklenmesi Gereken Özellik (Commit History Scanner)
Ajanın `githubTool.ts` modülüne şu yetenek eklenecek:
1. Sadece "email" ayıklamak için son commit'in .patch dosyasına bakmakla KALMAMALI.
2. Belirli bir repository'in TÜM commit geçmişini (`commits` API endpoint) listeleyip tek tek o commitlerin içine (`.patch` veya files changes) bakabilecek yeni bir tool/opsiyon üretilmeli.
3. Bu sayede "Silinmiş verileri (Deleted lines) bulma" (kripto cüzdan adresi, unutulmuş parolalar) işlemi otomatize edilmiş olacak.

Bu, ajanı gerçek bir "Adlî Bilişim (Forensic) aracı" yapacaktır.

### Eklenmesi Gereken Özellik (Chat Session State / Geçmiş Yönetimi)
1. Terminalde agent ile konuşurken ajan, o anki oturumda (session) öğrendiği "hedefe ait kripto cüzdanı", "özel detaylar" gibi şeyleri o anlık LLM bağlamında tutup yorumluyor. Ancak `neo4j.ts` içindeki `writeOsintToGraph` fonksiyonumuz şu an kripto para birimleri veya madencilik havuzları gibi **özel (custom) node tiplerini** kaydetmeye programlı değil. (Sadece Username, Email, Person, Profile kaydedebiliyor.) 
2. Bu yüzden oturum kapanıp açıldığında ve graf sorgulandığında ("Graf node listesi çekiliyor"), ajan haklı olarak `0xa102...` cüzdan adresini grafta bulamıyor (çünkü hiç yazılmadı).
3. Çözüm: Ajanın sohbet geçmişini (Session History) diskte bir JSON vb. formatta tutması (Resume Chat Mode). Ya da Neo4j tarafına `Cryptocurrency` ve `Wallet` gibi yeni tip esnek Node etiketlerinin (Label) eklenmesine olanak sağlanması gerekiyor.

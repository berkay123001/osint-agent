"""
Bulk translate remaining Turkish strings to English in all source files.
Preserves: regex character class patterns, stop-words arrays, Turkish name data.
"""
import re
import os

# Files to process and their targeted replacements
FILE_REPLACEMENTS = {}

# ─── agentCli.ts ────────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/agentCli.ts'] = [
    (' * agentCli.ts — Copilot\'un ajanla konuşmasını sağlayan CLI aracı', ' * agentCli.ts — CLI tool enabling Copilot to chat with the OSINT agent'),
    (' * Kullanım:', ' * Usage:'),
    (' *   npx tsx src/tools/agentCli.ts "mesaj buraya"       ← tek mesaj gönder', ' *   npx tsx src/tools/agentCli.ts "your message"          ← send a single message'),
    (' *   npx tsx src/tools/agentCli.ts --reset              ← oturumu sıfırla', ' *   npx tsx src/tools/agentCli.ts --reset                 ← reset session'),
    (' *   npx tsx src/tools/agentCli.ts --history            ← geçmişi göster', ' *   npx tsx src/tools/agentCli.ts --history               ← show history'),
    (' *   npx tsx src/tools/agentCli.ts --last               ← son yanıtı göster', ' *   npx tsx src/tools/agentCli.ts --last                  ← show last response'),
    (' * Oturum .osint-sessions/cli-session.json dosyasında saklanır.', ' * Session is persisted in .osint-sessions/cli-session.json'),
    (' * Copilot bu aracı run_in_terminal ile çağırarak çok turlu konuşma sürdürür.', ' * Copilot calls this tool via run_in_terminal to maintain multi-turn conversations.'),
    ('// ── Oturum yönetimi ──────────────────────────────────────────────────────────', '// ── Session management ──────────────────────────────────────────────────────────'),
    ('// ── Çıktı formatlayıcı (renksiz — terminale ham metin) ───────────────────────', '// ── Output formatter (no colour — raw text for terminal) ───────────────────────'),
    ('  // ANSI escape kodlarını temizle — Copilot\'un okuması için', '  // Strip ANSI escape codes — for Copilot readability'),
    ('// ── Ana mantık ───────────────────────────────────────────────────────────────', '// ── Main logic ───────────────────────────────────────────────────────────────'),
    ("console.log('[CLI] Oturum sıfırlandı.');", "console.log('[CLI] Session reset.');"),
    ('  console.log(`  Tur sayısı  : ${session.turns}`);', '  console.log(`  Turns       : ${session.turns}`);'),
    ('  console.log(`  Soru sayısı : ${userMsgs.length}`);', '  console.log(`  Questions   : ${userMsgs.length}`);'),
    ('  console.log(`  Yanıt sayısı: ${agentMsgs.length}`);', '  console.log(`  Responses   : ${agentMsgs.length}`);'),
    ("  console.log(`  Başlangıç   : ${new Date(session.createdAt).toLocaleString('tr-TR')}`);", "  console.log(`  Started     : ${new Date(session.createdAt).toLocaleString('en-US')}`);"),
    ("typeof lastQ.content === 'string' ? lastQ.content.slice(0, 100) : '[karmaşık]'", "typeof lastQ.content === 'string' ? lastQ.content.slice(0, 100) : '[complex]'"),
    ('  // --last (son yanıtı göster)', '  // --last (show last response)'),
    ("      console.log('[CLI] Henüz yanıt yok.');", "      console.log('[CLI] No response yet.');"),
    ('  // Normal mesaj gönderimi', '  // Normal message send'),
    ("    console.error('[CLI] Hata: Mesaj boş. Kullanım: npx tsx src/tools/agentCli.ts \"sorunuz\"');", "    console.error('[CLI] Error: Message is empty. Usage: npx tsx src/tools/agentCli.ts \"your question\"');"),
    ('  // Session güncelle & ajanı çalıştır', '  // Update session & run agent'),
    ('  // runSupervisor çıktıyı console\'a yazar; ama biz yanıtı da yakalamak istiyoruz.', '  // runSupervisor writes output to console; but we also want to capture the response.'),
    ('  // Bunun için history\'yi doğrudan izliyoruz.', '  // We do this by directly watching the history array.'),
    ('  // runSupervisor history\'ye assistant mesajı push eder', '  // runSupervisor pushes the assistant message to history'),
    ("  // Copilot'un parse edebileceği format", '  // Format that Copilot can parse'),
]

# ─── chatHistory.test.ts ─────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/lib/chatHistory.test.ts'] = [
    ("assert.equal(normalized.content, 'Araçlar çalıştı ancak model boş yanıt döndürdü.')", "assert.equal(normalized.content, 'Tools completed but the model returned an empty response.')"),
    ("assert.equal(normalizeToolContent('   '), 'Tool sonuç üretemedi.')", "assert.equal(normalizeToolContent('   '), 'Tool produced no output.')"),
]

# ─── investigateFlow.ts ──────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/flows/investigateFlow.ts'] = [
    ('      // 3. LLM ile PII çıkar', '      // 3. Extract PII with LLM'),
    ('✅ Araştırma tamamlandı.', '✅ Research complete.'),
    ('bağlantı.', 'connections.'),
    ('lead,', 'leads,'),
]

# ─── setupCommand.ts ─────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/setupCommand.ts'] = [
    ('    // Neo4j sifresini güncelle (eger yeni kurulduysa)', '    // Update Neo4j password (if freshly installed)'),
    ('    // Neo4j sifresini güncelle', '    // Update Neo4j password'),
]

# ─── imageHasher.ts ──────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/imageHasher.ts'] = [
    ('    // 2 tabanıyla 64 karakterli binary (perceptual) hash döndürür', '    // Returns a 64-character binary (perceptual) hash in base 2'),
    (' * İki perceptual hash (64-bit string) arasındaki Hamming mesafesini hesaplar.', ' * Computes the Hamming distance between two perceptual hashes (64-bit strings).'),
    (' * @returns 0 ile 64 arası bir sayı. 0 tam eşleşme, < 10 büyük olasılıkla aynı resim.', ' * @returns A number from 0 to 64. 0 = exact match, < 10 = very likely the same image.'),
]

# ─── neo4jFactCheck.ts ───────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/lib/neo4jFactCheck.ts'] = [
    ('      // 1. İddia Düğümü (Claim)', '      // 1. Claim Node'),
    ('      // 2. Kaynak Düğümü (Source - Haber Sitesi, Twitter vs.)', '      // 2. Source Node (news site, Twitter, etc.)'),
    ('      // 3. Karar/Doğrulama Düğümü (Verdict/Fact)', '      // 3. Verdict/Fact Node'),
    ('      // 4. Görseller', '      // 4. Images'),
]

# ─── obsidianTool.ts ─────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/obsidianTool.ts'] = [
    ("const DAILY_DIR = path.join(VAULT_ROOT, '06 - Günlük')", "const DAILY_DIR = path.join(VAULT_ROOT, '06 - Daily')"),
    ("  const relPath = path.join('06 - Günlük', fileName)", "  const relPath = path.join('06 - Daily', fileName)"),
    # The .replace(/[Ğğ]/g lines are char normalization — keep them
]

# ─── progressEmitter.ts ──────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/lib/progressEmitter.ts'] = [
    (' * Global ilerleme olayı yayıcısı.', ' * Global progress event emitter.'),
    (' * Tüm araç/ajan log mesajları bu emitter üzerinden iletilir.', ' * All tool/agent log messages are routed through this emitter.'),
    (' * chatInk.tsx bu emitter\'ı dinleyerek mesajları UI\'da gösterir.', ' * chatInk.tsx listens to this emitter and displays messages in the UI.'),
    (' * stderr\'e hiçbir şey yazılmaz — Ink stdout yönetimi bozulmaz.', ' * Nothing is written to stderr — Ink stdout management is preserved.'),
    (" * 'progress' — kısa özet (TUI + web)", " * 'progress' — short summary (TUI + web)"),
    (" * 'detail'   — tam araç çıktısı (sadece web log paneli dinler)", " * 'detail'   — full tool output (only the web log panel listens)"),
    (' * Tam araç çıktısını web log paneline gönderir — TUI görmez.', ' * Sends the full tool output to the web log panel — the TUI does not see it.'),
    (' * toolName: araç adı, output: ham çıktı (kırpılmamış)', ' * toolName: tool name, output: raw output (untruncated)'),
]

# ─── osintHeuristics.ts ──────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/lib/osintHeuristics.ts'] = [
    ('/** Yaygın Türk isimlerini tespit et — doğrulama gerektiren adaylar */', '/** Detect common Turkish names — candidates that require verification */'),
    ('/** Bir ismin yaygın/jenerik olup olmadığını kontrol et */', '/** Check whether a name is too common/generic */'),
    ('/** Çapraz doğrulama skoru — iki bilgi seti ne kadar örtüşüyor? */', '/** Cross-validation score — how much do two information sets overlap? */'),
    ('  // İsim tek başına yeterli değil — sadece bonus puan', '  // Name alone is not sufficient — bonus point only'),
    # The name arrays themselves are data — keep them
]

# ─── holeheTool.ts ────────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/holeheTool.ts'] = [
    (' * Email adresinin hangi platformlarda kayıtlı olduğunu kontrol eder (Holehe).', ' * Checks which platforms an email address is registered on (Holehe).'),
    (' * Pivot noktası olarak kullanılır: Email → Platform bağlantısı kurar.', ' * Used as a pivot point: Email → Platform connection.'),
    ('  // Güvenlik: geçersiz email subprocess\'e geçmesin', '  // Security: prevent invalid email from reaching the subprocess'),
    ("    return { email, services: [], totalChecked: 0, error: `Geçersiz e-posta formatı: ${email}` }", "    return { email, services: [], totalChecked: 0, error: `Invalid email format: ${email}` }"),
    ("      return { email, services: [], totalChecked: 0, error: stderr?.trim() || 'Holehe boş çıktı döndürdü' }", "      return { email, services: [], totalChecked: 0, error: stderr?.trim() || 'Holehe returned empty output' }"),
    ('    return { email, services: [], totalChecked: 0, error: `Holehe hatası: ${msg}` }', '    return { email, services: [], totalChecked: 0, error: `Holehe error: ${msg}` }'),
    ('/** Holehe sonuçlarını okunabilir formatta döndür */', '/** Return Holehe results in a human-readable format */'),
    ("    return `Email kayıt kontrolü hatası: ${result.error}`", "    return `Email registration check error: ${result.error}`"),
    ('    ? ` | Rate limit: ${result.rateLimitedCount} (atlandı)`', '    ? ` | Rate limit: ${result.rateLimitedCount} (skipped)`'),
    ('    `📧 Email Kayıt Kontrolü: ${result.email}`,', '    `📧 Email Registration Check: ${result.email}`,'),
    ('    `Taranan platform: ${result.totalChecked} | Kayıtlı bulunan: ${result.services.length}${rlInfo}`,', '    `Platforms scanned: ${result.totalChecked} | Registered on: ${result.services.length}${rlInfo}`,'),
    ("    lines.push('Bu email herhangi bir platformda kayıtlı bulunamadı.')", "    lines.push('This email was not found registered on any platform.')"),
]

# ─── maigretTool.ts ───────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/maigretTool.ts'] = [
    (' * Username için Maigret ile 3000+ platformda hesap araması yapar.', ' * Searches 3000+ platforms for an account with the given username using Maigret.'),
    (" * Sherlock'un tamamlayıcısı — farklı kontrol metodları kullanır,", " * Complements Sherlock — uses different check methods,"),
    (' * Pinterest/Discord/Facebook/Instagram gibi platformları kapsar.', ' * covering platforms like Pinterest, Discord, Facebook, and Instagram.'),
    (' * @param username  Aranacak kullanıcı adı', ' * @param username  Username to search for'),
    (' * @param topSites  Kaç siteyi tara (varsayılan: 500, max: ~3000)', ' * @param topSites  How many sites to scan (default: 500, max: ~3000)'),
    (' * @param timeout   Her istek için timeout (saniye, varsayılan: 20)', ' * @param timeout   Timeout per request in seconds (default: 20)'),
    ('  // Güvenlik: username formatı doğrulama', '  // Security: validate username format'),
    ("    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Geçersiz username formatı: ${username}` }", "    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Invalid username format: ${username}` }"),
    ("      return { username, found: [], foundCount: 0, checkedCount: 0, error: stderr?.trim() || 'Maigret boş çıktı döndürdü' }", "      return { username, found: [], foundCount: 0, checkedCount: 0, error: stderr?.trim() || 'Maigret returned empty output' }"),
    ('    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Maigret hatası: ${msg}` }', '    return { username, found: [], foundCount: 0, checkedCount: 0, error: `Maigret error: ${msg}` }'),
    ('/** Maigret sonuçlarını okunabilir formatta döndür */', '/** Return Maigret results in a human-readable format */'),
    ("    return `Maigret hatası: ${result.error}`", "    return `Maigret error: ${result.error}`"),
    ("    lines.push('Bu username hiçbir platformda bulunamadı.')", "    lines.push('This username was not found on any platform.')"),
]

# ─── reverseImageTool.ts ──────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/reverseImageTool.ts'] = [
    (' * Tersine Görsel Arama Aracı (Reverse Image Search)', ' * Reverse Image Search Tool'),
    (' * SerpAPI (Google Lens Motoru) kullanarak görselin internette ilk nerede ve ne zaman çıktığını bulur.', ' * Uses SerpAPI (Google Lens) to find where and when an image first appeared online.'),
    (' * Dezenformasyon, fact-checking ve OSINT görsel takibi için kullanılır.', ' * Used for disinformation detection, fact-checking, and OSINT image tracking.'),
    ('      error: "SERPAPI_API_KEY bulunamadı. Lütfen .env dosyasına ekleyin.",', '      error: "SERPAPI_API_KEY not found. Please add it to .env.",'),
    ('        error: `SerpApi Hatası: ${data.error}`,', '        error: `SerpApi error: ${data.error}`,'),
    ('    // Gelen sonuçlardan sadece en tutarlı ilk 5 sonucu (fact-checking için yeterli) al', '    // Take only the top 5 most consistent results (sufficient for fact-checking)'),
    ('      title: match.title || "Adsız Başlık",', '      title: match.title || "Untitled",'),
    ('      error: `İstek başarısız oldu: ${(error as Error).message}`,', '      error: `Request failed: ${(error as Error).message}`,'),
    ('    return `❌ Tersine Görsel Arama Hatası: ${result.error}`;', '    return `❌ Reverse Image Search Error: ${result.error}`;'),
    ('    return `ℹ️ Google Lens bu görsel için internette geçmiş bir iz bulamadı. Orijinal/Özgün bir fotoğraf olabilir.`;', '    return `ℹ️ Google Lens found no prior trace of this image online. It may be an original/unique photo.`;'),
    ('    `🔍 Görsel Analiz (Google Lens) Tamamlandı!`,', '    `🔍 Visual Analysis (Google Lens) Complete!`,'),
    ('    `📸 Aranan Görsel: ${result.imageUrl}`,', '    `📸 Searched Image: ${result.imageUrl}`,'),
    ('    `🧩 Toplam Eşleşen Kaynak Sayısı: ${result.totalMatches}`,', '    `🧩 Total Matching Sources: ${result.totalMatches}`,'),
    ('    lines.push(`\\n[${index + 1}] Başlık: ${match.title}`);', '    lines.push(`\\n[${index + 1}] Title: ${match.title}`);'),
    ("    lines.push(`    Bağlantı: ${match.link}`);", "    lines.push(`    Link: ${match.link}`);"),
]

# ─── maigret_runner.py ────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/maigret_runner.py'] = [
    ('Maigret JSON runner — TypeScript wrapper tarafından çağrılır.', 'Maigret JSON runner — called by the TypeScript wrapper.'),
    ('Username için 3000+ platformda hesap arama.', 'Account search across 3000+ platforms for a given username.'),
    ('Çıktı: JSON (stdout)', 'Output: JSON (stdout)'),
    ('        print(json.dumps({"error": f"maigret yüklü değil: {e}"}))', '        print(json.dumps({"error": f"maigret not installed: {e}"}))'),
    ('        print(json.dumps({"error": f"maigret data.json bulunamadı: {db_path}"}))', '        print(json.dumps({"error": f"maigret data.json not found: {db_path}"}))'),
    ('    # En popüler N siteyi al (ranked_sites_dict zaten sıralı)', '    # Take the top N most popular sites (ranked_sites_dict is already sorted)'),
    ('        max_connections=10,    # rate-limit azaltmak için düşük tut', '        max_connections=10,    # keep low to reduce rate-limit hits'),
    ('        print(json.dumps({"error": "Kullanım: maigret_runner.py <username> [top_sites] [timeout]"}))', '        print(json.dumps({"error": "Usage: maigret_runner.py <username> [top_sites] [timeout]"}))'),
    ('    # Güvenlik: username sadece alfanumerik + - _ . izin ver', '    # Security: allow only alphanumeric + - _ . in username'),
    ('        print(json.dumps({"error": f"Geçersiz username formatı: {username}"}))', '        print(json.dumps({"error": f"Invalid username format: {username}"}))'),
]

# ─── waybackTool.ts ───────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/waybackTool.ts'] = [
    (' * Wayback Machine Tool — archive.org üzerinden silinmiş/eski sayfa snapshot\'larını çeker.', ' * Wayback Machine Tool — fetches deleted/old page snapshots via archive.org.'),
    (" * OSINT'te silinmiş profiller, eski tweet'ler, değiştirilmiş bio'lar için kullanılır.", " * Used in OSINT for deleted profiles, old tweets, and modified bios."),
    (' * Wayback Machine CDX API ile bir URL\'nin tüm arşiv snapshot\'larını listeler.', " * Lists all archive snapshots of a URL using the Wayback Machine CDX API."),
    ("      result.error = `Wayback CDX API hatası: HTTP ${res.status}`", "      result.error = `Wayback CDX API error: HTTP ${res.status}`"),
    ('    // İlk satır header, atla', '    // First row is a header, skip it'),
    ("    // En son snapshot'ın içeriğini çek", "    // Fetch the content of the most recent snapshot"),
    ("    result.error = `Wayback hatası: ${(e as Error).message}`", "    result.error = `Wayback error: ${(e as Error).message}`"),
    (' * Belirli bir tarihteki en yakın snapshot\'ı çeker.', " * Fetches the closest snapshot to a specific date."),
    (' * Wayback Availability API kullanır.', ' * Uses the Wayback Availability API.'),
    (' * Wayback sonucunu okunabilir metin formatına çevirir.', ' * Converts a Wayback result to a human-readable text format.'),
    ("    lines.push('⚠️  Bu URL için arşivlenmiş snapshot bulunamadı.')", "    lines.push('⚠️  No archived snapshot found for this URL.')"),
    ("    lines.push(`\\n📄 En son snapshot içeriği (özet):`)", "    lines.push(`\\n📄 Most recent snapshot content (preview):`)"),
    ('    // İlk 2000 karakter', '    // First 2000 characters'),
]

# ─── githubTool.ts ────────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/githubTool.ts'] = [
    (' * GitHub OSINT Tool — GitHub resmi API\'si üzerinden çalışır.', ' * GitHub OSINT Tool — uses the official GitHub API.'),
    (" * Commit e-postalarını .patch endpoint'inden (GitHub'ın sunduğu) çeker.", ' * Fetches commit emails from the .patch endpoint (provided by GitHub).'),
    ("const FOLLOWING_FOLLOWER_THRESHOLD = 500 // Bu sayının altındakiler gerçek kişi sayılır", "const FOLLOWING_FOLLOWER_THRESHOLD = 500 // Counts below this are treated as real people"),
    ('const DEEP_SLEEP_MS = 300 // API çağrıları arası gecikme', 'const DEEP_SLEEP_MS = 300 // Delay between API calls'),
    ('  skipped: boolean // follower sayısı eşiği aştı için atlandı', '  skipped: boolean // skipped because follower count exceeded threshold'),
    ("    // GitHub'ın resmi .patch endpoint'i — herkes erişebilir, scraping değil", "    // GitHub's official .patch endpoint — publicly accessible, not scraping"),
    ('  // 2. Repolardan email çıkar (max 5 repo, paralel)', '  // 2. Extract emails from repos (max 5 repos, parallel)'),
    ('  // 3. GPG/SSH anahtarları', '  // 3. GPG/SSH keys'),
    ('  // 4. DEEP MOD: following listesi — yalnızca kullanıcı istediğinde', '  // 4. DEEP MODE: following list — only when requested'),
    ('    // Çok fazla following var, liste çıkarma pratik değil', '    // Too many followings — listing is not practical'),
    ("    result.rawSummary += `\\n[Deep mod: ${profile.following} following var, limit aşıldı (>200), atlandı]`", "    result.rawSummary += `\\n[Deep mode: ${profile.following} followings, limit exceeded (>200), skipped]`"),
    ('  // 5. Ham özet metin (LLM için)', '  // 5. Raw summary text (for LLM)'),
    ('    lines.push(`✅ Araştırılacak (< ${FOLLOWING_FOLLOWER_THRESHOLD} follower): ${realPeople.length} kişi`)', '    lines.push(`✅ To research (< ${FOLLOWING_FOLLOWER_THRESHOLD} followers): ${realPeople.length} person(s)`)'),
    ('    lines.push(`⏭️  Atlanan (>= ${FOLLOWING_FOLLOWER_THRESHOLD} follower): ${skipped.length} kişi`)', '    lines.push(`⏭️  Skipped (>= ${FOLLOWING_FOLLOWER_THRESHOLD} followers): ${skipped.length} person(s)`)'),
]

# ─── gpgParserTool.ts ─────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/gpgParserTool.ts'] = [
    (' * GPG Key Parser Tool — GPG public key\'den email, isim ve metadata çıkarır.', ' * GPG Key Parser Tool — extracts email, name, and metadata from a GPG public key.'),
    (" * OSINT'te commit email gizlenmiş kullanıcıların gerçek email'ini bulmak için kullanılır.", " * Used in OSINT to find the real email of users with hidden commit emails."),
    (' * GPG key dosyasından email ve isim çıkarır.', ' * Extracts email and name from a GPG key file.'),
    ('    // Method 1: gpg --list-packets (en detaylı)', '    // Method 1: gpg --list-packets (most detailed)'),
    ('    // User ID satırlarından email çıkar', '    // Extract email from User ID lines'),
    ("      // Email çıkar (köşeli parantez içinde veya doğrudan)", '      // Extract email (inside angle brackets or directly)'),
    ("      // İsim çıkar (email'den önceki kısım)", "      // Extract name (portion before the email)"),
    ('    // Key ID çıkar', '    // Extract Key ID'),
    ('        // Geçici keyring kullan', '        // Use temporary keyring'),
    ("      result.error = 'GitHub kullanıcısı için GPG key bulunamadı'", "      result.error = 'No GPG key found for this GitHub user'"),
    ("    result.error = `GPG parse hatası: ${(e as Error).message}`", "    result.error = `GPG parse error: ${(e as Error).message}`"),
    (" * https://github.com/{username}.gpg endpoint'ini kullanır.", ' * Uses the https://github.com/{username}.gpg endpoint.'),
    ('  // GPG key dosyasının boş olmadığını kontrol et', '  // Verify that the GPG key file is non-empty'),
    ("      error: `${username} için GPG key bulunamadı`,", "      error: `No GPG key found for ${username}`,"),
    (' * GPG parse sonucunu okunabilir metin formatına çevirir.', ' * Converts a GPG parse result to a human-readable text format.'),
    ("    lines.push('\\n⚠️  GPG key\\'de email veya isim bulunamadı.')", "    lines.push('\\n⚠️  No email or name found in the GPG key.')"),
]

# ─── gpxAnalyzerTool.ts ───────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/gpxAnalyzerTool.ts'] = [
    ("        errors.push(`${resolved}: GPX dosyasında track bulunamadı`)", "        errors.push(`${resolved}: No tracks found in GPX file`)"),
    ("  lines.push('📍 GPX ANALİZİ SONUÇLARI')", "  lines.push('📍 GPX ANALYSIS RESULTS')"),
    ("  lines.push(`\\n🎯 COĞRAFİ MERKEZ: ${result.geographicCenter.lat}, ${result.geographicCenter.lon}`)", "  lines.push(`\\n🎯 GEOGRAPHIC CENTER: ${result.geographicCenter.lat}, ${result.geographicCenter.lon}`)"),
    ("    lines.push(`🏙️ Şehir: ${result.centerGeocode.city ?? 'Bilinmiyor'}`)", "    lines.push(`🏙️ City: ${result.centerGeocode.city ?? 'Unknown'}`)"),
    ("    lines.push(`🌍 Ülke: ${result.centerGeocode.country ?? 'Bilinmiyor'} (${result.centerGeocode.countryCode ?? '?'})`)", "    lines.push(`🌍 Country: ${result.centerGeocode.country ?? 'Unknown'} (${result.centerGeocode.countryCode ?? '?'})`)"),
    ("      lines.push(`  Ziyaret sayısı: ${hs.visitCount} nokta (%${hs.percentageOfTracks} oranında)`)", "      lines.push(`  Visit count: ${hs.visitCount} points (${hs.percentageOfTracks}% of tracks)`)"),
    ("        if (hs.geocode.city) lines.push(`  🏙️ Şehir: ${hs.geocode.city}`)", "        if (hs.geocode.city) lines.push(`  🏙️ City: ${hs.geocode.city}`)"),
    ("  lines.push(`\\n🔗 DOSYALAR ARASI ÖRTÜŞME:`)", "  lines.push(`\\n🔗 CROSS-FILE OVERLAP:`)"),
    ("      lines.push(`  • ${file.metadata.name ?? file.filename}: ${nearCenter.length}/${allPts.length} nokta merkez yakınında (<100m)`)", "      lines.push(`  • ${file.metadata.name ?? file.filename}: ${nearCenter.length}/${allPts.length} points near centre (<100m)`)"),
]

# ─── metadataTool.ts ──────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/metadataTool.ts'] = [
    (' * Dosya veya URL\'den EXIF/XMP/IPTC metadata çıkarır.', ' * Extracts EXIF/XMP/IPTC metadata from a file or URL.'),
    (" * OSINT'te fotoğraf analizi, dosya kökeni tespiti, username çıkarma için kullanılır.", ' * Used in OSINT for photo analysis, file origin detection, and username extraction.'),
    ('// OSINT açısından önemli metadata alanları', '// Metadata fields relevant for OSINT'),
    (' * Dosya yolundan metadata çıkarır (exiftool).', ' * Extracts metadata from a file path (exiftool).'),
    ('      // Tüm alanları string olarak kaydet', '      // Store all fields as strings'),
    ('      // İlginç alanları filtrele', '      // Filter for interesting fields'),
    ("        const cleanKey = key.replace(/^[^:]+:/, '') // Group prefix'i kaldır", "        const cleanKey = key.replace(/^[^:]+:/, '') // Remove group prefix"),
    ("    result.error = `Metadata çıkarma hatası: ${(e as Error).message}`", "    result.error = `Metadata extraction error: ${(e as Error).message}`"),
    (' * URL\'den dosya indirip metadata çıkarır.', ' * Downloads a file from a URL and extracts its metadata.'),
    (' * Metadata sonucunu okunabilir metin formatına çevirir.', ' * Converts a metadata result to a human-readable text format.'),
    ("    lines.push('\\n🔍 OSINT açısından önemli alanlar:')", "    lines.push('\\n🔍 Fields relevant for OSINT:')"),
    ("  lines.push(`\\n📋 Tüm metadata (${Object.keys(result.fields).length} alan):`)", "  lines.push(`\\n📋 All metadata (${Object.keys(result.fields).length} field(s)):`)"),
]

# ─── nitterTool.ts ────────────────────────────────────────────────────────────
FILE_REPLACEMENTS['src/tools/nitterTool.ts'] = [
    (" * Twitter/X profilini Scrapling stealth browser ile çek.", ' * Fetches a Twitter/X profile using Scrapling stealth browser.'),
    (' * og:description, og:title, og:image meta taglerine öncelik verir.', ' * Prioritises og:description, og:title, og:image meta tags.'),
    ('    // Scrapling yoksa / hata → Puppeteer fallback aşağıda', '    // If Scrapling is unavailable / errors → Puppeteer fallback below'),
    ('  // 2. Scrapling başarılı mı kontrol et', '  // 2. Check whether Scrapling succeeded'),
    ('  // 3. dynamic mod fallback (JS ağır sayfalar için)', '  // 3. dynamic mode fallback (for JS-heavy pages)'),
    ('  // 4. Tüm yöntemler başarısız', '  // 4. All methods failed'),
    ("    `Twitter/X profili çekilemedi. Scrapling conda ortamı aktif değil veya ` +", "    `Failed to fetch Twitter/X profile. Scrapling conda environment is inactive or ` +"),
    ("    `@${cleanUsername} profili gizli/silinmiş olabilir. ` +", "    `@${cleanUsername} profile may be private/deleted. ` +"),
    ('  // title genellikle "Display Name (@username) / X" formatında gelir', '  // title is typically in "Display Name (@username) / X" format'),
    ('  // Bio — og:description genellikle profil biyografisini içerir', '  // Bio — og:description usually contains the profile biography'),
    ('  // Follower/following sayıları — metin içinden çek', '  // Follower/following counts — extract from text'),
    ('  const followersMatch = markdown.match(/(\\d[\\d,.]+)\\s*(?:Followers?|Takipçi)/i)', '  const followersMatch = markdown.match(/(\\d[\\d,.]+)\\s*(?:Followers?)/i)'),
    ('  const tweetsMatch = markdown.match(/(\\d[\\d,.]+)\\s*(?:posts?|tweets?|Gönderi)/i)', '  const tweetsMatch = markdown.match(/(\\d[\\d,.]+)\\s*(?:posts?|tweets?)/i)'),
    ('    return `❌ Twitter/X profil hatası (@${profile.username}): ${profile.error}`', '    return `❌ Twitter/X profile error (@${profile.username}): ${profile.error}`'),
    ('    `İsim: ${profile.displayName || \'N/A\'}`,', '    `Name: ${profile.displayName || \'N/A\'}`,'),
    ('    `Takipçi: ${profile.followers || \'N/A\'}`,', '    `Followers: ${profile.followers || \'N/A\'}`,'),
    ("    `Doğrulanmış: ${profile.verified ? '✅ Evet' : '❌ Hayır'}`,", "    `Verified: ${profile.verified ? '✅ Yes' : '❌ No'}`,"),
]

def apply_replacements(filepath, replacements):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        changed = False
        for old, new in replacements:
            if old in content:
                content = content.replace(old, new)
                changed = True
            # else:
            #     print(f'  NOT FOUND in {filepath}: {repr(old[:50])}')
        if changed:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f'✅ Updated: {filepath}')
        else:
            print(f'⏭  No changes: {filepath}')
    except FileNotFoundError:
        print(f'❌ Not found: {filepath}')
    except Exception as e:
        print(f'❌ Error in {filepath}: {e}')

for filepath, replacements in FILE_REPLACEMENTS.items():
    apply_replacements(filepath, replacements)

print('Done.')

#!/usr/bin/env python3
"""
OSINT Agent Weekly Report — PDF Generator
Uses fpdf2 to create a professional-looking report.
"""
from fpdf import FPDF
from datetime import datetime

class ReportPDF(FPDF):
    PRIMARY = (30, 58, 95)       # Dark navy
    ACCENT = (52, 152, 219)      # Blue
    ACCENT2 = (46, 204, 113)     # Green
    ACCENT3 = (231, 76, 60)      # Red
    GRAY = (127, 140, 141)
    LIGHT_BG = (236, 240, 241)
    WHITE = (255, 255, 255)

    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("DejaVu", "I", 8)
        self.set_text_color(*self.GRAY)
        self.cell(0, 8, "OSINT Agent — Haftalık Geliştirme Raporu | W13 2026", align="C")
        self.ln(10)

    def footer(self):
        self.set_y(-15)
        self.set_font("DejaVu", "I", 8)
        self.set_text_color(*self.GRAY)
        self.cell(0, 10, f"Sayfa {self.page_no()}/{{nb}}", align="C")

    def section_title(self, num, title):
        self.set_font("DejaVu", "B", 16)
        self.set_text_color(*self.PRIMARY)
        self.cell(0, 12, f"{num}. {title}", new_x="LMARGIN", new_y="NEXT")
        # Underline
        self.set_draw_color(*self.ACCENT)
        self.set_line_width(0.8)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(4)

    def sub_title(self, title):
        self.set_font("DejaVu", "B", 12)
        self.set_text_color(*self.ACCENT)
        self.cell(0, 10, title, new_x="LMARGIN", new_y="NEXT")

    def body_text(self, text):
        self.set_font("DejaVu", "", 10)
        self.set_text_color(44, 62, 80)
        self.multi_cell(0, 5.5, text)
        self.ln(2)

    def bullet(self, text, indent=15):
        x = self.get_x()
        self.set_x(x + indent)
        self.set_font("DejaVu", "", 10)
        self.set_text_color(44, 62, 80)
        self.cell(4, 5.5, chr(8226))
        self.multi_cell(0, 5.5, f" {text}")
        self.set_x(x)

    def code_block(self, code):
        self.set_fill_color(44, 62, 80)
        self.set_text_color(*self.WHITE)
        self.set_font("DejaVuMono", "", 8)
        x = self.get_x() + 5
        y = self.get_y()
        self.set_x(x)
        lines = code.split("\n")
        h = len(lines) * 4.5 + 6
        if y + h > 280:
            self.add_page()
            y = self.get_y()
        self.rect(x - 2, y, 180, h, style="F")
        self.set_y(y + 3)
        for line in lines:
            self.set_x(x + 2)
            self.cell(0, 4.5, line[:100])
            self.ln()
        self.ln(4)

    def kv_table(self, data, col_widths=(60, 120)):
        self.set_font("DejaVu", "", 9)
        for key, val in data:
            self.set_fill_color(*self.LIGHT_BG)
            self.set_text_color(*self.PRIMARY)
            self.set_font("DejaVu", "B", 9)
            self.cell(col_widths[0], 7, f" {key}", border=1, fill=True)
            self.set_text_color(44, 62, 80)
            self.set_font("DejaVu", "", 9)
            self.cell(col_widths[1], 7, f" {val}", border=1)
            self.ln()
        self.ln(3)

    def stat_box(self, label, value, color):
        x = self.get_x()
        y = self.get_y()
        w, h = 42, 22
        self.set_fill_color(*color)
        self.rect(x, y, w, h, style="F")
        self.set_xy(x, y + 3)
        self.set_font("DejaVu", "B", 14)
        self.set_text_color(*self.WHITE)
        self.cell(w, 8, str(value), align="C")
        self.set_xy(x, y + 12)
        self.set_font("DejaVu", "", 7)
        self.cell(w, 6, label, align="C")
        self.set_xy(x + w + 3, y)


def build_report():
    pdf = ReportPDF()
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=20)

    # ═══ COVER PAGE ═══
    pdf.add_page()
    pdf.add_font("DejaVu", "", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", uni=True)
    pdf.add_font("DejaVu", "B", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", uni=True)
    pdf.add_font("DejaVu", "I", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", uni=True)
    pdf.add_font("DejaVu", "BI", "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf", uni=True)
    pdf.add_font("DejaVuMono", "", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", uni=True)

    pdf.ln(40)
    # Title bar
    pdf.set_fill_color(*ReportPDF.PRIMARY)
    pdf.rect(0, 55, 210, 45, style="F")
    pdf.set_y(60)
    pdf.set_font("DejaVu", "B", 28)
    pdf.set_text_color(*ReportPDF.WHITE)
    pdf.cell(0, 14, "OSINT Agent", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("DejaVu", "", 14)
    pdf.cell(0, 8, "Haftalık Geliştirme Raporu", align="C", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(25)
    pdf.set_text_color(44, 62, 80)
    pdf.set_font("DejaVu", "", 12)
    pdf.cell(0, 8, "24 Mart – 2 Nisan 2026  |  Hafta 13", align="C", new_x="LMARGIN", new_y="NEXT")

    # Stats boxes
    pdf.ln(15)
    pdf.set_x(14)
    pdf.stat_box("Toplam Commit", "67", ReportPDF.PRIMARY)
    pdf.stat_box("Degisen Dosya", "44", ReportPDF.ACCENT)
    pdf.stat_box("Eklenen Satir", "+6,959", ReportPDF.ACCENT2)
    pdf.stat_box("Test", "31/31", (142, 68, 173))

    pdf.ln(30)
    pdf.set_font("DejaVu", "", 10)
    pdf.set_text_color(*ReportPDF.GRAY)
    pdf.cell(0, 8, "Berkay Hasret Baykara  |  2 Nisan 2026", align="C")

    # ═══ SECTION 1: ARAMA ═══
    pdf.add_page()
    pdf.section_title("1", "Arama Altyapisi - SearXNG Self-Hosted")
    pdf.body_text("Docker uzerinde kendi SearXNG instance'imizi kurduk. 100+ arama motorunu tek noktada toplayan bir metasearch engine. Dis API'lere bagimlilik azaldi.")
    pdf.code_block("Kullanici -> Agent -> SearXNG (localhost:8888)\n                          |\n                   Google, Bing, Brave, Qwant, Reddit...\n                          v (hata olursa)\n                   Brave -> Google CSE -> Tavily")
    pdf.sub_title("4 Katmanli Fallback Zinciri")
    pdf.kv_table([
        ("Katman 1", "SearXNG (self-hosted, sinirsiz)"),
        ("Katman 2", "Brave Search (2000 req/ay ucretsiz)"),
        ("Katman 3", "Google CSE (100 req/gun)"),
        ("Katman 4", "Tavily API (fallback)"),
    ])
    pdf.sub_title("Brave Rate Limiter")
    pdf.body_text("Brave API'nin ucretsiz limitini korumak icin 1.1 saniye global throttle eklendi. Sosyal medya site: sorgulari Brave'i bypass ediyor.")

    # ═══ SECTION 2: SCRAPING ═══
    pdf.section_title("2", "Scraping Altyapisi - Scrapling Primary")
    pdf.body_text("Scrape zinciri yeniden yapilandirildi. Firecrawl cloud (500 req/ay) primary'den son care dusturuldu.")
    pdf.code_block("Scrapling (--stealth)  [PRIMARY - anti-bot bypass]\n    |\n    v\nPuppeteer Stealth        [JS rendering]\n    |\n    v\nFirecrawl Cloud          [son care, 500 req/ay]")
    pdf.kv_table([
        ("Scrapling", "Python, Cloudflare Turnstile bypass, sinirsiz"),
        ("Puppeteer", "JS rendering, headless Chrome"),
        ("Firecrawl", "Cloud API, 500 req/ay limit"),
    ])

    # ═══ SECTION 3: MULTI-AGENT ═══
    pdf.add_page()
    pdf.section_title("3", "Multi-Agent Sistem")
    pdf.sub_title("Yeni: AcademicAgent")
    pdf.body_text("Akademik arastirma icin ozel sub-agent. arXiv + Semantic Scholar cift kaynaktan makale arama, derin okuma, yazar profili cikarma, Neo4j grafa yazma.")
    pdf.kv_table([
        ("Supervisor", "qwen3.6-plus | Yonlendirme, genel arama, rapor"),
        ("IdentityAgent", "qwen3.6-plus | Username, email, GitHub, breach"),
        ("MediaAgent", "qwen3.6-plus | Gorsel analizi, fact-check, EXIF"),
        ("AcademicAgent", "qwen3.6-plus | Makale, intihal, akademik profil"),
    ])
    pdf.sub_title("Session Persistence")
    pdf.body_text("Her agent icin kalici bilgi tabani: ham tool ciktilari ve ozet rapor .osint-sessions/ altinda saklaniyor.")

    # ═══ SECTION 4: OBSDIAN + NEO4J ═══
    pdf.section_title("4", "Obsidian Vault + Neo4j Graph")
    pdf.sub_title("Obsidian Entegrasyonu")
    pdf.body_text("Agent'in tum ciktilari otomatik olarak Obsidian vault'una yaziliyor: arastirma raporlari, profil sayfalari, literatur taramalari, gunluk log.")
    pdf.sub_title("Neo4j Graph Veritabani")
    pdf.body_text("Yeni node tipleri eklendi: Cybersecurity (IOC), Claim/Fact/Source (fact-check), Publication (akademik). GNN egitimi icin mlLabel sistemi.")
    pdf.code_block("MATCH (n) WHERE n.mlLabel = 'false_positive'\nRETURN n  -- negatif ornek (GNN egitimi)")

    # ═══ SECTION 5: GPX TOOL ═══
    pdf.add_page()
    pdf.section_title("5", "GPX Analyzer Tool (Yeni)")
    pdf.body_text("GPS track analizi icin yeni tool. Fitness tracker verilerinden konum tespiti, hotspot analizi, reverse geocoding.")
    pdf.kv_table([
        ("GPX Parsing", "Track point, elevation, timestamp cikarma"),
        ("Hotspot Detection", "Tekrar eden konumlar, haversine kumeleme"),
        ("Reverse Geocoding", "OpenStreetMap Nominatim API"),
        ("Cross-track Overlap", "Dosyalar arasi ortusme analizi"),
    ])
    pdf.sub_title("OSINT Challenges Challenge 10 - Sonuc")
    pdf.body_text("3 GPX dosyasi analiz edildi. 80 GPS noktasinin tamamı Eyfel Kulesi etrafinda. En yakin nokta: 4 metre mesafe. Cevap: Eiffel Tower, Paris, France.")

    # ═══ SECTION 6: MODEL UPGRADE ═══
    pdf.section_title("6", "Model Upgrade + Error Handling")
    pdf.kv_table([
        ("Onceki Model", "qwen/qwen3.5-plus-02-15 (ucretli)"),
        ("Yeni Model", "qwen/qwen3.6-plus-preview:free (ucretsiz)"),
        ("Fallback", "google/gemini-2.0-flash-001 (PII filtresi)"),
    ])
    pdf.sub_title("Hata Toleransi Mekanizmalari")
    pdf.kv_table([
        ("429 Rate Limit", "5s bekle -> retry"),
        ("DataInspectionFailed", "Otomatik Gemini fallback"),
        ("502 Bad Gateway", "3s bekle -> retry"),
        ("JSON parse hatasi", "Model kendini duzeltir (max 6 deneme)"),
        ("Bos yanit", "3 deneme -> forceText modu"),
    ])

    # ═══ SECTION 7: LOGGING + TEST ═══
    pdf.section_title("7", "Logging + Test Altyapisi")
    pdf.body_text("console.log -> yapilandirilmis logger gecişi. Renkli, seviyeli log sistemi.")
    pdf.code_block("[01:52:24] [INFO]  [AGENT] Supervisor Dusunuyor...\n[01:52:42] [TOOL]  Akademik Arastirma: LLM quantization...\n[01:52:45] [GRAPH] Grafa yazildi: 25 makale, 91 yazar\n[01:52:42] [WARN]  Rate limit (429) - 5s bekleniyor...")
    pdf.sub_title("31 Regresyon Testi (Hepsi Yesil)")
    pdf.kv_table([
        ("baseAgent.test.ts", "8 test - 429 retry, DataInspection, 502, fallback"),
        ("chatHistory.test.ts", "3 test - normalizasyon, null content"),
        ("osintHeuristics.test.ts", "4 test - username, Turk isimleri"),
        ("githubTool.test.ts", "6 test - profil, fork, email, GPG"),
        ("sherlockTool.test.ts", "5 test - JSON, text fallback, spawn"),
        ("githubGpgUtils.test.ts", "2 test - placeholder detection"),
    ])

    # ═══ SECTION 8: SONRAKI ADIMLAR ═══
    pdf.add_page()
    pdf.section_title("8", "Sonraki Adimlar")
    pdf.kv_table([
        ("1. Tool Isolation", "Her agent sadece ilgili tool'lari gorsun (kalite)"),
        ("2. Paralel Tool Execution", "Concurrent tool calls (hiz 2-3x)"),
        ("3. Dream Memory", "Session'lar arasi kalici hafiza"),
        ("4. Context Compaction", "Uzun arastirmalarda otomatik ozetleme"),
        ("5. MCP Server", "Python tool'larini standart arayuze sarma"),
    ])
    pdf.body_text("Bu ozellikler Claude Code kaynak kodundan ilham alinarak planlanmistir. Oncelikli olan Tool Isolation ve Paralel Tool Execution'dur.")

    # Save
    output = "/home/berkayhsrt/Baykara/osint-agent/docs/OSINT_Agent_Weekly_Report_W13_2026.pdf"
    pdf.output(output)
    print(f"PDF saved: {output}")
    return output

if __name__ == "__main__":
    build_report()

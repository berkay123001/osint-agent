/**
 * Benchmark Test Cases
 * Makale Bölüm 4 (Deneysel Değerlendirme) için test senaryoları
 */

export type TestCategory =
  | 'identity'
  | 'media'
  | 'academic'
  | 'cross-domain'
  | 'false-positive'

export type AgentType = 'supervisor' | 'identity' | 'media' | 'academic'
export type DepthLevel = 'quick' | 'normal' | 'deep'

export interface TestCase {
  id: string
  category: TestCategory
  agent: AgentType
  query: string
  context?: string
  depth: DepthLevel
  description: string // makale açıklaması için
  expectedSignals?: string[] // yanıtta bulunması beklenen anahtar kelimeler (isteğe bağlı doğrulama)
}

export const TEST_CASES: TestCase[] = [
  // ── [I] Identity ────────────────────────────────────────────────────────────
  {
    id: 'I-1',
    category: 'identity',
    agent: 'identity',
    query: 'torvalds GitHub kullanıcısını araştır. Gerçek adı, e-posta, organizasyonlar, katkıda bulunduğu repolar hakkında bilgi topla.',
    depth: 'quick',
    description: 'Kamuya açık GitHub kullanıcısı — doğrulanabilir verilerle referans profil (Linus Torvalds)',
    expectedSignals: ['Linus', 'Linux', 'GitHub'],
  },
  {
    id: 'I-2',
    category: 'identity',
    agent: 'identity',
    query: 'E-posta adresi berkay@example.com olan ve GitHub kullanıcı adı "berkayhsrt" olan kişiyi araştır. Sosyal medya hesaplarını ve dijital ayak izini bul.',
    depth: 'quick',
    description: 'E-posta + kullanıcı adı kombinasyonu — çoklu kaynak çapraz doğrulama senaryosu',
    expectedSignals: ['berkayhsrt'],
  },
  {
    id: 'I-3',
    category: 'identity',
    agent: 'identity',
    query: 'GitHub kullanıcısı "octocat" hakkında kapsamlı profil çıkar. Proje geçmişi, dil tercihleri, aktif dönemleri analiz et.',
    depth: 'quick',
    description: 'GitHub demo hesabı — araç çağrı zincirleme ve pivot analizi testi',
    expectedSignals: ['octocat', 'GitHub'],
  },

  // ── [M] Media ───────────────────────────────────────────────────────────────
  {
    id: 'M-1',
    category: 'media',
    agent: 'media',
    query: 'Bu haberi doğrula: "Linus Torvalds 2024 yılında Linux geliştirmeyi bıraktığını açıkladı." Bu iddia doğru mu?',
    depth: 'quick',
    description: 'Yanlış haber fact-check — bilinenin aksini iddia eden sahte haber tespiti',
    expectedSignals: ['false', 'yanlış', 'doğrulanamadı', 'kanıt yok'],
  },
  {
    id: 'M-2',
    category: 'media',
    agent: 'media',
    query: 'https://avatars.githubusercontent.com/u/583231?v=4 — Bu görselin ters arama analizi yap. Görselin kaynağını, hangi hesaplarda kullanıldığını ve orijinallik durumunu değerlendir.',
    depth: 'quick',
    description: 'Ters görüntü araması ve metadata analizi — GitHub avatar kaynağı doğrulama',
    expectedSignals: ['github', 'octocat'],
  },

  // ── [A] Academic ─────────────────────────────────────────────────────────────
  {
    id: 'A-1',
    category: 'academic',
    agent: 'academic',
    query: 'Yasser Tawfik isimli araştırmacının akademik profilini çıkar. Semantic Scholar ve Google Scholar üzerinden yayınlarını, atıf sayılarını ve araştırma alanlarını bul.',
    depth: 'quick',
    description: 'Araştırmacı kimlik profili — akademik veri tabanı çoklu kaynak doğrulaması',
    expectedSignals: ['paper', 'citation', 'research'],
  },
  {
    id: 'A-2',
    category: 'academic',
    agent: 'academic',
    query: 'Multi-agent OSINT sistemleri üzerine 2020-2025 arası yayımlanan güncel akademik literatürü tara. Graph RAG ve knowledge graph kullanılan çalışmalara odaklan.',
    depth: 'normal',
    description: 'Konu bazlı literatür taraması — Graph RAG + OSINT araştırma alanı haritalama (normal depth ile bütçe skalama)',
    expectedSignals: ['graph', 'OSINT', 'multi-agent'],
  },

  // ── [C] Cross-domain ─────────────────────────────────────────────────────────
  {
    id: 'C-1',
    category: 'cross-domain',
    agent: 'supervisor',
    query: 'torvalds GitHub kullanıcısının kimliğini doğrula ve aynı zamanda Linux çekirdeği üzerine yayınlarını akademik veri tabanlarında ara. Dijital kimlik ile akademik yayın profilini karşılaştır.',
    depth: 'normal',
    description: 'Kimlik↔Akademik korelasyon — supervisor çok-ajan yönlendirme senaryosu (normal depth)',
    expectedSignals: ['Linus', 'Linux', 'publication'],
  },
  {
    id: 'C-2',
    category: 'cross-domain',
    agent: 'supervisor',
    query: '"Ahmet Yılmaz" adındaki kişinin GitHub profilini, akademik yayınlarını ve sosyal medya hesaplarını araştır. Hangi Ahmet Yılmaz olduğunu belirlemeye çalış.',
    depth: 'normal',
    description: 'Çok-ajan yönlendirme — ortak isim belirsizlik çözümü senaryosu (normal depth)',
    expectedSignals: [],
  },

  // ── [F] False Positive ──────────────────────────────────────────────────────
  {
    id: 'FP-1',
    category: 'false-positive',
    agent: 'identity',
    query: 'Ahmet Yılmaz kimdir? Dijital profilini bul.',
    depth: 'quick',
    description: 'Yaygın Türk ismi — heuristics ambiguity detection ve false-positive filtreleme testi',
    expectedSignals: ['belirsiz', 'birden fazla', 'doğrulanamadı', 'ambiguous', 'multiple'],
  },
  {
    id: 'FP-2',
    category: 'false-positive',
    agent: 'identity',
    query: 'berkay123001 GitHub kullanıcısının dijital profilini çıkar. Gerçek kimliğini, kullandığı teknolojileri ve platformlardaki diğer hesaplarını bul.',
    depth: 'normal',
    description: 'Öznel doğruluk testi — spesifik bir GitHub kullanıcısında precision ölçümü (Berkay Hasret)',
    expectedSignals: ['Berkay', 'Hasret', 'TypeScript', 'Python', 'osint-agent'],
  },
]

export function getTestCasesByCategory(category: TestCategory): TestCase[] {
  return TEST_CASES.filter(tc => tc.category === category)
}

export function getTestCaseById(id: string): TestCase | undefined {
  return TEST_CASES.find(tc => tc.id === id)
}

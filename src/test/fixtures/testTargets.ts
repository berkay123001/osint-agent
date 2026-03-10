/**
 * Test Hedefleri - OSINT Agent Test Senaryolari
 * 
 * Bu dosya agent'i test etmek icin kullanilabilecek gercek veya
 * gercekci test hedeflerini icerir.
 * 
 * NOT: "ethical" olarak isaretlenenler gercek kisilerdir ve
 * bilgileri zaten kamuya aciktir. Digerleri kurgusal/test amaclidir.
 */

export interface TestTarget {
  id: string
  description: string
  type: 'real_public' | 'fictional' | 'test_account'
  ethical: boolean  // Gercek kisi mi? (Etik kurallar acisindan)
  data: {
    username?: string
    email?: string
    name?: string
    platforms?: string[]
    expectedFindings?: string[]
  }
  difficulty: 'easy' | 'medium' | 'hard'
}

/**
 * GUVENLI TEST HEDEFLERI
 * Bu hedefler test icin guvenlidir, bilgiler kamuya aciktir
 */
export const SAFE_TEST_TARGETS: TestTarget[] = [
  {
    id: 'octocat',
    description: 'GitHub\'in resmi maskot hesabi - En temel test',
    type: 'real_public',
    ethical: true,
    difficulty: 'easy',
    data: {
      username: 'octocat',
      name: 'The Octocat',
      platforms: ['GitHub'],
      expectedFindings: [
        'GitHub profili: https://github.com/octocat',
        'Email: octocat@github.com (profile)',
        '8 public repo',
        'GPG/SSH keys olabilir'
      ]
    }
  },
  {
    id: 'torvalds',
    description: 'Linus Torvalds - Linux creator (cok aktif, cok veri)',
    type: 'real_public',
    ethical: true,
    difficulty: 'easy',
    data: {
      username: 'torvalds',
      name: 'Linus Torvalds',
      email: 'torvalds@linux-foundation.org',
      platforms: ['GitHub', 'Twitter', 'Linux Foundation'],
      expectedFindings: [
        'GitHub: https://github.com/torvalds',
        'Linux kernel commit emailleri',
        'Cok sayida cross-reference'
      ]
    }
  },
  {
    id: 'defunkt',
    description: 'Chris Wanstrath - GitHub co-founder (aktif degil ama bilgiler var)',
    type: 'real_public',
    ethical: true,
    difficulty: 'medium',
    data: {
      username: 'defunkt',
      platforms: ['GitHub', 'Twitter', 'Blog'],
      expectedFindings: [
        'Eski GitHub aktiviteleri',
        'Twitter cross-reference',
        'Blog: https://chriswanstrath.com/'
      ]
    }
  }
]

/**
 * KURGUSAL TEST SENARYOLARI
 * Bu senaryolar tamamen kurgusaldir, givenlik acisindan tamamen guvenli
 */
export const FICTIONAL_SCENARIOS: TestTarget[] = [
  {
    id: 'scenario_1_simple',
    description: 'Basit: Tek username, acik profil',
    type: 'fictional',
    ethical: false,
    difficulty: 'easy',
    data: {
      username: 'demo_user_2024',
      email: 'demo_user_2024@example.com',
      name: 'Demo User',
      platforms: ['GitHub', 'Twitter', 'LinkedIn'],
      expectedFindings: [
        '3 platformda ayni username',
        'Acik email adresi',
        'Profil fotoğrafi cross-reference yapilabilir'
      ]
    }
  },
  {
    id: 'scenario_2_network',
    description: 'Orta: Birden fazla baglantili hesap (network testi)',
    type: 'fictional',
    ethical: false,
    difficulty: 'medium',
    data: {
      username: 'network_test_alpha',
      email: 'alpha@test-network.example',
      name: 'Alpha Tester',
      platforms: ['GitHub', 'GitLab', 'Twitter', 'Reddit'],
      expectedFindings: [
        'Ayni email ile 4 platform',
        'Twitter bio\'da github linki',
        'GitHub reposunda Twitter mention',
        'Network graph testi icin ideal'
      ]
    }
  },
  {
    id: 'scenario_3_hard',
    description: 'Zor: Gizli/privat hesap, minimal iz',
    type: 'fictional',
    ethical: false,
    difficulty: 'hard',
    data: {
      username: 'ghost_user_x7',
      platforms: ['GitHub (private)', 'Twitter (protected)', 'Forum'],
      expectedFindings: [
        'Cok az acik veri',
        'Sadece eski commit emailleri',
        'Wayback Machine arşivi'
      ]
    }
  }
]

/**
 * GITHUB API TEST CASELERI
 */
export const GITHUB_TEST_CASES = {
  // Var olan kullanicilar
  existing: [
    'octocat',      // GitHub maskot
    'torvalds',     // Linus
    'defunkt',      // Chris Wanstrath
    'gaearon',      // Dan Abramov
    'sindresorhus'  // Aktif open source developer
  ],
  
  // Olmayan kullanicilar
  nonexistent: [
    'this_user_does_not_exist_xyz',
    'nonexistent_user_12345_test'
  ]
}

/**
 * Neo4j Graph Test Datasi
 * Integration testler icin ornek graph
 */
export const NEO4J_TEST_GRAPH = {
  nodes: [
    { label: 'Username', value: 'test_subject' },
    { label: 'Email', value: 'test@example.com' },
    { label: 'Person', value: 'Test User' },
    { label: 'Profile', value: 'https://github.com/test_subject', platform: 'GitHub' },
    { label: 'Profile', value: 'https://twitter.com/test_subject', platform: 'Twitter' },
    { label: 'Location', value: 'Istanbul' }
  ],
  relationships: [
    { from: 'test_subject', to: 'test@example.com', type: 'USES_EMAIL' },
    { from: 'test_subject', to: 'Test User', type: 'REAL_NAME' },
    { from: 'test_subject', to: 'https://github.com/test_subject', type: 'HAS_PROFILE' },
    { from: 'test_subject', to: 'https://twitter.com/test_subject', type: 'HAS_PROFILE' },
    { from: 'test_subject', to: 'Istanbul', type: 'LOCATED_IN' }
  ]
}

/**
 * Agent Test Senaryoları
 * Tam akış testi için senaryolar
 */
export const AGENT_TEST_SCENARIOS = [
  {
    name: 'Basit Username Arama',
    steps: [
      'Kullanıcı: "octocat hakkında bilgi bul"',
      'Agent: Sherlock çalıştırır',
      'Agent: GitHub API çalıştırır',
      'Agent: Bilgileri graf\'a yazar',
      'Agent: Özet rapor sunar'
    ]
  },
  {
    name: 'Email Bazlı Araştırma',
    steps: [
      'Kullanıcı: "test@example.com kimde?"',
      'Agent: holehe çalıştırır (mock)',
      'Agent: Bulunan platformları raporlar'
    ]
  },
  {
    name: 'Network Analizi',
    steps: [
      'Kullanıcı: "bu kullanıcıların bağlantısı nedir?"',
      'Agent: Her iki kullanıcı için araştırma yapar',
      'Agent: Ortak bağlantıları bulur (email, lokasyon vb)',
      'Agent: Network graph\'ı görselleştirir'
    ]
  }
]

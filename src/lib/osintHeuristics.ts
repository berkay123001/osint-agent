export function isLikelyUsernameCandidate(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return false
  if (/\s/.test(normalized)) return false
  return true
}

/** Yaygın Türk isimlerini tespit et — doğrulama gerektiren adaylar */
const COMMON_TURKISH_NAMES = new Set([
  'mehmet', 'ali', 'ahmet', 'mustafa', 'ibrahim', 'hasan', 'hüseyin', 'ismail',
  'osman', 'murat', 'yusuf', 'ömer', 'emre', 'burak', 'can', 'fatih',
  'salih', 'serkan', 'engin', 'deniz', 'barış', 'onur', 'tolga', 'kerem',
])
const COMMON_TURKISH_SURNAMES = new Set([
  'yılmaz', 'kaya', 'demir', 'çelik', 'şahin', 'yıldız', 'yıldırım', 'öztürk',
  'aydın', 'özdemir', 'arslan', 'doğan', 'kılıç', 'aslan', 'çetin', 'kara',
  'koç', 'kurt', 'özkan', 'şimşek', 'polat', 'dursun', 'korkmaz', 'bayrak',
])

/** Bir ismin yaygın/jenerik olup olmadığını kontrol et */
export function isCommonName(fullName: string): boolean {
  const parts = fullName.toLowerCase().trim().split(/\s+/)
  if (parts.length < 2) return false
  const firstName = parts[0]
  const lastName = parts[parts.length - 1]
  return COMMON_TURKISH_NAMES.has(firstName) || COMMON_TURKISH_SURNAMES.has(lastName)
}

/** Çapraz doğrulama skoru — iki bilgi seti ne kadar örtüşüyor? */
export function crossReferenceScore(
  known: { emails: string[]; handles: string[]; websites: string[] },
  candidate: { email?: string; handle?: string; website?: string; name?: string }
): { score: number; matches: string[] } {
  const matches: string[] = []

  if (candidate.email && known.emails.includes(candidate.email)) {
    matches.push(`email: ${candidate.email}`)
  }
  if (candidate.handle && known.handles.includes(candidate.handle)) {
    matches.push(`handle: ${candidate.handle}`)
  }
  if (candidate.website && known.websites.some(w => w.includes(candidate.website!))) {
    matches.push(`website: ${candidate.website}`)
  }

  // İsim tek başına yeterli değil — sadece bonus puan
  const score = matches.length
  return { score, matches }
}
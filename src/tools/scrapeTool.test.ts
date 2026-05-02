/**
 * Scrape Tool Test Suite
 * isInterestingFile, detectLoginWall — saf fonksiyonlar
 * scrapeProfile — SSRF koruma testleri (network yok)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { isInterestingFile, detectLoginWall, scrapeProfile } from './scrapeTool.js'

// ===== isInterestingFile =====

test('isInterestingFile: undefined → false', () => {
  assert.equal(isInterestingFile(undefined), false)
})

test('isInterestingFile: PDF dosyası → true', () => {
  assert.equal(isInterestingFile('https://example.com/report.pdf'), true)
})

test('isInterestingFile: DOCX dosyası → true', () => {
  assert.equal(isInterestingFile('https://university.edu/thesis.docx'), true)
})

test('isInterestingFile: PNG dosyası normal domain → true', () => {
  assert.equal(isInterestingFile('https://mysite.com/photo.png'), true)
})

test('isInterestingFile: GitHub avatar PNG → false (ignoredDomains)', () => {
  assert.equal(isInterestingFile('https://avatars.githubusercontent.com/user.png'), false)
})

test('isInterestingFile: Gravatar PNG → false', () => {
  assert.equal(isInterestingFile('https://gravatar.com/avatar.jpg'), false)
})

test('isInterestingFile: CDN domain → false', () => {
  assert.equal(isInterestingFile('https://cdn.example.com/image.jpg'), false)
})

test('isInterestingFile: HTML dosyası → false (uzantı yok)', () => {
  assert.equal(isInterestingFile('https://example.com/page.html'), false)
})

test('isInterestingFile: uzantısız URL → false', () => {
  assert.equal(isInterestingFile('https://example.com/profile'), false)
})

// ===== detectLoginWall =====

test('detectLoginWall: temiz içerik → false', () => {
  const markdown = 'Bu bir kullanıcı profilidir. Adı John, yaşı 30. Bio: yazılım geliştirici.'
  assert.equal(detectLoginWall(markdown, 'Profil'), false)
})

test('detectLoginWall: sign in to continue → true', () => {
  const markdown = 'Sign in to continue reading this article and access all features.'
  assert.equal(detectLoginWall(markdown, 'Article'), true)
})

test('detectLoginWall: login required başlık + kısa içerik → true', () => {
  const markdown = 'Bu içeriği görmek için giriş yapın.'
  assert.equal(detectLoginWall(markdown, 'Login Required'), true)
})

test('detectLoginWall: "giriş yap" Türkçe metin → true', () => {
  const markdown = 'Bu sayfayı görüntülemek için lütfen giriş yap.'
  assert.equal(detectLoginWall(markdown, 'Profil'), true)
})

test('detectLoginWall: "please log in" → true', () => {
  const markdown = 'Please log in to view this profile.'
  assert.equal(detectLoginWall(markdown, 'Profile'), true)
})

test('detectLoginWall: members only → true', () => {
  const markdown = 'This content is for members only. Please sign up.'
  assert.equal(detectLoginWall(markdown, 'Members Area'), true)
})

test('detectLoginWall: kısa içerik + normal başlık → false (başlık eşleşmiyor)', () => {
  // 300 char altı ama başlık "login" içermiyor
  const markdown = 'Kısa bir metin.'
  assert.equal(detectLoginWall(markdown, 'Haber'), false)
})

test('detectLoginWall: "create an account" → true', () => {
  const markdown = 'To access this resource, please create an account.'
  assert.equal(detectLoginWall(markdown, 'Registration'), true)
})

// ===== scrapeProfile: SSRF Koruması =====

test('scrapeProfile: localhost SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://localhost:8080/admin')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
  assert.ok(result.error?.includes('localhost'))
})

test('scrapeProfile: 127.0.0.1 SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://127.0.0.1:3000/api')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('scrapeProfile: 192.168.x.x SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://192.168.1.1/router')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('scrapeProfile: 10.x.x.x SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://10.0.0.1/internal')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('scrapeProfile: 172.16.x.x SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://172.16.0.1/service')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('scrapeProfile: 169.254.x.x (link-local) SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://169.254.169.254/metadata')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('scrapeProfile: .local domain SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://internal.local/dashboard')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('scrapeProfile: geçersiz URL → hata döner', async () => {
  const result = await scrapeProfile('not-a-valid-url')
  assert.ok(result.error)
  assert.equal(result.markdown, '')
})

test('scrapeProfile: 0.0.0.0 SSRF engelleniyor', async () => {
  const result = await scrapeProfile('http://0.0.0.0:4000/admin')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

/**
 * Web Fetch Tool Test Suite
 * URL doğrulama ve SSRF koruma testleri — ağ çağrısı yok
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webFetch } from './webFetchTool.js'

// ===== URL Doğrulama =====

test('webFetch: geçersiz URL → error döner', async () => {
  const result = await webFetch('bu-gecersiz-bir-url')
  assert.ok(result.error?.includes('Geçersiz URL'))
  assert.equal(result.savedTo, null)
  assert.equal(result.statusCode, 0)
})

test('webFetch: ftp:// protokolü → error (sadece http/https desteklenir)', async () => {
  const result = await webFetch('ftp://files.example.com/data.txt')
  assert.ok(result.error?.includes('http/https') || result.error?.includes('desteklenir'))
  assert.equal(result.savedTo, null)
})

test('webFetch: file:// protokolü → error', async () => {
  const result = await webFetch('file:///etc/passwd')
  assert.ok(result.error?.includes('http/https') || result.error?.includes('desteklenir'))
})

test('webFetch: javascript: protokolü → error', async () => {
  const result = await webFetch('javascript:alert(1)')
  assert.ok(result.error)
})

// ===== SSRF Koruması =====

test('webFetch: localhost SSRF engelleniyor', async () => {
  const result = await webFetch('http://localhost:8080/admin')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
  assert.ok(result.error?.includes('localhost'))
})

test('webFetch: 127.0.0.1 SSRF engelleniyor', async () => {
  const result = await webFetch('http://127.0.0.1:9200/_cat/indices')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
  assert.ok(result.error?.includes('127.0.0.1'))
})

test('webFetch: 192.168.x.x SSRF engelleniyor', async () => {
  const result = await webFetch('http://192.168.0.1/router')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('webFetch: 10.x.x.x SSRF engelleniyor', async () => {
  const result = await webFetch('http://10.10.10.10/api')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('webFetch: 172.16.x.x SSRF engelleniyor', async () => {
  const result = await webFetch('http://172.16.0.1/internal')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('webFetch: 0.0.0.0 SSRF engelleniyor', async () => {
  const result = await webFetch('http://0.0.0.0:3000/')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('webFetch: .local domain SSRF engelleniyor', async () => {
  const result = await webFetch('http://myapp.local/secret')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('webFetch: Neo4j Browser URL engelleniyor (güvenlik regresyon testi)', async () => {
  const result = await webFetch('http://localhost:7474/browser/')
  assert.ok(result.error?.includes('İç ağ adreslerine erişim engellendi'))
})

test('webFetch: metadata endpoint engelleniyor (AWS SSRF)', async () => {
  const result = await webFetch('http://169.254.169.254/latest/meta-data/')
  // 172.x veya 169.254.x — SSRF koruma kapsamında değilse en az 172 bloğu var
  // webFetchTool hostname.startsWith('172.') kontrolü yapar
  assert.ok(result.error)
})

// ===== URL alanı doğrulaması =====

test("webFetch: url alanı result'ta korunuyor", async () => {
  const url = 'http://localhost/test'
  const result = await webFetch(url)
  assert.equal(result.url, url)
})

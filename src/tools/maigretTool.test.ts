/**
 * Maigret Tool Test Suite
 * Kullanıcı adı format doğrulama — subprocess çalıştırılmaz
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runMaigret } from './maigretTool.js'

// ===== Giriş Doğrulama =====

test('runMaigret: boş kullanıcı adı → error, subprocess yok', async () => {
  const result = await runMaigret('')
  assert.ok(result.error?.includes('Invalid username format'))
  assert.equal(result.found.length, 0)
  assert.equal(result.foundCount, 0)
})

test('runMaigret: 51 karakter → error (max 50)', async () => {
  const longUsername = 'a'.repeat(51)
  const result = await runMaigret(longUsername)
  assert.ok(result.error?.includes('Invalid username format'))
})

test('runMaigret: özel karakter içeren kullanıcı adı → error', async () => {
  const result = await runMaigret('user<script>alert(1)</script>')
  assert.ok(result.error?.includes('Invalid username format'))
})

test('runMaigret: boşluk içeren kullanıcı adı → error', async () => {
  const result = await runMaigret('user name')
  assert.ok(result.error?.includes('Invalid username format'))
})

test('runMaigret: noktalı virgül enjeksiyonu → error (güvenlik)', async () => {
  const result = await runMaigret('valid;rm -rf /')
  assert.ok(result.error?.includes('Invalid username format'))
})

test('runMaigret: geçerli kullanıcı adı formatı kabul ediliyor (result.username set)', async () => {
  // Python çalışmadığında hata alırız ama format geçerli olduğu için username set edilmeli
  const result = await runMaigret('octocat')
  // Geçerli format: username mevcut, ya başarı ya subprocess hatası
  assert.equal(result.username, 'octocat')
})

test('runMaigret: alt çizgi ve nokta geçerli', async () => {
  const result = await runMaigret('john_doe.99')
  assert.equal(result.username, 'john_doe.99')
})

test('runMaigret: tire geçerli', async () => {
  const result = await runMaigret('john-doe')
  assert.equal(result.username, 'john-doe')
})

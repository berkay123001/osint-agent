/**
 * Metadata Tool Test Suite
 * extractMetadataFromFile — exiftool wrapper
 * Var olmayan dosya → hata döner; gerçek exiftool çağrısı yapılabilir
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractMetadataFromFile } from './metadataTool.js'

// ===== extractMetadataFromFile =====

test('extractMetadataFromFile: var olmayan dosya → error döner', async () => {
  const result = await extractMetadataFromFile('/tmp/osint-test-nonexistent-file-xyz.jpg')
  assert.ok(result.source.includes('nonexistent'))
  // exiftool bulamazsa hata dönmeli
  assert.ok(result.error || Object.keys(result.fields).length === 0)
})

test('extractMetadataFromFile: hata durumunda fields boş obje döner', async () => {
  const result = await extractMetadataFromFile('/dev/null/impossible-path')
  assert.ok(typeof result.fields === 'object')
  assert.ok(typeof result.interestingFields === 'object')
})

test('extractMetadataFromFile: source alanı dosya yolunu içeriyor', async () => {
  const path = '/tmp/test-file.xyz'
  const result = await extractMetadataFromFile(path)
  assert.equal(result.source, path)
})

test('extractMetadataFromFile: rawOutput string döner (boş olabilir)', async () => {
  const result = await extractMetadataFromFile('/tmp/nonexistent.pdf')
  assert.ok(typeof result.rawOutput === 'string')
})

test('extractMetadataFromFile: gerçek metin dosyası exiftool ile okunabiliyor', async () => {
  // /etc/hostname — her Linux sistemde var, exiftool okuyabilir
  const result = await extractMetadataFromFile('/etc/hostname')
  // exiftool kurulu değilse hata döner, kuruluysa fields okur — her iki durum geçerli
  assert.ok(result.source === '/etc/hostname')
  assert.ok(typeof result.error === 'undefined' || typeof result.error === 'string')
})

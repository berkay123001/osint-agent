# OSINT Agent Test Kilavuzu

Bu dizin, OSINT Agent icin unit ve integration testlerini icerir.

## Test Stratejisi

| Test Turu | Dosya | Gereksinim | Sure |
|-----------|-------|------------|------|
| **Unit Test** | `*.test.ts` | Sadece Node.js | ~500ms |
| **Integration Test** | `*.integration.test.ts` | Neo4j (Docker) | ~5-10s |
| **E2E Test** | `test-e2e.ts` | Canli API'ler | ~30s-2dk |

## Hizli Baslangic

### Tum Unit Testleri Calistir
```bash
npm run test:unit
# veya
npm test
```

### Sadece Tool Testleri
```bash
npm run test:tools
```

### Belirli Bir Test
```bash
node --import tsx --test src/tools/sherlockTool.test.ts
```

## Test Dosyalari

### 1. Sherlock Tool Test
Mock `child_process.spawn` ile calisir.

Testler:
- 3 platform JSON ciktisi dogru parse ediliyor
- Bos/null URL'ler filtreleniyor
- JSON parse hatasinda text fallback
- 50 platform < 10ms isleniyor

### 2. GitHub Tool Test  
Mock `fetch` API ile calisir.

Testler:
- Profil ve email cekme
- Kullanici bulunamadi hatasi
- Fork repolar kontrol edilmiyor
- Placeholder GPG key reddediliyor

## Mock Kullanimi

Unit testler dis bagimliliklari mock'lar:
- **Sherlock** - `spawn` mock'lanir
- **GitHub** - `fetch` mock'lanir
- **Neo4j** - Integration testlerde Docker kullanilir

## Yeni Test Ekleme

1. `src/tools/yeniTool.test.ts` olustur
2. Mock pattern sec (`fetch`/`spawn`)
3. Test yaz
4. Calistir: `node --import tsx --test src/tools/yeniTool.test.ts`

## Ornek Test

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import { myTool } from './myTool.js'

test('basarili durum', async () => {
  const mockFn = createMock(...)
  const result = await myTool('input', mockFn)
  assert.equal(result.value, 'expected')
})
```

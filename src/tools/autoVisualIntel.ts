/**
 * autoVisualIntel.ts — Otomatik Görsel İstihbarat
 *
 * Kompozit araç: profil URL'si ver → avatar çıkar → tersine görsel arama yap.
 * Agent'ın manuel görsel beklemesini önler — her şeyi otomatik zincirler.
 *
 * Zincir:
 *   1. scrapeProfile(url) → avatarUrl çıkar
 *   2. DeepFace /analyze → yaş, cinsiyet, duygu analizi (container gerekli)
 *   3. searchReverseImage(avatarUrl) → Google Lens sonuçları
 *   4. (çoklu URL) DeepFace /verify → yüz eşleştirme (aynı kişi mi?)
 *   5. (çoklu URL) pHash karşılaştırması → piksel bazlı eşleşme
 */

import { scrapeProfile } from './scrapeTool.js';
import { searchReverseImage, formatReverseImageResult } from './reverseImageTool.js';
import { compareImages } from './phashCompareTool.js';
import { emitProgress } from '../lib/progressEmitter.js';
import { logger } from '../lib/logger.js';

const DEEPFACE_URL = process.env.DEEPFACE_URL || 'http://localhost:5000';

export interface VisualIntelResult {
  profileUrl: string;
  avatarUrl: string | null;
  faceAnalysis: string;
  reverseSearch: string;
  crossPlatformMatches: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// DeepFace REST API çağrıları — container çalışmıyorsa graceful fallback
// ---------------------------------------------------------------------------

interface FaceAnalysis {
  age: number;
  dominant_gender: string;
  dominant_emotion: string;
  dominant_race: string;
  region: { x: number; y: number; w: number; h: number };
}

interface FaceVerifyResult {
  verified: boolean;
  distance: number;
  model: string;
}

/** DeepFace container'ın ayakta olup olmadığını kontrol et */
async function isDeepFaceAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${DEEPFACE_URL}/`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok || res.status === 404; // 404 = sunucu ayakta ama root endpoint yok
  } catch {
    return false;
  }
}

/** DeepFace /analyze — age only (multi-model = OOM riski, age güvenilir) */
async function analyzeFace(imageUrl: string): Promise<{ analysis: string; details: FaceAnalysis | null }> {
  try {
    const res = await fetch(`${DEEPFACE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ img: imageUrl, actions: ['age'], detector_backend: 'opencv', enforce_detection: false }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      return { analysis: `⚠️ DeepFace analiz hatası (${res.status}): ${errText.slice(0, 200)}`, details: null };
    }

    const data = await res.json() as { results: FaceAnalysis[] };

    if (!data.results || data.results.length === 0) {
      return { analysis: 'ℹ️ DeepFace: Yüz tespit edilemedi', details: null };
    }

    const face = data.results[0] as any;
    const lines = [
      `👤 **Yüz Analizi (DeepFace):**`,
      `   Yaş tahmini: ~${face.age}`,
      `   Yüz güveni: %${Math.round((face.face_confidence ?? 0) * 100)}`,
      `   Yüz bölgesi: ${face.region.w}x${face.region.h}px`,
    ];

    return { analysis: lines.join('\n'), details: face };
  } catch (err) {
    return { analysis: `⚠️ DeepFace bağlantı hatası: ${(err as Error).message}`, details: null };
  }
}

/** DeepFace /verify — iki görsel arası yüz eşleştirme */
async function verifyFaces(img1: string, img2: string): Promise<string> {
  try {
    const res = await fetch(`${DEEPFACE_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        img1,
        img2,
        model_name: 'Facenet',
        detector_backend: 'opencv',
        distance_metric: 'cosine',
        enforce_detection: false,
      }),
    });

    if (!res.ok) {
      return `⚠️ DeepFace verify hatası (${res.status})`;
    }

    const data = await res.json() as FaceVerifyResult;
    const confidence = Math.max(0, (1 - data.distance) * 100).toFixed(1);

    if (data.verified) {
      return `✅ DeepFace (Facenet): **AYNI KİŞİ** — güven: %${confidence} (distance: ${data.distance.toFixed(4)})`;
    } else {
      return `❌ DeepFace (Facenet): FARKLI KİŞİ — güven: %${confidence} (distance: ${data.distance.toFixed(4)})`;
    }
  } catch (err) {
    return `⚠️ DeepFace verify hatası: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// Ana pipeline
// ---------------------------------------------------------------------------

/**
 * Tek bir profil URL'sinden görsel istihbarat üretir.
 */
async function analyzeSingleProfile(
  profileUrl: string,
  useDeepFace: boolean,
): Promise<VisualIntelResult> {
  const errors: string[] = [];
  let avatarUrl: string | null = null;
  let reverseSearch = '';
  let faceAnalysis = '';

  // --- ADIM 1: Profil sayfasını çek, avatar URL çıkar ---
  emitProgress(`🖼️ Profil çekiliyor: ${profileUrl}`);
  try {
    const scrapeResult = await scrapeProfile(profileUrl);

    if (scrapeResult.error) {
      errors.push(`Scrape hatası (${profileUrl}): ${scrapeResult.error}`);
    }

    if (scrapeResult.avatarUrl) {
      avatarUrl = scrapeResult.avatarUrl;
      emitProgress(`🖼️ Avatar bulundu: ${avatarUrl.slice(0, 80)}...`);
    } else {
      const imgMatch = scrapeResult.markdown.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      if (imgMatch) {
        avatarUrl = imgMatch[1];
        emitProgress(`🖼️ Markdown'dan avatar çıkarıldı`);
      }
    }

    if (!avatarUrl) {
      errors.push(`Avatar URL bulunamadı: ${profileUrl}`);
      return { profileUrl, avatarUrl: null, faceAnalysis: '', reverseSearch: '', crossPlatformMatches: [], errors };
    }
  } catch (err) {
    errors.push(`Scrape exception (${profileUrl}): ${(err as Error).message}`);
    return { profileUrl, avatarUrl: null, faceAnalysis: '', reverseSearch: '', crossPlatformMatches: [], errors };
  }

  // --- ADIM 2: DeepFace yüz analizi (yaş, cinsiyet, duygu) ---
  if (useDeepFace && avatarUrl) {
    emitProgress(`👤 DeepFace yüz analizi yapılıyor...`);
    const faceResult = await analyzeFace(avatarUrl);
    faceAnalysis = faceResult.analysis;
  }

  // --- ADIM 3: Tersine görsel arama (Google Lens) ---
  emitProgress(`🔍 Tersine görsel arama yapılıyor...`);
  try {
    const reverseResult = await searchReverseImage(avatarUrl);
    reverseSearch = formatReverseImageResult(reverseResult);

    if (reverseResult.totalMatches > 0) {
      emitProgress(`✅ ${reverseResult.totalMatches} görsel eşleşme bulundu`);
    } else {
      emitProgress(`ℹ️ Görsel eşleşme bulunamadı`);
    }
  } catch (err) {
    const errMsg = `Reverse search hatası: ${(err as Error).message}`;
    errors.push(errMsg);
    reverseSearch = `❌ ${errMsg}`;
    logger.warn('TOOL', `[autoVisualIntel] ${errMsg}`);
  }

  return {
    profileUrl,
    avatarUrl,
    faceAnalysis,
    reverseSearch,
    crossPlatformMatches: [],
    errors,
  };
}

/**
 * Birden fazla profil URL'si arası cross-platform karşılaştırma.
 * DeepFace /verify + pHash beraber kullanılır.
 */
async function crossPlatformCompare(
  profiles: VisualIntelResult[],
  useDeepFace: boolean,
): Promise<string[]> {
  const matches: string[] = [];
  const avatars = profiles.filter(p => p.avatarUrl);

  if (avatars.length < 2) return matches;

  emitProgress(`🔗 ${avatars.length} platform arası görsel karşılaştırma...`);

  for (let i = 0; i < avatars.length; i++) {
    for (let j = i + 1; j < avatars.length; j++) {
      const hostA = new URL(avatars[i].profileUrl).hostname.replace('www.', '');
      const hostB = new URL(avatars[j].profileUrl).hostname.replace('www.', '');

      // DeepFace yüz eşleştirme (Facenet)
      if (useDeepFace) {
        try {
          const faceResult = await verifyFaces(avatars[i].avatarUrl!, avatars[j].avatarUrl!);
          matches.push(`🧠 ${hostA} ↔ ${hostB}: ${faceResult}`);
        } catch (err) {
          logger.warn('TOOL', `[autoVisualIntel] DeepFace verify hatası: ${(err as Error).message}`);
        }
      }

      // pHash piksel karşılaştırma (fallback / ek kanıt)
      try {
        const comparison = await compareImages(avatars[i].avatarUrl!, avatars[j].avatarUrl!);
        const similarityMatch = comparison.match(/Benzerlik Oranı: %([\d.]+)/);
        const similarity = similarityMatch ? parseFloat(similarityMatch[1]) : 0;

        if (similarity >= 90) {
          matches.push(`🖼️ ${hostA} ↔ ${hostB}: pHash %${similarity.toFixed(1)} — piksel bazında aynı`);
        } else if (similarity >= 70) {
          matches.push(`🖼️ ${hostA} ↔ ${hostB}: pHash %${similarity.toFixed(1)} — benzer (crop/filtre)`);
        }
      } catch (err) {
        logger.warn('TOOL', `[autoVisualIntel] pHash hatası: ${(err as Error).message}`);
      }
    }
  }

  return matches;
}

/**
 * Ana fonksiyon — birden fazla profil URL'sinden otomatik görsel istihbarat üretir.
 */
export async function autoVisualIntel(
  profileUrls: string[],
): Promise<string> {
  const timestamp = new Date().toLocaleTimeString('tr-TR');
  const sections: string[] = [];

  // DeepFace container kontrolü
  const useDeepFace = await isDeepFaceAvailable();
  if (useDeepFace) {
    emitProgress(`🧠 DeepFace container aktif — yüz analizi yapılacak`);
  } else {
    emitProgress(`ℹ️ DeepFace container yok — sadece reverse search + pHash`);
  }

  sections.push(`## 🖼️ Otomatik Görsel İstihbarat (${timestamp})`);
  sections.push(`**Taranan profil sayısı:** ${profileUrls.length}`);
  sections.push(`**Yüz analizi:** ${useDeepFace ? 'Aktif (DeepFace/Facenet)' : 'Devre dışı (container çalışmıyor)'}\n`);

  // Her profil için ayrı ayrı analiz
  const results: VisualIntelResult[] = [];

  for (const url of profileUrls) {
    const result = await analyzeSingleProfile(url, useDeepFace);
    results.push(result);
  }

  // Bireysel sonuçlar
  for (const r of results) {
    const host = new URL(r.profileUrl).hostname.replace('www.', '');
    sections.push(`### ${host}`);

    if (r.avatarUrl) {
      sections.push(`**Avatar URL:** \`${r.avatarUrl.slice(0, 100)}\``);
    }

    if (r.faceAnalysis) {
      sections.push(r.faceAnalysis);
    }

    if (r.reverseSearch) {
      sections.push(r.reverseSearch);
    }

    if (r.errors.length > 0) {
      sections.push(`**Hatalar:**`);
      r.errors.forEach(e => sections.push(`- ${e}`));
    }

    sections.push('');
  }

  // Cross-platform karşılaştırma (DeepFace verify + pHash)
  if (results.filter(r => r.avatarUrl).length >= 2) {
    const crossMatches = await crossPlatformCompare(results, useDeepFace);
    if (crossMatches.length > 0) {
      sections.push(`### 🔗 Platformlar Arası Görsel Eşleşme`);
      crossMatches.forEach(m => sections.push(`- ${m}`));
      sections.push('');
    }
  }

  // Özet
  const withAvatar = results.filter(r => r.avatarUrl).length;
  const withErrors = results.filter(r => r.errors.length > 0).length;
  sections.push(`**Özet:** ${withAvatar}/${results.length} profilden avatar çıkarıldı` +
    (useDeepFace ? ', yüz analizi yapıldı' : '') +
    (withErrors > 0 ? `, ${withErrors} profil hatayla atlandı` : ''));

  const output = sections.join('\n');
  emitProgress(`🖼️ Görsel istihbarat tamamlandı (${output.length} char)`);
  return output;
}

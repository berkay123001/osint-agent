/**
 * autoVisualIntel.ts — Otomatik Görsel İstihbarat
 *
 * Kompozit araç: profil URL'si ver → avatar çıkar → tersine görsel arama yap.
 * Agent'ın manuel görsel beklemesini önler — her şeyi otomatik zincirler.
 *
 * Zincir:
 *   1. scrapeProfile(url) → avatarUrl çıkar
 *   2. searchReverseImage(avatarUrl) → Google Lens sonuçları
 *   3. (çoklu URL verilirse) pHash karşılaştırması → cross-platform eşleşme
 */

import { scrapeProfile } from './scrapeTool.js';
import { searchReverseImage, formatReverseImageResult } from './reverseImageTool.js';
import { compareImages } from './phashCompareTool.js';
import { emitProgress } from '../lib/progressEmitter.js';
import { logger } from '../lib/logger.js';

export interface VisualIntelResult {
  profileUrl: string;
  avatarUrl: string | null;
  reverseSearch: string;
  crossPlatformMatches: string[];
  errors: string[];
}

/**
 * Tek bir profil URL'sinden görsel istihbarat üretir.
 */
async function analyzeSingleProfile(
  profileUrl: string,
): Promise<VisualIntelResult> {
  const errors: string[] = [];
  let avatarUrl: string | null = null;
  let reverseSearch = '';

  // --- ADIM 1: Profil sayfasını çek, avatar URL çıkar ---
  emitProgress(`🖼️ Profil çekiliyor: ${profileUrl}`);
  try {
    const scrapeResult = await scrapeProfile(profileUrl);

    if (scrapeResult.error) {
      errors.push(`Scrape hatası (${profileUrl}): ${scrapeResult.error}`);
    }

    // avatarUrl scrapeTool tarafından otomatik çıkarılır
    if (scrapeResult.avatarUrl) {
      avatarUrl = scrapeResult.avatarUrl;
      emitProgress(`🖼️ Avatar bulundu: ${avatarUrl.slice(0, 80)}...`);
    } else {
      // Markdown içinden img src ara — fallback
      const imgMatch = scrapeResult.markdown.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      if (imgMatch) {
        avatarUrl = imgMatch[1];
        emitProgress(`🖼️ Markdown'dan avatar çıkarıldı`);
      }
    }

    if (!avatarUrl) {
      errors.push(`Avatar URL bulunamadı: ${profileUrl}`);
      return { profileUrl, avatarUrl: null, reverseSearch: '', crossPlatformMatches: [], errors };
    }
  } catch (err) {
    errors.push(`Scrape exception (${profileUrl}): ${(err as Error).message}`);
    return { profileUrl, avatarUrl: null, reverseSearch: '', crossPlatformMatches: [], errors };
  }

  // --- ADIM 2: Tersine görsel arama (Google Lens) ---
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
    reverseSearch,
    crossPlatformMatches: [],
    errors,
  };
}

/**
 * Birden fazla profil URL'si arası görsel karşılaştırma yapar.
 * Her platformdan avatar çeker → pHash ile benzerlik ölçer.
 */
async function crossPlatformCompare(
  profiles: VisualIntelResult[],
): Promise<string[]> {
  const matches: string[] = [];
  const avatars = profiles.filter(p => p.avatarUrl);

  if (avatars.length < 2) return matches;

  emitProgress(`🔗 ${avatars.length} platform arası görsel karşılaştırma...`);

  for (let i = 0; i < avatars.length; i++) {
    for (let j = i + 1; j < avatars.length; j++) {
      try {
        const comparison = await compareImages(avatars[i].avatarUrl!, avatars[j].avatarUrl!);

        // Benzerlik oranını çıkar
        const similarityMatch = comparison.match(/Benzerlik Oranı: %([\d.]+)/);
        const similarity = similarityMatch ? parseFloat(similarityMatch[1]) : 0;

        const hostA = new URL(avatars[i].profileUrl).hostname.replace('www.', '');
        const hostB = new URL(avatars[j].profileUrl).hostname.replace('www.', '');

        if (similarity >= 90) {
          matches.push(
            `✅ ${hostA} ↔ ${hostB}: %${similarity.toFixed(1)} benzer — aynı kişi yüksek olasılıkla`,
          );
        } else if (similarity >= 70) {
          matches.push(
            `⚠️ ${hostA} ↔ ${hostB}: %${similarity.toFixed(1)} benzer — muhtemelen aynı kişi (crop/filtre farkı)`,
          );
        } else {
          matches.push(
            `ℹ️ ${hostA} ↔ ${hostB}: %${similarity.toFixed(1)} benzer — farklı görseller`,
          );
        }
      } catch (err) {
        logger.warn('TOOL', `[autoVisualIntel] pHash karşılaştırma hatası: ${(err as Error).message}`);
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

  sections.push(`## 🖼️ Otomatik Görsel İstihbarat (${timestamp})`);
  sections.push(`**Taranan profil sayısı:** ${profileUrls.length}\n`);

  // Her profil için ayrı ayrı analiz
  const results: VisualIntelResult[] = [];

  for (const url of profileUrls) {
    const result = await analyzeSingleProfile(url);
    results.push(result);
  }

  // Bireysel sonuçlar
  for (const r of results) {
    const host = new URL(r.profileUrl).hostname.replace('www.', '');
    sections.push(`### ${host}`);

    if (r.avatarUrl) {
      sections.push(`**Avatar URL:** \`${r.avatarUrl.slice(0, 100)}\``);
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

  // Cross-platform karşılaştırma
  if (results.filter(r => r.avatarUrl).length >= 2) {
    const crossMatches = await crossPlatformCompare(results);
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
    (withErrors > 0 ? `, ${withErrors} profil hatayla atlandı` : ''));

  const output = sections.join('\n');
  emitProgress(`🖼️ Görsel istihbarat tamamlandı (${output.length} char)`);
  return output;
}

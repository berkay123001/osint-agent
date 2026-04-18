/**
 * autoVisualIntel.ts — Automated Visual Intelligence
 *
 * Composite tool: provide a profile URL → extract avatar → run reverse image search.
 * Prevents the agent from waiting for manual image steps — chains everything automatically.
 *
 * Zincir:
 *   1. scrapeProfile(url) → extract avatarUrl
 *   2. DeepFace /analyze → age, gender, emotion analysis (container required)
 *   3. searchReverseImage(avatarUrl) → Google Lens results
 *   4. (multi-URL) DeepFace /verify → face matching (same person?)
 *   5. (multi-URL) pHash comparison → pixel-level match
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
// DeepFace REST API calls — graceful fallback if container is unavailable
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

/** Check whether the DeepFace container is running */
async function isDeepFaceAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${DEEPFACE_URL}/`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok || res.status === 404; // 404 = server is running but has no root endpoint
  } catch {
    return false;
  }
}

/** DeepFace /analyze — age only (multi-model = OOM risk; age is reliable) */
async function analyzeFace(imageUrl: string): Promise<{ analysis: string; details: FaceAnalysis | null }> {
  try {
    const res = await fetch(`${DEEPFACE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ img: imageUrl, actions: ['age'], detector_backend: 'opencv', enforce_detection: false }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      return { analysis: `⚠️ DeepFace analysis error (${res.status}): ${errText.slice(0, 200)}`, details: null };
    }

    const data = await res.json() as { results: FaceAnalysis[] };

    if (!data.results || data.results.length === 0) {
      return { analysis: 'ℹ️ DeepFace: No face detected', details: null };
    }

    const face = data.results[0] as any;
    const lines = [
      `👤 **Face Analysis (DeepFace):**`,
      `   Age estimate: ~${face.age}`,
      `   Face confidence: ${Math.round((face.face_confidence ?? 0) * 100)}`,
      `   Face region: ${face.region.w}x${face.region.h}px`,
    ];

    return { analysis: lines.join('\n'), details: face };
  } catch (err) {
    return { analysis: `⚠️ DeepFace connection error: ${(err as Error).message}`, details: null };
  }
}

/** DeepFace /verify — face matching between two images */
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
      return `⚠️ DeepFace verify error (${res.status})`;
    }

    const data = await res.json() as FaceVerifyResult;
    const confidence = Math.max(0, (1 - data.distance) * 100).toFixed(1);

    if (data.verified) {
      return `✅ DeepFace (Facenet): **SAME PERSON** — confidence: ${confidence} (distance: ${data.distance.toFixed(4)})`;
    } else {
      return `❌ DeepFace (Facenet): DIFFERENT PERSON — confidence: ${confidence} (distance: ${data.distance.toFixed(4)})`;
    }
  } catch (err) {
    return `⚠️ DeepFace verify error: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// Ana pipeline
// ---------------------------------------------------------------------------

/**
 * Generates visual intelligence from a single profile URL.
 */
async function analyzeSingleProfile(
  profileUrl: string,
  useDeepFace: boolean,
): Promise<VisualIntelResult> {
  const errors: string[] = [];
  let avatarUrl: string | null = null;
  let reverseSearch = '';
  let faceAnalysis = '';

  // --- STEP 1: Fetch profile page, extract avatar URL ---
  emitProgress(`🖼️ Fetching profile: ${profileUrl}`);
  try {
    const scrapeResult = await scrapeProfile(profileUrl);

    if (scrapeResult.error) {
      errors.push(`Scrape error (${profileUrl}): ${scrapeResult.error}`);
    }

    if (scrapeResult.avatarUrl) {
      avatarUrl = scrapeResult.avatarUrl;
      emitProgress(`🖼️ Avatar bulundu: ${avatarUrl.slice(0, 80)}...`);
    } else {
      const imgMatch = scrapeResult.markdown.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      if (imgMatch) {
        avatarUrl = imgMatch[1];
        emitProgress(`🖼️ Avatar extracted from Markdown`);
      }
    }

    if (!avatarUrl) {
      errors.push(`Avatar URL not found: ${profileUrl}`);
      return { profileUrl, avatarUrl: null, faceAnalysis: '', reverseSearch: '', crossPlatformMatches: [], errors };
    }
  } catch (err) {
    errors.push(`Scrape exception (${profileUrl}): ${(err as Error).message}`);
    return { profileUrl, avatarUrl: null, faceAnalysis: '', reverseSearch: '', crossPlatformMatches: [], errors };
  }

  // --- STEP 2: DeepFace face analysis (age, gender, emotion) ---
  if (useDeepFace && avatarUrl) {
    emitProgress(`👤 Running DeepFace face analysis...`);
    const faceResult = await analyzeFace(avatarUrl);
    faceAnalysis = faceResult.analysis;
  }

  // --- STEP 3: Reverse image search (Google Lens) ---
  emitProgress(`🔍 Running reverse image search...`);
  try {
    const reverseResult = await searchReverseImage(avatarUrl);
    reverseSearch = formatReverseImageResult(reverseResult);

    if (reverseResult.totalMatches > 0) {
      emitProgress(`✅ ${reverseResult.totalMatches} visual match(es) found`);
    } else {
      emitProgress(`ℹ️ No visual matches found`);
    }
  } catch (err) {
    const errMsg = `Reverse search error: ${(err as Error).message}`;
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
 * Cross-platform comparison across multiple profile URLs.
 * Uses DeepFace /verify + pHash together.
 */
async function crossPlatformCompare(
  profiles: VisualIntelResult[],
  useDeepFace: boolean,
): Promise<string[]> {
  const matches: string[] = [];
  const avatars = profiles.filter(p => p.avatarUrl);

  if (avatars.length < 2) return matches;

  emitProgress(`🔗 Cross-platform visual comparison for ${avatars.length} profiles...`);

  for (let i = 0; i < avatars.length; i++) {
    for (let j = i + 1; j < avatars.length; j++) {
      const hostA = new URL(avatars[i].profileUrl).hostname.replace('www.', '');
      const hostB = new URL(avatars[j].profileUrl).hostname.replace('www.', '');

      // DeepFace face matching (Facenet)
      if (useDeepFace) {
        try {
          const faceResult = await verifyFaces(avatars[i].avatarUrl!, avatars[j].avatarUrl!);
          matches.push(`🧠 ${hostA} ↔ ${hostB}: ${faceResult}`);
        } catch (err) {
          logger.warn('TOOL', `[autoVisualIntel] DeepFace verify error: ${(err as Error).message}`);
        }
      }

      // pHash pixel comparison (fallback / additional evidence)
      try {
        const comparison = await compareImages(avatars[i].avatarUrl!, avatars[j].avatarUrl!);
        const similarityMatch = comparison.match(/Similarity: ([\d.]+)%/);
        const similarity = similarityMatch ? parseFloat(similarityMatch[1]) : 0;

        if (similarity >= 90) {
          matches.push(`🖼️ ${hostA} ↔ ${hostB}: pHash %${similarity.toFixed(1)} — pixel-for-pixel identical`);
        } else if (similarity >= 70) {
          matches.push(`🖼️ ${hostA} ↔ ${hostB}: pHash %${similarity.toFixed(1)} — similar (crop/filter)`);
        }
      } catch (err) {
        logger.warn('TOOL', `[autoVisualIntel] pHash error: ${(err as Error).message}`);
      }
    }
  }

  return matches;
}

/**
 * Main function — generates automated visual intelligence from multiple profile URLs.
 */
export async function autoVisualIntel(
  profileUrls: string[],
): Promise<string> {
  const timestamp = new Date().toLocaleTimeString('en-US');
  const sections: string[] = [];

  // DeepFace container check
  const useDeepFace = await isDeepFaceAvailable();
  if (useDeepFace) {
    emitProgress(`🧠 DeepFace container active — face analysis enabled`);
  } else {
    emitProgress(`ℹ️ DeepFace container unavailable — reverse search + pHash only`);
  }

  sections.push(`## 🖼️ Automated Visual Intelligence (${timestamp})`);
  sections.push(`**Profiles scanned:** ${profileUrls.length}`);
  sections.push(`**Face analysis:** ${useDeepFace ? 'Active (DeepFace/Facenet)' : 'Disabled (container not running)'}\n`);

  // Analyse each profile individually
  const results: VisualIntelResult[] = [];

  for (const url of profileUrls) {
    const result = await analyzeSingleProfile(url, useDeepFace);
    results.push(result);
  }

  // Individual results
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
      sections.push(`**Errors:**`);
      r.errors.forEach(e => sections.push(`- ${e}`));
    }

    sections.push('');
  }

  // Cross-platform comparison (DeepFace verify + pHash)
  if (results.filter(r => r.avatarUrl).length >= 2) {
    const crossMatches = await crossPlatformCompare(results, useDeepFace);
    if (crossMatches.length > 0) {
      sections.push(`### 🔗 Cross-Platform Visual Match`);
      crossMatches.forEach(m => sections.push(`- ${m}`));
      sections.push('');
    }
  }

  // Summary
  const withAvatar = results.filter(r => r.avatarUrl).length;
  const withErrors = results.filter(r => r.errors.length > 0).length;
  sections.push(`**Summary:** ${withAvatar}/${results.length} profile(s) had avatars extracted` +
    (useDeepFace ? ', face analysis performed' : '') +
    (withErrors > 0 ? `, ${withErrors} profile(s) skipped due to errors` : ''));

  const output = sections.join('\n');
  emitProgress(`🖼️ Visual intelligence complete (${output.length} char)`);
  return output;
}

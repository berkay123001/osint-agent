import { fetchAndHashImage } from './imageHasher.js'
import * as levenshtein from 'fast-levenshtein';

export async function compareImages(url1: string, url2: string): Promise<string> {
  try {
    const hash1Info: any = await fetchAndHashImage(url1);
    const hash2Info: any = await fetchAndHashImage(url2);

    if (!hash1Info || !hash2Info) {
      return "❌ One or both images could not be processed. Check the URLs.";
    }

    // It returns the string directly, not an object with a hash property
    const hash1 = typeof hash1Info === 'string' ? hash1Info : hash1Info.hash;
    const hash2 = typeof hash2Info === 'string' ? hash2Info : hash2Info.hash;

    if (!hash1 || !hash2) {
         return "❌ Hash could not be generated.";
    }

    // fix for default export format in fast-levenshtein
    const distance: any = (levenshtein as any).get || (levenshtein as any).default?.get;
    if (!distance) throw new Error("Levenshtein module could not be loaded");

    const diff = distance(hash1, hash2);
    
    const maxLen = Math.max(hash1.length, hash2.length);
    const similarity = ((maxLen - diff) / maxLen) * 100;

    let conclusion = "";
    if (diff === 0) {
      conclusion = "🔴 EXACT MATCH: Both images are pixel-for-pixel identical. (Indicator of disinformation reuse)";
    } else if (diff <= 10) {
      conclusion = "🟠 HIGH SIMILARITY: Images are likely the same but one may be cropped/filtered.";
    } else {
      conclusion = "🟢 DIFFERENT: The two images are unrelated.";
    }

    return `🔍 Visual Forensics Report (Algorithmic pHash Analysis):
- Image 1 Hash: ${hash1}
- Image 2 Hash: ${hash2}
- Distance Score: ${diff}
- Similarity: ${similarity.toFixed(2)}%
${conclusion}`;

  } catch (e: any) {
    return `❌ Comparison Error: ${e.message}`;
  }
}

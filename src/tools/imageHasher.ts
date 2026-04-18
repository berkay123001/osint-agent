import Jimp from 'jimp';

export async function fetchAndHashImage(url: string): Promise<string | null> {
  try {
    const image = await Jimp.read(url);
    // Returns a 64-character binary (perceptual) hash in base 2
    return image.hash(2);
  } catch {
    return null;
  }
}

/**
 * Computes the Hamming distance between two perceptual hashes (64-bit strings).
 * @returns A number from 0 to 64. 0 = exact match, < 10 = very likely the same image.
 */
export function calculateHammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== 64 || hash2.length !== 64) return 64;
  let diff = 0;
  for (let i = 0; i < 64; i++) {
    if (hash1[i] !== hash2[i]) diff++;
  }
  return diff;
}

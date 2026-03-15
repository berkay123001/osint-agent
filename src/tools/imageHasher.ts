import Jimp from 'jimp';

export async function fetchAndHashImage(url: string): Promise<string | null> {
  try {
    const image = await Jimp.read(url);
    // 2 tabanıyla 64 karakterli binary (perceptual) hash döndürür
    return image.hash(2);
  } catch {
    return null;
  }
}

/**
 * İki perceptual hash (64-bit string) arasındaki Hamming mesafesini hesaplar.
 * @returns 0 ile 64 arası bir sayı. 0 tam eşleşme, < 10 büyük olasılıkla aynı resim.
 */
export function calculateHammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== 64 || hash2.length !== 64) return 64;
  let diff = 0;
  for (let i = 0; i < 64; i++) {
    if (hash1[i] !== hash2[i]) diff++;
  }
  return diff;
}

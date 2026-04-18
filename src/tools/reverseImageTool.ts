/**
 * Reverse Image Search Tool
 * Uses SerpAPI (Google Lens) to find where and when an image first appeared online.
 * Used for disinformation detection, fact-checking, and OSINT image tracking.
 */

export interface ReverseImageResult {
  imageUrl: string;
  totalMatches: number;
  bestMatches: Array<{
    title: string;
    link: string;
    source: string;
    thumbnail?: string;
  }>;
  error?: string;
}

export async function searchReverseImage(imageUrl: string): Promise<ReverseImageResult> {
  const apiKey = process.env.SERP_API_KEY;
  
  if (!apiKey) {
    return {
      imageUrl,
      totalMatches: 0,
      bestMatches: [],
      error: "SERPAPI_API_KEY not found. Please add it to .env.",
    };
  }

  const url = new URL("https://serpapi.com/search");
  url.searchParams.append("engine", "google_lens");
  url.searchParams.append("url", imageUrl);
  url.searchParams.append("api_key", apiKey);

  try {
    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.error) {
      return {
        imageUrl,
        totalMatches: 0,
        bestMatches: [],
        error: `SerpApi error: ${data.error}`,
      };
    }

    const visualMatches = data.visual_matches || [];
    
    // Take only the top 5 most consistent results (sufficient for fact-checking)
    const mappedMatches = visualMatches.slice(0, 5).map((match: any) => ({
      title: match.title || "Untitled",
      link: match.link || "",
      source: match.source || "Bilinmeyen Kaynak",
      thumbnail: match.thumbnail
    }));

    return {
      imageUrl,
      totalMatches: visualMatches.length,
      bestMatches: mappedMatches,
    };
    
  } catch (error) {
    return {
      imageUrl,
      totalMatches: 0,
      bestMatches: [],
      error: `Request failed: ${(error as Error).message}`,
    };
  }
}

export function formatReverseImageResult(result: ReverseImageResult): string {
  if (result.error) {
    return `❌ Reverse Image Search Error: ${result.error}`;
  }

  if (result.totalMatches === 0) {
    return `ℹ️ Google Lens found no prior trace of this image online. It may be an original/unique photo.`;
  }

  const lines = [
    `🔍 Visual Analysis (Google Lens) Complete!`,
    `📸 Searched Image: ${result.imageUrl}`,
    `🧩 Total Matching Sources: ${result.totalMatches}`,
    `\n🚨 **En Eski / En Benzer Kaynaklar:**`
  ];

  result.bestMatches.forEach((match, index) => {
    lines.push(`\n[${index + 1}] Title: ${match.title}`);
    lines.push(`    Kaynak Site: ${match.source}`);
    lines.push(`    Link: ${match.link}`);
  });

  lines.push(`\n🤖 **Ajan Yönergesi:** Yukarıdaki kaynak web sitelerine ve başlıklarına bak. Eğer fotoğraf kullanıcının iddia ettiği olaydan alakasız bir olayı (örneğin eski bir depremi, başka bir ülkedeki patlamayı) anlatıyorsa, bunun bir 'Dezenformasyon' (Yalan Haber) olduğunu tespit et.`);

  return lines.join("\n");
}

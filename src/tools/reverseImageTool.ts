/**
 * Tersine Görsel Arama Aracı (Reverse Image Search)
 * SerpAPI (Google Lens Motoru) kullanarak görselin internette ilk nerede ve ne zaman çıktığını bulur.
 * Dezenformasyon, fact-checking ve OSINT görsel takibi için kullanılır.
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
      error: "SERPAPI_API_KEY bulunamadı. Lütfen .env dosyasına ekleyin.",
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
        error: `SerpApi Hatası: ${data.error}`,
      };
    }

    const visualMatches = data.visual_matches || [];
    
    // Gelen sonuçlardan sadece en tutarlı ilk 5 sonucu (fact-checking için yeterli) al
    const mappedMatches = visualMatches.slice(0, 5).map((match: any) => ({
      title: match.title || "Adsız Başlık",
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
      error: `İstek başarısız oldu: ${(error as Error).message}`,
    };
  }
}

export function formatReverseImageResult(result: ReverseImageResult): string {
  if (result.error) {
    return `❌ Tersine Görsel Arama Hatası: ${result.error}`;
  }

  if (result.totalMatches === 0) {
    return `ℹ️ Google Lens bu görsel için internette geçmiş bir iz bulamadı. Orijinal/Özgün bir fotoğraf olabilir.`;
  }

  const lines = [
    `🔍 Görsel Analiz (Google Lens) Tamamlandı!`,
    `📸 Aranan Görsel: ${result.imageUrl}`,
    `🧩 Toplam Eşleşen Kaynak Sayısı: ${result.totalMatches}`,
    `\n🚨 **En Eski / En Benzer Kaynaklar:**`
  ];

  result.bestMatches.forEach((match, index) => {
    lines.push(`\n[${index + 1}] Başlık: ${match.title}`);
    lines.push(`    Kaynak Site: ${match.source}`);
    lines.push(`    Bağlantı: ${match.link}`);
  });

  lines.push(`\n🤖 **Ajan Yönergesi:** Yukarıdaki kaynak web sitelerine ve başlıklarına bak. Eğer fotoğraf kullanıcının iddia ettiği olaydan alakasız bir olayı (örneğin eski bir depremi, başka bir ülkedeki patlamayı) anlatıyorsa, bunun bir 'Dezenformasyon' (Yalan Haber) olduğunu tespit et.`);

  return lines.join("\n");
}

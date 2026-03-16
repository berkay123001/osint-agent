import { getDriver } from './neo4j.js';

export interface FactCheckData {
  claimId: string;
  claimText: string;
  source: string;
  claimDate: string;
  verdict: 'YALAN' | 'DOĞRU' | 'ŞÜPHELİ';
  truthExplanation: string;
  imageUrl?: string;
  tags?: string[];
}

export async function writeFactCheckToGraph(data: FactCheckData): Promise<void> {
  const driver = (await import('./neo4j.js')).getDriver(); // We will patch neo4j to export getDriver
  const session = driver.session();
  try {
    const query = `
      // 1. İddia Düğümü (Claim)
      MERGE (c:Claim {id: $claimId})
      SET c.text = $claimText, 
          c.date = $claimDate,
          c.createdAt = timestamp()

      // 2. Kaynak Düğümü (Source - Haber Sitesi, Twitter vs.)
      MERGE (s:Source {name: $source})
      MERGE (s)-[:YAYINLADI]->(c)

      // 3. Karar/Doğrulama Düğümü (Verdict/Fact)
      MERGE (f:Fact {id: $claimId + "_fact"})
      SET f.verdict = $verdict,
          f.explanation = $truthExplanation
      
      MERGE (f)-[:ANALİZ_ETTİ]->(c)

      // 4. Görseller
      WITH c, $imageUrl AS img
      CALL {
        WITH c, img
        WITH c, img WHERE img IS NOT NULL
        MERGE (i:Image {url: img})
        MERGE (c)-[:GÖRSEL_İÇERİR]->(i)
        RETURN count(i) as r
      }
      
      // 5. Etiketler (Tags)
      WITH c, $tags AS tagsList
      UNWIND tagsList AS tagName
      MERGE (t:Tag {name: tagName})
      MERGE (c)-[:ETİKETLENDİ]->(t)
    `;

    await session.run(query, data);
    console.log(`[Neo4j] Fact-Check verisi grafiğe yazıldı: ${data.claimId}`);
  } catch (error) {
    console.error(`[Neo4j Hatası] Graph'a yazılamadı:`, error);
  } finally {
    await session.close();
  }
}

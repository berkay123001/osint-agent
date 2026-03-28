import { getDriver } from './neo4j.js';
import { logger } from './logger.js';

export interface FactCheckData {
  claimId: string;
  claimText: string;
  source: string;
  claimDate: string;
  verdict: 'FALSE' | 'TRUE' | 'UNVERIFIED';
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
      MERGE (s)-[:PUBLISHED]->(c)

      // 3. Karar/Doğrulama Düğümü (Verdict/Fact)
      MERGE (f:Fact {id: $claimId + "_fact"})
      SET f.verdict = $verdict,
          f.explanation = $truthExplanation
      
      MERGE (f)-[:ANALYZED]->(c)

      // 4. Görseller
      WITH c, $imageUrl AS img
      CALL {
        WITH c, img
        WITH c, img WHERE img IS NOT NULL
        MERGE (i:Image {url: img})
        MERGE (c)-[:CONTAINS_IMAGE]->(i)
        RETURN count(i) as r
      }
      
      // 5. Etiketler (Tags)
      WITH c, $tags AS tagsList
      UNWIND tagsList AS tagName
      MERGE (t:Tag {name: tagName})
      MERGE (c)-[:TAGGED_WITH]->(t)
    `;

    await session.run(query, {
      ...data,
      tags: data.tags || [],
      imageUrl: data.imageUrl || null
    });
    logger.info('GRAPH', `Fact-Check data written: ${data.claimId}`);
  } catch (error) {
    logger.error('GRAPH', 'Failed to write fact-check data', { error });
  } finally {
    await session.close();
  }
}

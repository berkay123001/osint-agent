import 'dotenv/config';
import { writeFactCheckToGraph } from './src/lib/neo4jFactCheck.js';

async function testGraph() {
  console.log("Mocking a fake news fact-check run to Neo4j...");
  
  await writeFactCheckToGraph({
    claimId: "tw_iran_patlama_001",
    claimText: "İran nükleer tesisinde büyük patlama! Mossad vurdu!",
    source: "Twitter @AnonimHaberX",
    claimDate: "2026-03-16",
    verdict: "YALAN",
    truthExplanation: "Ajanımız bu görseli inceledi. Orijinal fotoğraf 2020 Beirut patlamasına aittir. Kriptografik (pHaşh) eşleşme %100.",
    imageUrl: "https://example.com/fake_iran_explosion.jpg",
    tags: ["Ortadoğu", "Dezenformasyon", "Yapayzeka/Manipülasyon"]
  });

  console.log("\n✅ Test başarılı. Neo4j Browser'ı aç (http://localhost:7474) ve şu sorguyu çalıştır:");
  console.log("MATCH (c:Claim {id: 'tw_iran_patlama_001'})-[r]-(n) RETURN c,r,n");
  
  process.exit(0);
}

testGraph();

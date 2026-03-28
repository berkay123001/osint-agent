import { ai } from '../lib/ai.js';
import { z } from 'zod';
import { writeFactCheckToGraph } from '../lib/neo4jFactCheck.js';

export const factCheckGraphTool = ai.defineTool(
  {
    name: 'factCheckGraphTool',
    description: 'Şüpheli bir iddia (Claim) ile ilgili yapılan Doğruluk Kontrolü (Fact-Check) sonucunu Neo4j veritabanına bir ağ (Graph) olarak kaydeder. İddiayı, kaynağı, görseli ve gerçekleri birbirine bağlar.',
    inputSchema: z.object({
      claimId: z.string().describe('İddia için benzersiz bir ID. Örnek: tw_iran_001'),
      claimText: z.string().describe('Şüpheli iddianın veya haberin tam metni'),
      source: z.string().describe('İddianın yayıldığı yer (Örn: Twitter, ŞokHaber.com vs.)'),
      claimDate: z.string().describe('İddianın tarihi (YYYY-MM-DD vs.)'),
      verdict: z.enum(['FALSE', 'TRUE', 'UNVERIFIED']).describe('Analiz sonucunda verilen karar (FALSE=yalan, TRUE=doğru, UNVERIFIED=şüpheli)'),
      truthExplanation: z.string().describe('Kararın detayı (Neden yalan, orijinal görsel ne vs.)'),
      imageUrl: z.string().optional().describe('İddiada kullanılan ana görselin URL si'),
      tags: z.array(z.string()).optional().describe('Kategoriler (Dezenformasyon, Siyaset, Oltalama vb.)')
    }),
    outputSchema: z.string(),
  },
  async (data) => {
    try {
      await writeFactCheckToGraph(data);
      return `✅ Fact-Check sonucu Neo4j Veri Grafiğine başarıyla kaydedildi! (Claim ID: ${data.claimId})`;
    } catch (e: any) {
      return `❌ Graph kaydetme hatası: ${e.message}`;
    }
  }
);

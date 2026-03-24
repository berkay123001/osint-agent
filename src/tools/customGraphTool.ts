import { z } from 'zod'
import { ai } from '../lib/ai.js'
import { getDriver } from '../lib/neo4j.js'

// Güvenlik: Sadece harf, rakam ve alt çizgiye izin verir
// Cypher injection riskini sıfırlar
function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '')
}

export const addCustomNodeTool = ai.defineTool(
  {
    name: 'add_custom_node',
    description: 'Neo4j graf veritabanına özel (custom) bir düğüm (node) ekler. Standart OSINT nesneleri (Username, Email vb.) dışındaki bulguları (ör: CryptoWallet, Malware, IPAddress, ThreatActor) kaydetmek için kullanılır. Etiketleri CamelCase kullanın.',
    inputSchema: z.object({
      label: z.string().describe('Düğümün tipi (Örn: CryptoWallet, Malware, IPAddress, Tweet)'),
      properties: z.record(z.string()).describe('Düğüme ait özellikler (Key-value şeklinde, tüm değerler string olmalı. Örn: { address: "0x...", balance: "0" })')
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      nodeId: z.number().optional()
    })
  },
  async (input) => {
    try {
      const driver = getDriver()
      const session = driver.session()
      
      const safeLabel = sanitizeLabel(input.label)
      if (!safeLabel) {
        return { success: false, message: 'Geçersiz etiket (label) formatı. Sadece harf, rakam ve alt çizgi kullanın.' }
      }

      // Özelliklere updatedAt ekleyelim
      const props = { ...input.properties, updatedAt: new Date().toISOString() }

      // Cypher injection korumalı şekilde property set etme
      // Label dışarıdan parametre olarak alınamadığı için sanitizer kullanıldı
      const query = `
        CREATE (n:${safeLabel})
        SET n += $props
        RETURN id(n) as nodeId
      `

      try {
        const result = await session.run(query, { props })
        const nodeId = result.records[0].get('nodeId').toNumber()
        
        return {
          success: true,
          message: `Başarıyla oluşturuldu: (${safeLabel}) ID: ${nodeId}`,
          nodeId
        }
      } finally {
        await session.close()
      }
    } catch (error) {
      console.error('add_custom_node hatası:', error)
      return { success: false, message: `DB Hatası: ${(error as Error).message}` }
    }
  }
)

export const deleteCustomNodeTool = ai.defineTool(
  {
    name: 'delete_custom_node',
    description: 'Graph veritabanından yanlış eklenmiş veya gereksiz bir düğümü ID veya özellik bazlı olarak siler. Tüm ilişkileriyle birlikte silineceğini unutmayın.',
    inputSchema: z.object({
      label: z.string().describe('Silinecek düğümün etiketi (Örn: CryptoWallet)'),
      matchKey: z.string().describe('Arama yapılacak özellik anahtarı (Örn: address)'),
      matchValue: z.string().describe('Arama yapılacak özellik değeri (Örn: 0x123...)')
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      deletedCount: z.number()
    })
  },
  async (input) => {
    try {
      const driver = getDriver()
      const session = driver.session()
      
      const safeLabel = sanitizeLabel(input.label)
      
      // Güvenlik için DETACH DELETE kullanıyoruz, böylece ilişkili olan nodeların ilişkileri de silinir.
      const query = `
        MATCH (n:${safeLabel})
        WHERE n[$matchKey] = $matchValue
        WITH n
        DETACH DELETE n
        RETURN count(n) as deletedCount
      `

      try {
        const result = await session.run(query, { 
          matchKey: input.matchKey,
          matchValue: input.matchValue
        })
        
        const count = result.records[0]?.get('deletedCount')?.toNumber() || 0
        
        return {
          success: true,
          message: count > 0 ? `${count} adet düğüm (ve bağlı ilişkileri) başarıyla silindi.` : `Eşleşen düğüm bulunamadı.`,
          deletedCount: count
        }
      } finally {
        await session.close()
      }
    } catch (error) {
      console.error('delete_custom_node hatası:', error)
      return { success: false, message: `DB Hatası: ${(error as Error).message}`, deletedCount: 0 }
    }
  }
)

export const addCustomRelationshipTool = ai.defineTool(
  {
    name: 'add_custom_relationship',
    description: 'Graf veritabanındaki iki nesne arasına özel bir ilişki (Örn: OWNS, DISTRIBUTES, INTERACTED_WITH) ekler.',
    inputSchema: z.object({
      sourceLabel: z.string().describe('Kaynak düğümün etiketi. (Örn: Username)'),
      sourceKey: z.string().describe('Kaynak düğümü bulmak için özellik. (Örn: value)'),
      sourceValue: z.string().describe('Kaynak düğümü bulmak için değer. (Örn: wgodbarrelv4)'),
      targetLabel: z.string().describe('Hedef düğümün etiketi. (Örn: Malware)'),
      targetKey: z.string().describe('Hedef düğümü bulmak için özellik. (Örn: name)'),
      targetValue: z.string().describe('Hedef düğümü bulmak için değer. (Örn: Vidar)'),
      relationshipType: z.string().describe('İlişki tipi (Büyük Harfli olmalı Örn: DISTRIBUTES, OWNED_BY, SENT_TO)')
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string()
    })
  },
  async (input) => {
    try {
      const driver = getDriver()
      const session = driver.session()
      
      const sourceLabel = sanitizeLabel(input.sourceLabel)
      const targetLabel = sanitizeLabel(input.targetLabel)
      const relType = sanitizeLabel(input.relationshipType.toUpperCase())

      if (!sourceLabel || !targetLabel || !relType) {
        return { success: false, message: 'Geçersiz etiket formatları tespit edildi.' }
      }

      const query = `
        MATCH (a:${sourceLabel}) WHERE a[$sourceKey] = $sourceValue
        MATCH (b:${targetLabel}) WHERE b[$targetKey] = $targetValue
        MERGE (a)-[r:${relType}]->(b)
        SET r.updatedAt = date()
        RETURN a, r, b
      `

      try {
        const result = await session.run(query, {
          sourceKey: input.sourceKey,
          sourceValue: input.sourceValue,
          targetKey: input.targetKey,
          targetValue: input.targetValue
        })
        
        if (result.records.length === 0) {
           return { success: false, message: 'İlişki oluşturulamadı. Kaynak veya Hedef düğümlerden biri (veya ikisi) bulunamadı. Lütfen önce düğümlerin var olduğundan emin olun.' }
        }

        return {
          success: true,
          message: `Bağlantı başarıyla kuruldu: (${sourceLabel}) -[${relType}]-> (${targetLabel})`
        }
      } finally {
        await session.close()
      }
    } catch (error) {
      console.error('add_custom_relationship hatası:', error)
      return { success: false, message: `DB Hatası: ${(error as Error).message}` }
    }
  }
)

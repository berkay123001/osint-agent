import { ai } from '../lib/ai.js';
import { z } from 'zod';
import { compareImages } from './phashCompareTool.js';

export const phashCompareTool = ai.defineTool(
  {
    name: 'phashCompareTool',
    description: 'İki görselin perceptual hash (pHash) değerlerini karşılaştırarak kriptografik olarak benzerliklerini (Levenshtein Threshold) ölçer. Bir haberdeki görselin başka bir bağlamdaki fotoğrafla aynı olup olmadığını bulmak ve dezenformasyonu kanıtlamak için kullanılır.',
    inputSchema: z.object({
      url1: z.string().describe('Birinci görselin tam URLsi (örnek: iddia edilen yalan haber fotoğrafı)'),
      url2: z.string().describe('Karşılaştırma yapılacak ikinci görselin tam URLsi (örnek: gerçek/eski kaynak fotoğrafı)'),
    }),
    outputSchema: z.string(),
  },
  async ({ url1, url2 }) => {
    return compareImages(url1, url2);
  }
);

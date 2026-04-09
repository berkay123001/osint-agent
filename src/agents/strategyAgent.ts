import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { logger } from '../lib/logger.js';
import { emitProgress } from '../lib/progressEmitter.js';

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const STRATEGY_MODEL = 'deepseek/deepseek-v3.2-speciale';

/**
 * Strategy Agent — sub-agent çalışmadan önce plan, çalıştıktan sonra review yapar.
 * Tool çağırmaz, sadece derin düşünür. Supervisor'dan farkı:
 * - Supervisor: genel koordinasyon, routing, rapor
 * - Strategy: taktiksel planlama, sub-agent'a yol çizme, sonuç denetleme
 */

const PLANNING_PROMPT = `Sen bir OSINT Strateji Uzmanısın. Görevin: araştırma hedefine göre sub-agent'a detaylı bir araştırma planı yazmak.

Plan yazarken dikkat et:
1. Hedef kişinin/ipucunun ne olduğunu analiz et — hangi bilgiler zaten biliniyor, hangileri eksik
2. Hangi araçların hangi sırayla kullanılması gerektiğini belirle
3. Username varyasyon stratejisi — isimden olası hangi handle'lar türetilmeli
4. Beklenen tuzaklar — boş profiller, yanlış kişi eşleşmesi, login ekranları
5. Doğrulama kriterleri — hangi bulgular "doğrulandı" sayılabilir
6. Önceliklendirme — en değerli bilgiye önce ulaş

Plan kısa ve net olsun — sub-agent bunu context olarak alacak. Madde madde yaz.`;

const REVIEW_PROMPT = `Sen bir OSINT Kalite Denetçisisin. Sub-agent'ın araştırma sonuçlarını inceliyorsun.

Kontrol listesi:
1. **Veri doğruluğu**: Tool çıktısında olmayan bilgi raporda var mı? (hallucination)
2. **Sayılar**: Repo/follower/sayılar tool çıktısıyla eşleşiyor mu?
3. **Kişi eşleşmesi**: Bulunan profiller gerçekten hedef kişiye mi ait? İsim/kanıt uyumu var mı?
4. **Login/hata durumu**: Erişilemeyen profiller "incelendi" olarak sunulmuş mu?
5. **Kanıtsız bağlantılar**: İki profil arasında somut kanıt olmadan "aynı kişi" denmiş mi?
6. **Eksik araştırma**: Gözden kaçırılmış bariz platformlar veya username varyasyonları var mı?

Eğer sorun bulursan:
- Hangi bilginin yanlış/şüpheli olduğunu açıkla
- Doğrusunun ne olması gerektiğini söyle
- Ek kontrol öner (hangi araçla ne yapılmalı)

Eğer sonuç temizse: "SONUÇ TEMİZ — onaylıyorum" yaz ve kısa bir özet ver.`;

/**
 * Sub-agent çalışmadan önce stratejik plan oluştur
 */
export async function createStrategyPlan(
  agentType: 'identity' | 'media' | 'academic',
  query: string,
  context?: string,
): Promise<string> {
  emitProgress(`🧠 Strategy Agent planlıyor (${agentType})...`);

  const agentDescriptions: Record<string, string> = {
    identity: 'Kimlik OSINT — username/email/profil araştırması. Araçları: search_person, run_sherlock, run_maigret, nitter_profile, scrape_profile, verify_profiles, web_fetch, cross_reference, run_github_osint, check_email_registrations, check_breaches, verify_claim',
    media: 'Medya doğrulama — görsel/haber/fact-check. Araçları: reverse_image_search, extract_metadata, compare_images_phash, fact_check_to_graph, web_fetch, scrape_profile, verify_claim',
    academic: 'Akademik araştırma — makale/yazar/intihal. Araçları: search_academic_papers, search_researcher_papers, check_plagiarism, web_fetch, scrape_profile, wayback_search, query_graph',
  };

  try {
    const response = (await client.chat.completions.create({
      model: STRATEGY_MODEL,
      messages: [
        { role: 'system', content: PLANNING_PROMPT },
        {
          role: 'user',
          content: `Agent tipi: ${agentType}\nAgent yetenekleri: ${agentDescriptions[agentType]}\n\nAraştırma görevi: ${query}${context ? `\n\nEk bağlam: ${context}` : ''}`,
        },
      ],
      max_tokens: 4096,
    })) as ChatCompletion;

    const plan = response.choices?.[0]?.message?.content?.trim() ?? '';
    if (plan.length > 50) {
      logger.info('AGENT', `[Strategy-Plan] ${agentType} → ${plan.slice(0, 200)}...`);
      emitProgress(`🧠 Strateji planı hazır (${plan.split('\n').length} satır)`);
      return plan;
    }
    return '';
  } catch (err) {
    // Fallback: strategy plan başarısız → sub-agent plansız devam eder
    logger.warn('AGENT', `[Strategy-Plan] Hata: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Sub-agent tamamlandıktan sonra sonuçları review et
 */
export async function reviewStrategyResult(
  agentType: string,
  query: string,
  result: string,
  plan?: string,
): Promise<{ approved: boolean; feedback: string }> {
  emitProgress(`🧠 Strategy Agent review ediyor (${agentType})...`);

  try {
    const response = (await client.chat.completions.create({
      model: STRATEGY_MODEL,
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        {
          role: 'user',
          content: `Agent: ${agentType}\nGörev: ${query}${plan ? `\n\nPlan:\n${plan}` : ''}\n\nSub-agent Sonucu:\n${result.slice(0, 15000)}`,
        },
      ],
      max_tokens: 4096,
    })) as ChatCompletion;

    const review = response.choices?.[0]?.message?.content?.trim() ?? '';
    const approved = review.includes('SONUÇ TEMİZ') || review.toLowerCase().includes('onaylıyorum');

    logger.info('AGENT', `[Strategy-Review] ${agentType} → ${approved ? 'ONAYLANDI' : 'DÜZELTME GEREKLİ'}`);
    emitProgress(`🧠 Review: ${approved ? 'Onaylandı' : 'Düzeltme gerekli'}`);

    return { approved, feedback: review };
  } catch (err) {
    logger.warn('AGENT', `[Strategy-Review] Hata: ${(err as Error).message}`);
    return { approved: true, feedback: '' };
  }
}

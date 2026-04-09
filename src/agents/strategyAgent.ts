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
 * Strategy Agent — 3 aşamalı çalışır:
 *   1. PLAN  — sub-agent çalışmadan önce taktiksel plan
 *   2. REVIEW — sub-agent bitince kalite denetimi + yeterlilik değerlendirmesi
 *   3. SYNTHESIZE — onaylı verilerden profesyonel final rapor
 *
 * Tool çağırmaz, sadece derin düşünür. Supervisor'dan farkı:
 * - Supervisor: genel koordinasyon, routing, kullanıcı muhabbeti
 * - Strategy: taktiksel planlama, sub-agent denetleme, rapor sentezi
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

İKİ AŞAMALI DEĞERLENDİRME YAP:

## AŞAMA 1: Kalite Kontrol (her zaman yap)
1. **Veri doğruluğu**: Tool çıktısında olmayan bilgi raporda var mı? (hallucination)
2. **Sayılar**: Repo/follower/sayılar tool çıktısıyla eşleşiyor mu?
3. **Kişi eşleşmesi**: Bulunan profiller gerçekten hedef kişiye mi ait? İsim/kanıt uyumu var mı?
4. **Login/hata durumu**: Erişilemeyen profiller "incelendi" olarak sunulmuş mu?
5. **Kanıtsız bağlantılar**: İki profil arasında somut kanıt olmadan "aynı kişi" denmiş mi?

## AŞAMA 2: Yeterlilik Değerlendirmesi (kritik)
Araştırma yeterli mi yoksa eksik mi? Şunları kontrol et:
- Temel platformlar tarandı mı? (GitHub, Twitter/X, LinkedIn, Instagram, ResearchGate vb.)
- Username varyasyonları denendi mi?
- Çapraz doğrulama yapıldı mı?
- Hedef kişiye özgü bilgiler (kurum, lokasyon) doğrulandı mı?

## ÇIKTI FORMATI

Eğer sonuç temiz ve yeterliyse:
SONUÇ TEMİZ — onaylıyorum
[2-3 cümlelik özet]

Eğer sorunlar varsa ama düzeltilebilir:
[SORUN_AÇIKLAMASI]
DÜZELTME ÖNERİLERİ:
- [spesifik düzeltme 1 — hangi araçla ne yapılacak]
- [spesifik düzeltme 2]
- ...

Eğer sonuç ciddi halüsinasyon içeriyorsa:
CİDDİ_SORUN
- [sorun 1]
- [sorun 2]
DÜZELTME: [sub-agent'ın ne yapması gerektiği]`;

const SYNTHESIS_PROMPT = `Sen bir OSINT Rapor Sentez Uzmanısın. Sub-agent'ın ham araştırma sonucunu profesyonel, temiz ve güvenilir bir rapora dönüştürüyorsun.

KURALLAR:
1. Sub-agent çıktısındaki HER somut iddia için kaynak kontrolü yap:
   - Tool çıktısında açıkça geçen bilgi → koru, kaynak etiketle
   - Kaynağı belirsiz veya tahmine dayalı → SİL
   - Sayılar (repo, follower, atıf) → tool çıktısıyla eşleşmiyorsa SİL
2. Birden fazla farklı kişi tespit edildiyse → AYRI AYRI bölümler halinde sun
3. Doğrulanmamış bilgileri ⚠️ ile işaretle, doğrulanmışları ✅ ile
4. Login ekranı/erişilemeyen profiller → rapordan SİL
5. Tekrar eden bilgileri birleştir, deduplikasyon yap

RAPOR FORMATI:
- Temiz Markdown, tablolar ve listeler
- Her bölümde kaynak referansı
- Güvenilirlik etiketleri
- Profesyonel ve okunabilir yapı
- Sonuç/özet bölümü ile bitir`;

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
    logger.warn('AGENT', `[Strategy-Plan] Hata: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Sub-agent tamamlandıktan sonra sonuçları review et.
 * Onaylanmazsa ve reRunFn verilmişse, sub-agent'ı düzeltme önerileriyle tekrar çalıştırır.
 * Maksimum 1 tekrar döngüsüne izin verilir (API maliyet kontrolü).
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

/**
 * Sub-agent'ın ham sonucunu profesyonel rapora dönüştürür.
 * Halüsinasyonları temizler, deduplikasyon yapar, kaynak referansları ekler.
 */
export async function synthesizeReport(
  agentType: string,
  query: string,
  result: string,
  reviewFeedback?: string,
): Promise<string> {
  emitProgress(`🧠 Strategy Agent rapor sentezliyor (${agentType})...`);

  try {
    const userContent = reviewFeedback
      ? `Agent: ${agentType}\nGörev: ${query}\n\nKalite Denetimi Sonucu:\n${reviewFeedback.slice(0, 3000)}\n\nSub-agent Ham Sonuç:\n${result.slice(0, 12000)}`
      : `Agent: ${agentType}\nGörev: ${query}\n\nSub-agent Ham Sonuç:\n${result.slice(0, 15000)}`;

    const response = (await client.chat.completions.create({
      model: STRATEGY_MODEL,
      messages: [
        { role: 'system', content: SYNTHESIS_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: 8192,
    })) as ChatCompletion;

    const synthesized = response.choices?.[0]?.message?.content?.trim() ?? '';
    if (synthesized.length > 100) {
      logger.info('AGENT', `[Strategy-Synthesize] ${agentType} → ${synthesized.slice(0, 150)}...`);
      emitProgress(`🧠 Profesyonel rapor sentezlendi (${(synthesized.length / 1024).toFixed(1)}KB)`);
      return synthesized;
    }
    // Sentez başarısız → ham sonucu döndür
    return result;
  } catch (err) {
    logger.warn('AGENT', `[Strategy-Synthesize] Hata: ${(err as Error).message}`);
    return result;
  }
}

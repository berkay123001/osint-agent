/**
 * Multi-Agent Senaryo Testi
 * ─────────────────────────
 * Senaryo: "BezosJeff" isimli şüpheli bir Twitter hesabı, 
 * Amazon CEO'su Jeff Bezos gibi davranarak insanları dolandırıyor.
 * 
 * Test akışı:
 *   1. Supervisor → kimlik sorusu → Identity Agent'a devredilmeli
 *   2. Supervisor → medya sorusu → Media Agent'a devredilmeli  
 *   3. Supervisor → graf istatistiği → kendi çözmeli (delegasyon yok)
 */
import 'dotenv/config';
import { supervisorAgentConfig } from './src/agents/supervisorAgent.js';
import { runAgentLoop } from './src/agents/baseAgent.js';
import { DEFAULT_MODEL, SUPERVISOR_MODEL } from './src/agents/baseAgent.js';
import type { Message } from './src/agents/types.js';
import chalk from 'chalk';

// ── Yardımcı ────────────────────────────────────────────────────────────────
function header(title: string) {
  const line = '─'.repeat(60);
  console.log(`\n${chalk.cyan.bold(line)}`);
  console.log(chalk.cyan.bold(`  ${title}`));
  console.log(`${chalk.cyan.bold(line)}\n`);
}

function result(label: string, value: string | boolean, ok?: boolean) {
  const icon = ok === undefined ? '•' : ok ? '✅' : '❌';
  console.log(`  ${icon}  ${chalk.bold(label)}: ${value}`);
}

// ── Test çalıştırıcı ─────────────────────────────────────────────────────────
async function runScenarioTest(
  label: string,
  userMessage: string,
  expectDelegation: 'identity' | 'media' | 'none',
) {
  header(`SENARYO: ${label}`);
  console.log(chalk.yellow(`  Kullanıcı: "${userMessage}"\n`));

  const history: Message[] = [{ role: 'user', content: userMessage }];
  const agentResult = await runAgentLoop(history, supervisorAgentConfig);

  const resp = agentResult.finalResponse.toLowerCase();
  const toolCount = agentResult.toolCallCount;

  // Basit beklenti kontrolleri
  const delegatedIdentity =
    history.some(
      (m) =>
        m.role === 'assistant' &&
        typeof m.content === 'string' &&
        m.content.includes('ask_identity_agent'),
    ) ||
    resp.includes('identity') ||
    resp.includes('sherlock') ||
    resp.includes('github');

  const delegatedMedia =
    history.some(
      (m) =>
        m.role === 'assistant' &&
        typeof m.content === 'string' &&
        m.content.includes('ask_media_agent'),
    ) ||
    resp.includes('media') ||
    resp.includes('görsel') ||
    resp.includes('reverse');

  console.log(chalk.bold('\n  📊 Sonuç Metrikleri:'));
  result('Toplam araç çağrısı', toolCount.toString());
  result('Model (Supervisor)', SUPERVISOR_MODEL);
  result('Model (Alt ajan)', DEFAULT_MODEL);
  result(
    'Yanıt uzunluğu',
    `${agentResult.finalResponse.length} karakter`,
  );

  console.log(chalk.bold('\n  🔀 Delegasyon Kontrolü:'));
  if (expectDelegation === 'identity') {
    result('Identity Agent devrede', String(delegatedIdentity), delegatedIdentity);
    result('Medya Agent devrede olmamalı', String(!delegatedMedia), !delegatedMedia);
  } else if (expectDelegation === 'media') {
    result('Media Agent devrede', String(delegatedMedia), delegatedMedia);
  } else {
    result('Delegasyon yok (kendi çözdü)', String(toolCount <= 3), toolCount <= 3);
  }

  console.log(chalk.bold('\n  💬 Supervisor Yanıtı (ilk 500 karakter):'));
  console.log(
    chalk.gray('  ') +
      agentResult.finalResponse.slice(0, 500).replace(/\n/g, '\n  '),
  );

  return {
    label,
    toolCallCount: toolCount,
    expectDelegation,
    delegatedIdentity,
    delegatedMedia,
    ok:
      expectDelegation === 'identity'
        ? delegatedIdentity
        : expectDelegation === 'media'
          ? delegatedMedia
          : toolCount <= 3,
  };
}

// ── Ana test ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(chalk.magenta.bold('\n╔══════════════════════════════════════════════════╗'));
  console.log(chalk.magenta.bold('║  OSINT Multi-Agent — Gerçek Senaryo Testi         ║'));
  console.log(chalk.magenta.bold('╚══════════════════════════════════════════════════╝\n'));
  console.log(`  Supervisor modeli : ${chalk.green(SUPERVISOR_MODEL)}`);
  console.log(`  Alt ajan modeli   : ${chalk.green(DEFAULT_MODEL)}\n`);

  const results = [];

  // ── Test 1: Kimlik araştırması → Identity'ye gitmeli
  results.push(
    await runScenarioTest(
      'Sahte Hesap Kimlik Tespiti',
      '"BezosJeff" isimli Twitter/X hesabını araştır. Bu kişi gerçek Jeff Bezos mu?',
      'identity',
    ),
  );

  // ── Test 2: Graf sorgusu → Supervisor kendi çözmeli
  results.push(
    await runScenarioTest(
      'Graf Sorgusu (Kendi Çöz)',
      'Veritabanındaki tüm düğüm istatistiklerini göster',
      'none',
    ),
  );

  // ── Özet ──────────────────────────────────────────────────────────────────
  const line = '═'.repeat(60);
  console.log(`\n${chalk.magenta.bold(line)}`);
  console.log(chalk.magenta.bold('  📋 TEST ÖZETİ'));
  console.log(`${chalk.magenta.bold(line)}\n`);

  let passed = 0;
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    console.log(`  ${icon} ${r.label} — araç: ${r.toolCallCount}, beklenti: ${r.expectDelegation}`);
    if (r.ok) passed++;
  }

  console.log(`\n  Toplam: ${passed}/${results.length} test geçti`);
  console.log(`  Supervisor (${SUPERVISOR_MODEL}) → Alt ajan (${DEFAULT_MODEL})\n`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(chalk.red('\n❌ Kritik hata:'), e.message);
  process.exit(1);
});

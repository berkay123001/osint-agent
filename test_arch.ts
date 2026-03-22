import 'dotenv/config';
import { tools } from './src/lib/toolRegistry.js';
import { supervisorAgentConfig } from './src/agents/supervisorAgent.js';
import { identityAgentConfig } from './src/agents/identityAgent.js';
import { mediaAgentConfig } from './src/agents/mediaAgent.js';

console.log('=== MULTI-AGENT MİMARİ TEST ===\n');
console.log('✅ Tüm modüller import edildi\n');

console.log('📊 Araç Dağılımı:');
console.log('  toolRegistry (toplam):', tools.length, 'araç');
console.log('  Supervisor araçları :', supervisorAgentConfig.tools.length, 'araç');
console.log('  Identity araçları   :', identityAgentConfig.tools.length, 'araç');
console.log('  Media araçları      :', mediaAgentConfig.tools.length, 'araç\n');

const hasDelegation = supervisorAgentConfig.tools.some((t: any) => t.function.name === 'ask_identity_agent');
const hasMedia = supervisorAgentConfig.tools.some((t: any) => t.function.name === 'ask_media_agent');
console.log('🔀 Supervisor delegasyon araçları:');
console.log('  ask_identity_agent :', hasDelegation ? '✅ VAR' : '❌ YOK');
console.log('  ask_media_agent    :', hasMedia ? '✅ VAR' : '❌ YOK\n');

const identityTools = identityAgentConfig.tools.map((t: any) => t.function.name);
console.log('🕵️  Identity araçları:', identityTools.join(', '));

const mediaTools = mediaAgentConfig.tools.map((t: any) => t.function.name);
console.log('📸 Media araçları   :', mediaTools.join(', '));

// Isolation check — Identity should NOT have supervisor's delegation tools
const identityHasDelegation = identityTools.includes('ask_identity_agent') || identityTools.includes('ask_media_agent');
console.log('\n🔒 Araç izolasyonu:');
console.log('  Identity, delegasyon aracı içermiyor:', identityHasDelegation ? '❌ HATA! İçeriyor' : '✅ Doğru');

// Media should have media-specific tools
const hasReverseImage = mediaTools.includes('reverse_image_search');
const hasFactCheck = mediaTools.includes('fact_check_to_graph');
console.log('  Media, reverse_image_search içeriyor:', hasReverseImage ? '✅' : '❌');
console.log('  Media, fact_check_to_graph içeriyor :', hasFactCheck ? '✅' : '❌');

if (!hasDelegation || !hasMedia || identityHasDelegation || !hasReverseImage) {
  console.log('\n❌ Bazı testler başarısız!');
  process.exit(1);
}

console.log('\n✅ TÜM TESTLER BAŞARILI! Multi-agent mimari düzgün çalışıyor.');
process.exit(0);

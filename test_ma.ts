import 'dotenv/config';
import { tools } from './src/lib/toolRegistry.js';
import { supervisorAgentConfig } from './src/agents/supervisorAgent.js';
import { runAgentLoop } from './src/agents/baseAgent.js';

async function main() {
  console.log('✅ Tüm modüller yüklendi\n');
  console.log(`📦 toolRegistry: ${tools.length} araç`);
  console.log(tools.map((t: any) => `  • ${t.function.name}`).join('\n'));

  console.log(`\n🤖 Supervisor araç listesi (${supervisorAgentConfig.tools.length} araç):`);
  console.log(supervisorAgentConfig.tools.map((t: any) => `  • ${t.function.name}`).join('\n'));

  console.log('\n🧪 Graf routing testi: "Graf istatistiklerini göster"...');
  const grafHistory: any[] = [{ role: 'user', content: 'Graf istatistiklerini göster' }];
  const grafResult = await runAgentLoop(grafHistory, supervisorAgentConfig);
  console.log(`✅ Graf testi OK! Tool çağrısı: ${grafResult.toolCallCount}`);
  console.log(`   ${grafResult.finalResponse.slice(0, 200)}\n`);

  console.log('🧪 Identity routing testi: "torvalds kişisini araştır"...');
  const identityHistory: any[] = [{ role: 'user', content: 'torvalds kişisini araştır' }];
  const identityResult = await runAgentLoop(identityHistory, supervisorAgentConfig);
  const calledAskIdentity = identityResult.finalResponse.toLowerCase().includes('identity') || identityResult.toolCallCount > 0;
  console.log(`✅ Identity testi OK! Tool çağrısı: ${identityResult.toolCallCount}`);
  console.log(`   ${identityResult.finalResponse.slice(0, 300)}`);

  process.exit(0);
}

main().catch((e) => { console.error('❌ HATA:', e.message); process.exit(1); });

import React from 'react';
import { Box, Text } from 'ink';
import { SUPERVISOR_MODEL, DEFAULT_MODEL } from '../agents/baseAgent.js';

const COMMANDS = [
  { cmd: '/resume',  desc: 'Kayıtlı oturum yükle' },
  { cmd: '/history', desc: 'Mesaj istatistikleri' },
  { cmd: '/show',    desc: 'Geçmişi ekrana yazdır' },
  { cmd: '/delete',  desc: 'Oturum sil' },
  { cmd: '/reset',   desc: 'Oturumu sıfırla' },
  { cmd: '/help',    desc: 'Komutları göster' },
  { cmd: 'exit',     desc: 'Çıkış' },
];

export function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="center" marginBottom={0}>
        <Text color="gray">╔════════════════════════╗</Text>
      </Box>
      <Box justifyContent="center">
        <Text color="gray">║   </Text>
        <Text bold color="cyan">G . U . A . R . D</Text>
        <Text color="gray">   ║</Text>
      </Box>
      <Box justifyContent="center" marginBottom={1}>
        <Text color="gray">╚════════════════════════╝</Text>
      </Box>

      <Text>
        <Text color="gray">  Supervisor : </Text>
        <Text color="green">{SUPERVISOR_MODEL}</Text>
      </Text>
      <Text>
        <Text color="gray">  Alt ajan   : </Text>
        <Text color="green">{DEFAULT_MODEL}</Text>
      </Text>

      <Box marginTop={1}>
        <Text color="gray">  Komutlar: </Text>
        {COMMANDS.map((c, i) => (
          <Text key={c.cmd}>
            <Text color="cyan">{c.cmd}</Text>
            {i < COMMANDS.length - 1 ? <Text color="gray"> · </Text> : null}
          </Text>
        ))}
      </Box>
      <Text color="gray">  ─────────────────────────────────────────────────────────</Text>
    </Box>
  );
}

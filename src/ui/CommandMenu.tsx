import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

const COMMANDS = [
  { label: '/delete',  value: '/delete',  description: 'Oturum sil' },
  { label: '/help',    value: '/help',    description: 'Komutları göster' },
  { label: '/history', value: '/history', description: 'Mesaj istatistikleri' },
  { label: '/reset',   value: '/reset',   description: 'Oturumu sıfırla' },
  { label: '/resume',  value: '/resume',  description: 'Kayıtlı oturum yükle' },
  { label: '/show',    value: '/show',    description: 'Geçmişi ekrana yazdır' },
  { label: 'exit',     value: 'exit',     description: 'Oturumu arşivle ve çık' },
];

interface Props {
  onSelect: (cmd: string) => void;
  onCancel: () => void;
}

function CommandItem({ isSelected, label, description }: { isSelected: boolean; label: string; description?: string }): React.ReactElement {
  return (
    <Box gap={2}>
      <Text bold={isSelected} color={isSelected ? 'yellow' : 'cyan'}>
        {isSelected ? '→ ' : '  '}{label}
      </Text>
      <Text dimColor={!isSelected}>{description ?? ''}</Text>
    </Box>
  );
}

export function CommandMenu({ onSelect, onCancel }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold color="cyan">  📋 Komutlar:</Text>
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        <SelectInput
          items={COMMANDS}
          onSelect={(item) => onSelect(item.value)}
          itemComponent={({ isSelected, label }: { isSelected?: boolean; label: string }) => {
            const cmd = COMMANDS.find(c => c.label === label);
            return <CommandItem isSelected={!!isSelected} label={label} description={cmd?.description} />;
          }}
        />
      </Box>
      <Text dimColor>  Esc/q = iptal · ↑↓ = gezin · Enter = seç</Text>
    </Box>
  );
}

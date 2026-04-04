import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

const COMMANDS = [
  { label: '/reset',   value: '/reset',   desc: 'Clear session' },
  { label: '/history', value: '/history',  desc: 'Message stats' },
  { label: '/delete',  value: '/delete',   desc: 'Delete session' },
  { label: 'exit',     value: 'exit',      desc: 'Quit' },
];

interface Props {
  onSelect: (cmd: string) => void;
  onCancel: () => void;
}

function Item({ isSelected, label }: { isSelected?: boolean; label: string }): React.ReactElement {
  const cmd = COMMANDS.find(c => c.label === label);
  return (
    <Text>
      <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
        {isSelected ? '› ' : '  '}{label}
      </Text>
      <Text dimColor> {cmd?.desc ?? ''}</Text>
    </Text>
  );
}

export function CommandMenu({ onSelect }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SelectInput
        items={COMMANDS}
        onSelect={(item) => onSelect(item.value)}
        itemComponent={Item}
      />
      <Text dimColor>Esc back</Text>
    </Box>
  );
}

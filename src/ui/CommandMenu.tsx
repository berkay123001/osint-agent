import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const COMMANDS = [
  { label: '/compact',  value: '/compact',  desc: 'Trim old messages' },
  { label: '/delete',   value: '/delete',   desc: 'Delete archived sessions' },
  { label: '/history',  value: '/history',   desc: 'Message stats' },
  { label: '/reset',    value: '/reset',     desc: 'Clear session' },
  { label: '/resume',   value: '/resume',    desc: 'Load archived session' },
  { label: 'exit',      value: 'exit',       desc: 'Quit' },
];

interface Props {
  onSelect: (cmd: string) => void;
  onCancel: () => void;
}

export function CommandMenu({ onSelect, onCancel }: Props): React.ReactElement {
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);

  const filtered = COMMANDS.filter(c =>
    c.label.includes(filter) || c.desc.toLowerCase().includes(filter.toLowerCase())
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (filtered.length > 0 && cursor < filtered.length) {
        onSelect(filtered[cursor].value);
      }
      return;
    }
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor(c => Math.min(filtered.length - 1, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setFilter(f => f.slice(0, -1));
      setCursor(0);
      return;
    }
    // Normal karakter — filtreye ekle
    if (input && !key.ctrl && !key.meta) {
      setFilter(f => f + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>/ </Text>
        <Text color="cyan">{filter}</Text>
        <Text dimColor>{'█'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {filtered.map((cmd, i) => (
          <Text key={cmd.value}>
            <Text color={i === cursor ? 'cyan' : undefined} bold={i === cursor}>
              {i === cursor ? '› ' : '  '}{cmd.label}
            </Text>
            <Text dimColor> {cmd.desc}</Text>
          </Text>
        ))}
        {filtered.length === 0 && <Text dimColor>  No matching commands</Text>}
      </Box>
    </Box>
  );
}

import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { SessionEntry } from '../lib/sessionStore.js';

interface Props {
  sessions: SessionEntry[];
  onSelect: (session: SessionEntry) => void;
  onCancel: () => void;
  title?: string;
}

export function SessionPicker({ sessions, onSelect, title }: Props): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Kayıtlı oturum yok.</Text>
      </Box>
    );
  }

  const items = sessions.map((s, i) => {
    const date = new Date(s.data.lastActiveAt).toLocaleString('tr-TR');
    const userMsgs = s.data.history.filter(m => m.role === 'user').length;
    const tag = s.isActive ? ' [aktif]' : '';
    const last = s.data.history.slice(-2).find(m => m.role === 'user');
    const preview = last && typeof last.content === 'string'
      ? ` "${last.content.slice(0, 40)}${last.content.length > 40 ? '…' : ''}"`
      : '';
    return {
      label: `${date} · ${userMsgs} soru${tag}${preview}`,
      value: String(i),
    };
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{title ?? 'Oturumlar:'}</Text>
      <Box marginLeft={1} flexDirection="column">
        <SelectInput
          items={items}
          onSelect={(item) => {
            const idx = parseInt(item.value, 10);
            if (idx >= 0 && idx < sessions.length) {
              onSelect(sessions[idx]);
            }
          }}
        />
      </Box>
      <Text dimColor>Esc = geri</Text>
    </Box>
  );
}

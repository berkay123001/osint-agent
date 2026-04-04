import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface Props {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
}

const PASTE_THRESHOLD = 3;  // birden fazla satır = paste
const PASTE_TIMEOUT = 100;  // ms

export function PromptInput({ onSubmit, isProcessing }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);

  const handleSubmit = useCallback((input: string) => {
    if (isProcessing) return;

    // Bekleyen paste varsa Enter ile gönder
    if (pendingPaste !== null) {
      const toSend = input.trim() ? input : pendingPaste;
      setPendingPaste(null);
      setValue('');
      onSubmit(toSend);
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) return;

    // Çok satırlı paste tespiti
    const lines = trimmed.split('\n');
    if (lines.length > PASTE_THRESHOLD) {
      const preview = trimmed.slice(0, 60).replace(/\n/g, ' ');
      const ellipsis = trimmed.length > 60 ? '…' : '';
      setPendingPaste(trimmed);
      setValue('');
      return;
    }

    setValue('');
    onSubmit(trimmed);
  }, [onSubmit, isProcessing, pendingPaste]);

  // "/" yazılır yazılmaz anında komut menüsünü aç (Enter gerekmeden)
  useEffect(() => {
    if (value === '/') {
      setValue('');
      onSubmit('/');
    }
  }, [value, onSubmit]);

  // Esc ile bekleyen paste iptal
  useInput((input, key) => {
    if (key.escape && pendingPaste !== null) {
      setPendingPaste(null);
    }
  });

  if (isProcessing) {
    return (
      <Box>
        <Text color="yellow">⏳ </Text>
        <Text dimColor>İşleniyor...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {pendingPaste !== null && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">
            📋 Yapıştırılan metin ({pendingPaste.split('\n').length} satır):
          </Text>
          <Text dimColor>
            {pendingPaste.slice(0, 120).replace(/\n/g, ' ')}
            {pendingPaste.length > 120 ? '…' : ''}
          </Text>
          <Text dimColor>↵ Enter = gönder · Esc = iptal</Text>
        </Box>
      )}
      <Box>
        <Text bold color="green">❯ </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Sorunuzu yazın..."
        />
      </Box>
    </Box>
  );
}

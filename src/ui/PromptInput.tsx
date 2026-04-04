import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

interface Props {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
}

const PASTE_THRESHOLD = 3;

export function PromptInput({ onSubmit, isProcessing }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);

  const handleSubmit = useCallback((input: string) => {
    if (isProcessing) return;

    if (pendingPaste !== null) {
      const toSend = input.trim() ? input : pendingPaste;
      setPendingPaste(null);
      setValue('');
      onSubmit(toSend);
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) return;

    const lines = trimmed.split('\n');
    if (lines.length > PASTE_THRESHOLD) {
      setPendingPaste(trimmed);
      setValue('');
      return;
    }

    setValue('');
    onSubmit(trimmed);
  }, [onSubmit, isProcessing, pendingPaste]);

  // "/" anında menü aç
  useEffect(() => {
    if (value === '/') {
      setValue('');
      onSubmit('/');
    }
  }, [value, onSubmit]);

  useInput((_input, key) => {
    if (key.escape && pendingPaste !== null) {
      setPendingPaste(null);
    }
  });

  if (isProcessing) {
    return (
      <Box gap={1}>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text dimColor>Thinking...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {pendingPaste !== null && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">
            Paste detected ({pendingPaste.split('\n').length} lines)
          </Text>
          <Text dimColor>
            {pendingPaste.slice(0, 100).replace(/\n/g, ' ')}
            {pendingPaste.length > 100 ? '…' : ''}
          </Text>
          <Text dimColor>Enter send · Esc cancel</Text>
        </Box>
      )}
      <Box>
        <Text color="cyan" bold>&gt; </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Message..."
        />
      </Box>
    </Box>
  );
}

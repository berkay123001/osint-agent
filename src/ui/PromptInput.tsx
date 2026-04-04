import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

interface Props {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
}

const PASTE_TIMEOUT_MS = 80;
const PASTE_THRESHOLD = 2; // 2+ satır = paste

export function PromptInput({ onSubmit, isProcessing }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const { stdin } = useStdin();
  const rawBufferRef = useRef('');
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // stdin raw data'dan paste tespiti — ink-text-input \n'leri yuttuğu için
  useEffect(() => {
    if (!stdin) return;
    const handler = (data: Buffer) => {
      const str = data.toString();
      rawBufferRef.current += str;

      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = setTimeout(() => {
        const buf = rawBufferRef.current;
        rawBufferRef.current = '';

        const lineCount = buf.split('\n').length - 1;
        if (lineCount >= PASTE_THRESHOLD) {
          const cleaned = buf.replace(/\r\n/g, '\n').trim();
          setPendingPaste(cleaned);
          setValue('');
        }
      }, PASTE_TIMEOUT_MS);
    };
    stdin.on('data', handler);
    return () => { stdin.off('data', handler); };
  }, [stdin]);

  const handleSubmit = useCallback((input: string) => {
    if (isProcessing) return;

    if (pendingPaste !== null) {
      const toSend = pendingPaste;
      setPendingPaste(null);
      setValue('');
      onSubmit(toSend);
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) return;

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
            Pasted {pendingPaste.split('\n').length} lines
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

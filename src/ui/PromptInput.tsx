import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

interface Props {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
}

export function PromptInput({ onSubmit, isProcessing }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const { stdin } = useStdin();
  // Synchronous flag — prevents TextInput.onChange from accepting paste chars
  const pasteActiveRef = useRef(false);

  // Bracketed paste mode: terminal wraps paste in \x1b[200~...\x1b[201~
  useEffect(() => {
    if (!stdin) return;

    let inPaste = false;
    let buf = '';

    const handler = (data: Buffer) => {
      const s = data.toString();

      if (!inPaste) {
        const si = s.indexOf('\x1b[200~');
        if (si === -1) return;
        inPaste = true;
        buf = s.slice(si + 6);
      } else {
        buf += s;
      }

      const ei = buf.indexOf('\x1b[201~');
      if (ei !== -1) {
        inPaste = false;
        const content = buf.slice(0, ei).replace(/\r\n/g, '\n').trimEnd();
        buf = '';
        pasteActiveRef.current = true;
        setPendingPaste(content);
        setValue('');
        setTimeout(() => { pasteActiveRef.current = false; }, 0);
      }
    };

    stdin.on('data', handler);
    return () => { stdin.off('data', handler); };
  }, [stdin]);

  // Block TextInput from showing paste characters
  const handleChange = useCallback((v: string) => {
    if (pasteActiveRef.current) {
      setValue('');
      return;
    }
    setValue(v);
  }, []);

  // Enter/Esc when paste is pending
  useInput((_input, key) => {
    if (pendingPaste === null) return;
    if (key.return) {
      const toSend = pendingPaste;
      setPendingPaste(null);
      setValue('');
      onSubmit(toSend);
    } else if (key.escape) {
      setPendingPaste(null);
      setValue('');
    }
  });

  // "/" → open command menu immediately
  useEffect(() => {
    if (value === '/') {
      setValue('');
      onSubmit('/');
    }
  }, [value, onSubmit]);

  if (isProcessing) {
    return (
      <Box gap={1}>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text dimColor>Thinking...</Text>
      </Box>
    );
  }

  if (pendingPaste !== null) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="yellow" bold>
            {'  '}{pendingPaste.split('\n').length} satır yapıştırıldı
          </Text>
          <Text dimColor>
            {'  '}{pendingPaste.slice(0, 80).replace(/\n/g, '↵')}
            {pendingPaste.length > 80 ? '…' : ''}
          </Text>
        </Box>
        <Text dimColor>Enter göndermek için · Esc iptal</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="cyan" bold>&gt; </Text>
      <TextInput
        value={value}
        onChange={handleChange}
        onSubmit={(v) => {
          if (isProcessing) return;
          const trimmed = v.trim();
          if (!trimmed) return;
          setValue('');
          onSubmit(trimmed);
        }}
        placeholder="Message..."
      />
    </Box>
  );
}

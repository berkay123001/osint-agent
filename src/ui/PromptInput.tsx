import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

interface PasteChunk {
  id: number;
  content: string;
  lineCount: number;
}

interface Props {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
}

export function PromptInput({ onSubmit, isProcessing }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [pendingPastes, setPendingPastes] = useState<PasteChunk[]>([]);
  const { stdin } = useStdin();
  const pasteActiveRef = useRef(false);
  const pasteIdRef = useRef(0);
  const valueRef = useRef(''); // typed text öncesindeki içeriği paste için koru

  // valueRef'i her değişiklikte senkronize tut
  useEffect(() => { valueRef.current = value; }, [value]);

  // Enable/disable bracketed paste mode (DECSET 2004)
  useEffect(() => {
    process.stdout.write('\x1b[?2004h');
    return () => {
      process.stdout.write('\x1b[?2004l');
    };
  }, []);

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
        const pastedContent = buf.slice(0, ei).replace(/\r\n/g, '\n').trimEnd();
        buf = '';
        pasteActiveRef.current = true;
        pasteIdRef.current++;
        // Yapıştırmadan önce yazılan metni koru — valueRef üzerinden eriş
        const existingText = valueRef.current.trimEnd();
        const separator = existingText
          ? (pastedContent.includes('\n') ? '\n' : ' ')
          : '';
        const content = existingText + separator + pastedContent;
        setPendingPastes(prev => [...prev, {
          id: pasteIdRef.current,
          content,
          lineCount: content.split('\n').length,
        }]);
        setValue('');
        setTimeout(() => { pasteActiveRef.current = false; }, 0);
      }
    };

    stdin.prependListener('data', handler);
    return () => { stdin.removeListener('data', handler); };
  }, [stdin]);

  // Block TextInput from showing paste characters + newline fallback
  const handleChange = useCallback((v: string) => {
    if (pasteActiveRef.current) {
      setValue('');
      return;
    }
    // Fallback: detect paste that bypassed bracketed paste detection
    if (v.includes('\n') || v.includes('\r')) {
      const content = v.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      if (content) {
        pasteActiveRef.current = true;
        pasteIdRef.current++;
        setPendingPastes(prev => [...prev, {
          id: pasteIdRef.current,
          content,
          lineCount: content.split('\n').length,
        }]);
        setValue('');
        setTimeout(() => { pasteActiveRef.current = false; }, 0);
      }
      return;
    }
    setValue(v);
  }, []);

  // Esc → clear all pastes · Backspace on empty → remove last paste
  useInput((_input, key) => {
    if (key.escape && pendingPastes.length > 0) {
      setPendingPastes([]);
      setValue('');
    }
    if (key.backspace && value === '' && pendingPastes.length > 0) {
      setPendingPastes(prev => prev.slice(0, -1));
    }
  });

  // "/" → open command menu immediately (only when no pastes)
  useEffect(() => {
    if (value === '/' && pendingPastes.length === 0) {
      setValue('');
      onSubmit('/');
    }
  }, [value, onSubmit, pendingPastes.length]);

  if (isProcessing) {
    return (
      <Box gap={1}>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text dimColor>Thinking...</Text>
      </Box>
    );
  }

  const handleTextInputSubmit = (v: string) => {
    if (isProcessing) return;
    const trimmed = v.trim();

    if (pendingPastes.length > 0) {
      const pasteContent = pendingPastes.map(p => p.content).join('\n');
      const additional = trimmed ? '\n' + trimmed : '';
      setPendingPastes([]);
      setValue('');
      onSubmit(pasteContent + additional);
      return;
    }

    if (!trimmed) return;
    setValue('');
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column">
      {pendingPastes.length > 0 && (
        <Box flexDirection="column">
          <Box>
            <Text color="yellow">
              {pendingPastes.map(p => `[paste #${p.id} +${p.lineCount} lines]`).join(' ')}
            </Text>
          </Box>
          <Text dimColor>  ⌫ remove last · Esc clear all · Enter send</Text>
        </Box>
      )}
      <Box>
        <Text color="cyan" bold>&gt; </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleTextInputSubmit}
          placeholder={pendingPastes.length > 0 ? 'Add text or Enter to send...' : 'Message...'}
        />
      </Box>
    </Box>
  );
}

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { runSupervisor } from '../agents/supervisorAgent.js';
import { closeNeo4j } from '../lib/neo4j.js';
import type { Message } from '../agents/types.js';
import {
  loadActiveSession,
  saveSession,
  archiveSession,
  deleteActiveSession,
  listSessions,
  deleteSession,
  type SessionEntry,
} from '../lib/sessionStore.js';

import { Header } from './Banner.js';
import { MessageList } from './MessageList.js';
import { CommandMenu } from './CommandMenu.js';
import { PromptInput } from './PromptInput.js';

type ViewMode = 'chat' | 'menu';

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString());
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<ViewMode>('chat');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Aktif oturumu sessizce yükle — soru sormadan devam et
  useEffect(() => {
    const existing = loadActiveSession();
    if (existing && existing.messageCount > 0) {
      setMessages(existing.history);
      setCreatedAt(existing.createdAt);
    }
  }, []);

  // Esc → menüden çık
  useInput((_input, key) => {
    if (key.escape && view === 'menu') {
      setView('chat');
    }
  });

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === '/' || trimmed === '/help') {
      setView('menu');
      return;
    }
    if (trimmed === '/history') {
      const u = messages.filter(m => m.role === 'user').length;
      const a = messages.filter(m => m.role === 'assistant' && typeof m.content === 'string').length;
      setStatusMsg(`${u} questions · ${a} answers`);
      return;
    }
    if (trimmed === '/reset') {
      archiveSession(messages, createdAt);
      deleteActiveSession();
      setMessages([]);
      setCreatedAt(new Date().toISOString());
      setStatusMsg('Session cleared.');
      return;
    }
    if (trimmed === '/delete') {
      const sessions = listSessions();
      sessions.forEach((s: SessionEntry) => deleteSession(s.filename));
      setStatusMsg(`Deleted ${sessions.length} archived sessions.`);
      return;
    }
    if (trimmed.toLowerCase() === 'exit') {
      saveSession(messages, createdAt);
      await closeNeo4j();
      exit();
      return;
    }

    // Normal mesaj → supervisor
    setIsProcessing(true);
    setStatusMsg(null);
    const newMessages: Message[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(newMessages);

    try {
      await runSupervisor(newMessages);
      setMessages([...newMessages]);
      saveSession(newMessages, createdAt);
    } catch (e) {
      setStatusMsg(`Error: ${(e as Error).message}`);
    }
    setIsProcessing(false);
  }, [messages, createdAt, exit]);

  const handleMenuSelect = useCallback((cmd: string) => {
    setView('chat');
    handleSubmit(cmd);
  }, [handleSubmit]);

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Header />

      <Box marginTop={1} flexDirection="column">
        <MessageList messages={messages} />

        {statusMsg && (
          <Box marginTop={1}>
            <Text dimColor>{statusMsg}</Text>
          </Box>
        )}

        {view === 'chat' && (
          <Box marginTop={1}>
            <PromptInput onSubmit={handleSubmit} isProcessing={isProcessing} />
          </Box>
        )}

        {view === 'menu' && (
          <CommandMenu
            onSelect={handleMenuSelect}
            onCancel={() => setView('chat')}
          />
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/ commands · exit quit</Text>
      </Box>
    </Box>
  );
}

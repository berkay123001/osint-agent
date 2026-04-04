import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';

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

type ViewMode = 'chat' | 'menu' | 'resume';

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString());
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<ViewMode>('chat');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Esc → menüden çık
  useInput((_input, key) => {
    if (key.escape && view !== 'chat') {
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
    if (trimmed === '/compact') {
      // Eski mesajları kırp — son 10 mesajı tut, gerisini at
      const KEEP = 10;
      if (messages.length <= KEEP) {
        setStatusMsg(`Already compact (${messages.length} messages).`);
        return;
      }
      const trimmed2 = messages.slice(-KEEP);
      setMessages(trimmed2);
      saveSession(trimmed2, createdAt);
      setStatusMsg(`Compacted: ${messages.length} → ${trimmed2.length} messages.`);
      return;
    }
    if (trimmed === '/resume') {
      const sessions = listSessions();
      if (sessions.length === 0) {
        setStatusMsg('No archived sessions.');
        return;
      }
      setView('resume');
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

  // Resume: oturum seçimi
  const archivedSessions = listSessions();
  const resumeItems = archivedSessions.map((s, i) => {
    const date = new Date(s.data.lastActiveAt).toLocaleString('tr-TR');
    const q = s.data.history.filter(m => m.role === 'user').length;
    return { label: `${date} · ${q} questions`, value: String(i) };
  });

  const handleResumeSelect = useCallback((item: { value: string }) => {
    const idx = parseInt(item.value, 10);
    const session = archivedSessions[idx];
    if (!session) return;
    if (messages.length > 0) {
      archiveSession(messages, createdAt);
    }
    setMessages(session.data.history);
    setCreatedAt(session.data.createdAt);
    saveSession(session.data.history, session.data.createdAt);
    setStatusMsg(`Loaded session (${session.data.history.filter(m => m.role === 'user').length} questions).`);
    setView('chat');
  }, [messages, createdAt, archivedSessions]);

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

        {view === 'resume' && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Select session (Esc back):</Text>
            <SelectInput
              items={resumeItems}
              onSelect={handleResumeSelect}
            />
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/ commands · exit quit</Text>
      </Box>
    </Box>
  );
}

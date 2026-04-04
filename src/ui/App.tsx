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
  deleteAllSessions,
  type SessionEntry,
} from '../lib/sessionStore.js';

import { Banner } from './Banner.js';
import { MessageList } from './MessageList.js';
import { CommandMenu } from './CommandMenu.js';
import { PromptInput } from './PromptInput.js';
import { SessionPicker } from './SessionPicker.js';

type ViewMode = 'chat' | 'menu' | 'resume' | 'delete' | 'startup';

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString());
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<ViewMode>('startup');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Başlangıçta aktif oturumu kontrol et
  useEffect(() => {
    const existing = loadActiveSession();
    if (existing && existing.messageCount > 0) {
      setMessages(existing.history);
      setCreatedAt(existing.createdAt);
      setStatusMsg(`✔ Oturum devam ediyor — ${existing.history.filter(m => m.role === 'user').length} önceki soru yüklendi.`);
    } else {
      setStatusMsg('Yeni oturum başlatıldı.');
    }
    setView('chat');
  }, []);

  // Global Esc → menüden çık
  useInput((input, key) => {
    if (key.escape && (view === 'menu' || view === 'resume' || view === 'delete')) {
      setView('chat');
    }
    // q tuşu ile menülerden çık (yalnızca menü modundayken)
    if (input === 'q' && (view === 'menu' || view === 'resume' || view === 'delete')) {
      setView('chat');
    }
  });

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Slash komutları
    if (trimmed === '/' || trimmed === '/help') {
      setView('menu');
      return;
    }
    if (trimmed === '/resume') {
      setView('resume');
      return;
    }
    if (trimmed === '/delete') {
      setView('delete');
      return;
    }
    if (trimmed === '/history') {
      const userMsgs = messages.filter(m => m.role === 'user').length;
      const asstMsgs = messages.filter(m => m.role === 'assistant' && typeof m.content === 'string').length;
      const toolMsgs = messages.filter(m => m.role === 'tool').length;
      setStatusMsg(`📋 ${userMsgs} soru · ${asstMsgs} yanıt · ${toolMsgs} araç çağrısı`);
      return;
    }
    if (trimmed === '/show') {
      // Mesajlar zaten MessageList'te görünüyor
      setStatusMsg(messages.length === 0 ? '📭 Henüz mesaj yok.' : null);
      return;
    }
    if (trimmed === '/reset') {
      archiveSession(messages, createdAt);
      deleteActiveSession();
      setMessages([]);
      setCreatedAt(new Date().toISOString());
      setStatusMsg('🔄 Oturum sıfırlandı.');
      return;
    }
    if (trimmed.toLowerCase() === 'exit') {
      archiveSession(messages, createdAt);
      deleteActiveSession();
      await closeNeo4j();
      exit();
      return;
    }

    // Normal mesaj — supervisor'a gönder
    setIsProcessing(true);
    setStatusMsg(null);
    const newMessages: Message[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(newMessages);

    try {
      await runSupervisor(newMessages);
      // runSupervisor mesajları doğrudan history array'ine push eder
      setMessages([...newMessages]);
      saveSession(newMessages, createdAt);
    } catch (e) {
      setStatusMsg(`❌ Hata: ${(e as Error).message}`);
    }
    setIsProcessing(false);
  }, [messages, createdAt, exit]);

  const handleMenuSelect = useCallback((cmd: string) => {
    setView('chat');
    handleSubmit(cmd);
  }, [handleSubmit]);

  const handleResumeSelect = useCallback((session: SessionEntry) => {
    if (messages.length > 0) {
      archiveSession(messages, createdAt);
    }
    setMessages(session.data.history);
    setCreatedAt(session.data.createdAt);
    saveSession(session.data.history, session.data.createdAt);
    setStatusMsg(`✔ Oturum yüklendi — ${session.data.history.filter(m => m.role === 'user').length} soru`);
    setView('chat');
  }, [messages, createdAt]);

  const handleDeleteSelect = useCallback((session: SessionEntry) => {
    if (session.isActive) {
      deleteActiveSession();
      setMessages([]);
      setCreatedAt(new Date().toISOString());
    } else {
      deleteSession(session.filename);
    }
    setStatusMsg('✔ Oturum silindi.');
    setView('chat');
  }, []);

  // Oturum listesi (resume & delete için)
  const allSessions = useCallback((): SessionEntry[] => {
    const archived = listSessions();
    const active = loadActiveSession();
    const result: SessionEntry[] = [];
    if (active && active.messageCount > 0) {
      result.push({ filename: '(aktif)', data: active, isActive: true });
    }
    result.push(...archived);
    return result;
  }, []);

  return (
    <Box flexDirection="column">
      <Banner />

      {statusMsg && (
        <Box marginBottom={1}>
          <Text color="green">  {statusMsg}</Text>
        </Box>
      )}

      {view === 'chat' && (
        <>
          <MessageList messages={messages} />
          <PromptInput onSubmit={handleSubmit} isProcessing={isProcessing} />
        </>
      )}

      {view === 'menu' && (
        <CommandMenu
          onSelect={handleMenuSelect}
          onCancel={() => setView('chat')}
        />
      )}

      {view === 'resume' && (
        <SessionPicker
          sessions={allSessions()}
          onSelect={handleResumeSelect}
          onCancel={() => setView('chat')}
          title="📂 Devam etmek istediğiniz oturumu seçin:"
        />
      )}

      {view === 'delete' && (
        <SessionPicker
          sessions={allSessions()}
          onSelect={handleDeleteSelect}
          onCancel={() => setView('chat')}
          title="🗑️ Silmek istediğiniz oturumu seçin:"
        />
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {view === 'chat'
            ? '/ = komutlar · exit = çıkış'
            : 'Esc = geri · ↑↓ = gezin · Enter = seç'}
        </Text>
      </Box>
    </Box>
  );
}

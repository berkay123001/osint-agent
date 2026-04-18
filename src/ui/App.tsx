import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';

import { runSupervisor } from '../agents/supervisorAgent.js';
import { closeNeo4j } from '../lib/neo4j.js';
import type { Message } from '../agents/types.js';
import { emitSessionReset, progressEmitter } from '../lib/progressEmitter.js';
import { formatLLMTelemetryLine, type LLMTelemetryEvent } from '../lib/llmTelemetry.js';
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

type ViewMode = 'chat' | 'menu' | 'resume' | 'delete';

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString());
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<ViewMode>('chat');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const progressBufferRef = useRef<string[]>([]);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logGenerationRef = useRef(0);

  const clearPendingLogFlush = useCallback(() => {
    progressBufferRef.current = [];
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const resetProgressLog = useCallback((hideLog: boolean) => {
    logGenerationRef.current += 1;
    clearPendingLogFlush();
    setProgressLog([]);
    setLogScrollOffset(0);
    if (hideLog) setShowLog(false);
  }, [clearPendingLogFlush]);

  // progressEmitter dinle — agent/tool loglarını UI'da göster
  // Batch: 150ms içinde gelen logları tek seferde render et — titreme önler
  useEffect(() => {
    const scheduleFlush = () => {
      if (progressTimerRef.current) return;

      const generation = logGenerationRef.current;
      progressTimerRef.current = setTimeout(() => {
        progressTimerRef.current = null;
        const batch = progressBufferRef.current;
        progressBufferRef.current = [];

        if (generation !== logGenerationRef.current || batch.length === 0) return;

        setProgressLog(prev => [...prev.slice(-200), ...batch]);
        setLogScrollOffset(prev => prev === 0 ? 0 : prev);
      }, 150);
    };

    const handler = (msg: string) => {
      progressBufferRef.current.push(msg);
      scheduleFlush();
    };
    const telemetryHandler = (event: LLMTelemetryEvent) => {
      progressBufferRef.current.push(formatLLMTelemetryLine(event));
      scheduleFlush();
    };
    progressEmitter.on('progress', handler);
    progressEmitter.on('telemetry', telemetryHandler);
    return () => {
      progressEmitter.off('progress', handler);
      progressEmitter.off('telemetry', telemetryHandler);
      clearPendingLogFlush();
    };
  }, [clearPendingLogFlush]);

  // Startup: önceki aktif oturumu arşivle — /resume listesinde görünsün
  useEffect(() => {
    const existing = loadActiveSession();
    if (existing && existing.messageCount > 0) {
      archiveSession(existing.history, existing.createdAt);
      deleteActiveSession();
    }
  }, []);

  // Esc → menüden çık; L → log toggle
  useInput((_input, key) => {
    if (key.escape && view !== 'chat') {
      setView('chat');
      return;
    }
    if (_input === 'l' && view === 'chat' && !key.ctrl && !key.meta) {
      if (progressLog.length > 0) setShowLog(v => !v);
    }
    const LOG_LINES = 30;
    if (showLog && view === 'chat') {
      if (key.upArrow) {
        setLogScrollOffset(prev => Math.min(prev + 5, Math.max(0, progressLog.length - LOG_LINES)));
      }
      if (key.downArrow) {
        setLogScrollOffset(prev => Math.max(0, prev - 5));
      }
    }
  });

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === '/' || trimmed === '/help') {
      setView('menu');
      return;
    }
    if (trimmed === '/log') {
      if (progressLog.length === 0) {
        setStatusMsg('Henüz log yok.');
      } else {
        setShowLog(v => !v);
      }
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
      resetProgressLog(true);
      emitSessionReset();
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
      if (sessions.length === 0) {
        setStatusMsg('No archived sessions to delete.');
        return;
      }
      setView('delete');
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
    resetProgressLog(false);
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
  }, [messages, createdAt, exit, resetProgressLog]);

  const handleMenuSelect = useCallback((cmd: string) => {
    setView('chat');
    handleSubmit(cmd);
  }, [handleSubmit]);

  // Resume — her render'da taze liste
  const getArchivedSessions = () => listSessions();

  const handleResumeSelect = useCallback((item: { value: string }) => {
    const sessions = listSessions(); // taze oku
    const idx = parseInt(item.value, 10);
    const session = sessions[idx];
    if (!session) return;
    if (messages.length > 0) {
      archiveSession(messages, createdAt);
      deleteActiveSession();
    }
    resetProgressLog(true);
    emitSessionReset();
    setMessages(session.data.history);
    setCreatedAt(session.data.createdAt);
    saveSession(session.data.history, session.data.createdAt);
    setStatusMsg(`Oturum yükle: ${session.data.history.filter(m => m.role === 'user').length} soru.`);
    setView('chat');
  }, [messages, createdAt, resetProgressLog]);

  const handleDeleteSelect = useCallback((item: { value: string }) => {
    const sessions = listSessions(); // taze oku
    if (item.value === '__all__') {
      sessions.forEach((s: SessionEntry) => deleteSession(s.filename));
      setStatusMsg(`${sessions.length} oturum silindi.`);
      setView('chat');
      return;
    }
    const idx = parseInt(item.value, 10);
    const session = sessions[idx];
    if (!session) return;
    deleteSession(session.filename);
    const remaining = listSessions();
    if (remaining.length === 0) {
      setStatusMsg('Silindi. Oturum kalmadı.');
      setView('chat');
    }
  }, []);

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

        {isProcessing && progressLog.length > 0 && (
          <Box marginTop={0}>
            <Text dimColor>  {progressLog[progressLog.length - 1]?.slice(0, 120)}</Text>
          </Box>
        )}

        {progressLog.length > 0 && (() => {
          const LOG_LINES = 10;
          const scrollStart = Math.max(0, progressLog.length - LOG_LINES - logScrollOffset);
          const visibleLines = progressLog.slice(scrollStart, scrollStart + LOG_LINES);
          const canScrollUp = logScrollOffset < progressLog.length - LOG_LINES;
          const canScrollDown = logScrollOffset > 0;
          return (
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text color="cyan" dimColor>{showLog ? '▼' : '▶'}</Text>
              <Text dimColor>
                {progressLog.length} satır
                {logScrollOffset > 0 ? ` (${progressLog.length - LOG_LINES - logScrollOffset + 1}-${Math.min(progressLog.length, scrollStart + LOG_LINES)})` : ''}
                {' — '}
                {showLog ? 'açık' : 'kapalı'}
              </Text>
              <Text color="cyan" dimColor>[L]{showLog ? '  ↑↓ kaydır' : ''}</Text>
            </Box>
            {showLog && (
              <Box flexDirection="column" marginTop={0} marginLeft={2}>
                {canScrollUp && <Text dimColor color="cyan">  ↑ daha eski loglar var</Text>}
                {visibleLines.map((line, i) => (
                  <Text key={i} dimColor>{line.slice(0, 140)}</Text>
                ))}
                {canScrollDown && <Text dimColor color="cyan">  ↓ daha yeni loglar var</Text>}
              </Box>
            )}
          </Box>
          );
        })()}

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
            <Text dimColor>Oturum seç (Esc geri):</Text>
            <SelectInput
              items={getArchivedSessions().map((s, i) => ({
                label: `${new Date(s.data.lastActiveAt).toLocaleString('tr-TR')} · ${s.data.history.filter(m => m.role === 'user').length} soru`,
                value: String(i),
              }))}
              onSelect={handleResumeSelect}
            />
          </Box>
        )}

        {view === 'delete' && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Silinecek oturumu seç (Esc geri):</Text>
            <SelectInput
              items={[
                { label: '⚠ Tüm oturumları sil', value: '__all__' },
                ...getArchivedSessions().map((s, i) => ({
                  label: `${new Date(s.data.lastActiveAt).toLocaleString('tr-TR')} · ${s.data.history.filter((m: Message) => m.role === 'user').length} soru`,
                  value: String(i),
                })),
              ]}
              onSelect={handleDeleteSelect}
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

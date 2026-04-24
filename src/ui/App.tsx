import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';

import { runSupervisor } from '../agents/supervisorAgent.js';
import { closeNeo4j } from '../lib/neo4j.js';
import type { Message } from '../agents/types.js';
import { isInternalControlMessage } from '../lib/agentSession.js';
import { emitSessionReset, progressEmitter } from '../lib/progressEmitter.js';
import { formatLLMTelemetryLine, type LLMTelemetryEvent } from '../lib/llmTelemetry.js';
import {
  loadActiveSession,
  saveSession,
  archiveSession,
  deleteActiveSession,
  hasStoredSessions,
  listSessions,
  deleteAllSessions,
  listDeletableSessions,
  deleteSessionsByCreatedAt,
  type SessionEntry,
} from '../lib/sessionStore.js';

import { Header } from './Banner.js';
import { MessageList } from './MessageList.js';
import { CommandMenu } from './CommandMenu.js';
import { PromptInput } from './PromptInput.js';
import { buildTranscriptViewport, countFlatTranscriptLines } from './transcriptViewport.js';

type ViewMode = 'chat' | 'menu' | 'resume' | 'delete';

function buildVisibleChatMessages(history: Message[]): Message[] {
  return history.flatMap((message) => {
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      return [];
    }

    const content = message.content.trim();
    if (!content) return [];
    if (message.role === 'user' && isInternalControlMessage(content)) return [];

    return [{ role: message.role, content } as Message];
  });
}

export function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionHistory, setSessionHistory] = useState<Message[]>([]);
  const [createdAt, setCreatedAt] = useState<string>(new Date().toISOString());
  const [isProcessing, setIsProcessing] = useState(false);
  const [view, setView] = useState<ViewMode>('chat');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [hasProgressLogs, setHasProgressLogs] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const isProcessingRef = useRef(false);
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [lineScrollOffset, setLineScrollOffset] = useState(0);
  const [archivedSessions, setArchivedSessions] = useState<SessionEntry[]>([]);
  const progressBufferRef = useRef<string[]>([]);
  const progressLogStoreRef = useRef<string[]>([]);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logGenerationRef = useRef(0);
  const showLogRef = useRef(false);

  const terminalRows = stdout?.rows ?? process.stdout.rows ?? 40;
  const terminalColumns = stdout?.columns ?? process.stdout.columns ?? 120;
  const LOG_LINES = 10;
  const SCROLL_STEP = 3;
  const transcriptLineBudget = Math.max(8, terminalRows - (showLog ? 22 : 16) - (view === 'chat' ? 0 : 6));
  const logPreviewWidth = Math.max(48, terminalColumns - 10);
  const messageLineWidth = Math.max(40, terminalColumns - 6);
  const maxLineScrollOffset = useMemo(
    () => Math.max(0, countFlatTranscriptLines(messages, messageLineWidth) - transcriptLineBudget),
    [messages, messageLineWidth, transcriptLineBudget],
  );
  const transcriptViewport = useMemo(() => buildTranscriptViewport(messages, {
    maxTotalLines: transcriptLineBudget,
    maxLinesPerMessage: 400,
    maxMessages: 12,
    maxLineWidth: messageLineWidth,
    lineScrollOffset,
  }), [lineScrollOffset, messageLineWidth, messages, transcriptLineBudget]);

  const refreshArchivedSessions = useCallback(() => {
    setArchivedSessions(listSessions());
  }, []);

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
    progressLogStoreRef.current = [];
    setProgressLog([]);
    setHasProgressLogs(false);
    setLogScrollOffset(0);
    if (hideLog) setShowLog(false);
  }, [clearPendingLogFlush]);

  const resetTranscriptScroll = useCallback(() => {
    setLineScrollOffset(0);
  }, []);

  const toggleLogVisibility = useCallback(() => {
    if (showLogRef.current) {
      setShowLog(false);
      return;
    }

    const storedLogs = progressLogStoreRef.current;
    // Block opening only when idle AND no logs accumulated yet
    if (storedLogs.length === 0 && !isProcessingRef.current) {
      setStatusMsg('Henüz log yok.');
      return;
    }

    setProgressLog(storedLogs);
    setLogScrollOffset(0);
    setShowLog(true);
  }, []);

  useEffect(() => {
    showLogRef.current = showLog;
  }, [showLog]);

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

        const nextStoredLogs = [...progressLogStoreRef.current, ...batch].slice(-200);
        progressLogStoreRef.current = nextStoredLogs;
        setHasProgressLogs(prev => prev || nextStoredLogs.length > 0);

        if (showLogRef.current) {
          setProgressLog(nextStoredLogs);
          setLogScrollOffset(prev => prev === 0 ? 0 : Math.min(prev, Math.max(0, nextStoredLogs.length - LOG_LINES)));
        }
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
    refreshArchivedSessions();
  }, [refreshArchivedSessions]);

  useEffect(() => {
    setLineScrollOffset(prev => Math.min(prev, maxLineScrollOffset));
  }, [maxLineScrollOffset]);

  // Esc → menüden çık; L → log toggle
  useInput((_input, key) => {
    if (key.escape && view !== 'chat') {
      setView('chat');
      return;
    }
    if (_input === 'l' && view === 'chat' && key.ctrl) {
      toggleLogVisibility();
    }
    if (showLog && view === 'chat') {
      if (key.upArrow) {
        setLogScrollOffset(prev => Math.min(prev + 5, Math.max(0, progressLog.length - LOG_LINES)));
      }
      if (key.downArrow) {
        setLogScrollOffset(prev => Math.max(0, prev - 5));
      }
      return;
    }
    if (view === 'chat') {
      if (key.upArrow) {
        setLineScrollOffset(prev => Math.min(prev + SCROLL_STEP, maxLineScrollOffset));
      }
      if (key.downArrow && lineScrollOffset > 0) {
        setLineScrollOffset(prev => Math.max(0, prev - SCROLL_STEP));
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
      toggleLogVisibility();
      return;
    }
    if (trimmed === '/history') {
      const u = messages.filter(m => m.role === 'user').length;
      const a = messages.filter(m => m.role === 'assistant' && typeof m.content === 'string').length;
      setStatusMsg(`${u} questions · ${a} answers`);
      return;
    }
    if (trimmed === '/reset') {
      archiveSession(sessionHistory, createdAt);
      deleteActiveSession();
      setMessages([]);
      setSessionHistory([]);
      setCreatedAt(new Date().toISOString());
      resetTranscriptScroll();
      resetProgressLog(true);
      emitSessionReset();
      setStatusMsg('Session cleared.');
      return;
    }
    if (trimmed === '/compact') {
      setStatusMsg('Compact disabled: durable memory now preserves the full transcript and builds a bounded provider context automatically.');
      return;
    }
    if (trimmed === '/resume') {
      const sessions = listSessions();
      if (sessions.length === 0) {
        setStatusMsg('No archived sessions.');
        return;
      }
      setArchivedSessions(sessions);
      setView('resume');
      return;
    }
    if (trimmed === '/delete') {
      const sessions = listDeletableSessions();
      if (sessions.length === 0 && !hasStoredSessions()) {
        setStatusMsg('No archived sessions to delete.');
        return;
      }
      setArchivedSessions(sessions);
      setView('delete');
      return;
    }
    if (trimmed.toLowerCase() === 'exit') {
      saveSession(sessionHistory, createdAt);
      await closeNeo4j();
      exit();
      return;
    }

    // Normal mesaj → supervisor
    setIsProcessing(true);
    isProcessingRef.current = true;
    setStatusMsg(null);
    resetTranscriptScroll();
    resetProgressLog(false);
    const nextVisibleMessages: Message[] = [...messages, { role: 'user', content: trimmed }];
    const nextSessionHistory: Message[] = [...sessionHistory, { role: 'user', content: trimmed }];
    setMessages(nextVisibleMessages);
    setSessionHistory(nextSessionHistory);

    try {
      const supervisorHistory = nextSessionHistory.map(message => ({ ...message }));
      const supervisorResult = await runSupervisor(supervisorHistory);
      const finalVisibleMessages = supervisorResult?.finalResponse
        ? [...nextVisibleMessages, { role: 'assistant', content: supervisorResult.finalResponse } as Message]
        : nextVisibleMessages;
      const finalSessionHistory = supervisorResult?.history ?? nextSessionHistory;
      setMessages(finalVisibleMessages);
      setSessionHistory(finalSessionHistory);
      saveSession(finalSessionHistory, createdAt);
    } catch (e) {
      setStatusMsg(`Error: ${(e as Error).message}`);
    }
    isProcessingRef.current = false;
    setIsProcessing(false);
  }, [messages, sessionHistory, createdAt, exit, resetProgressLog, resetTranscriptScroll]);

  const handleMenuSelect = useCallback((cmd: string) => {
    setView('chat');
    handleSubmit(cmd);
  }, [handleSubmit]);

  const handleResumeSelect = useCallback((item: { value: string }) => {
    const session = archivedSessions.find(entry => entry.filename === item.value);
    if (!session) return;
    if (sessionHistory.length > 0) {
      archiveSession(sessionHistory, createdAt);
      deleteActiveSession();
    }
    resetProgressLog(true);
    resetTranscriptScroll();
    emitSessionReset();
    setSessionHistory(session.data.history);
    setMessages(buildVisibleChatMessages(session.data.history));
    setCreatedAt(session.data.createdAt);
    saveSession(session.data.history, session.data.createdAt);
    setStatusMsg(`Oturum yükle: ${session.data.history.filter(m => m.role === 'user').length} soru.`);
    setView('chat');
  }, [archivedSessions, sessionHistory, createdAt, resetProgressLog, resetTranscriptScroll]);

  const handleDeleteSelect = useCallback((item: { value: string }) => {
    const clearLiveSession = (message: string) => {
      setMessages([]);
      setSessionHistory([]);
      setCreatedAt(new Date().toISOString());
      resetProgressLog(true);
      resetTranscriptScroll();
      emitSessionReset();
      setStatusMsg(message);
      setView('chat');
    };

    if (item.value === '__all__') {
      const deletedCount = deleteAllSessions();
      setArchivedSessions([]);
      clearLiveSession(`${deletedCount} oturum dosyası silindi.`);
      return;
    }

    const session = archivedSessions.find(entry => entry.filename === item.value);
    if (!session) return;

    const deletedCount = deleteSessionsByCreatedAt(session.data.createdAt);
    if (session.data.createdAt === createdAt) {
      clearLiveSession(
        deletedCount > 1
          ? 'Seçilen canlı oturumun arşiv ve aktif kopyaları silindi.'
          : 'Seçilen canlı oturum silindi.',
      );
      setArchivedSessions(listDeletableSessions());
      return;
    }

    const remaining = listDeletableSessions();
    setArchivedSessions(remaining);
    setStatusMsg(
      deletedCount > 1
        ? 'Seçilen oturumun arşiv ve aktif kopyaları silindi.'
        : 'Seçilen arşiv oturumu silindi.',
    );
    if (remaining.length === 0) {
      setView('chat');
    }
  }, [archivedSessions, createdAt, resetTranscriptScroll, resetProgressLog]);

  const visibleLogLines = useMemo(() => {
    const scrollStart = Math.max(0, progressLog.length - LOG_LINES - logScrollOffset);
    return progressLog.slice(scrollStart, scrollStart + LOG_LINES).map(line => line.slice(0, logPreviewWidth));
  }, [logPreviewWidth, logScrollOffset, progressLog]);

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Header />

      <Box marginTop={1} flexDirection="column">
        <MessageList viewport={transcriptViewport} maxLineWidth={messageLineWidth} />

        <Box marginTop={1}>
          <Text dimColor>{statusMsg ?? ' '}</Text>
        </Box>

        {showLog && (progressLog.length > 0 || isProcessing) && (() => {
          const scrollStart = Math.max(0, progressLog.length - LOG_LINES - logScrollOffset);
          const visibleLines = visibleLogLines;
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
                {progressLog.length === 0
                  ? <Text dimColor>  Loglar bekleniyor...</Text>
                  : visibleLines.map((line, i) => (
                      <Text key={i} dimColor>{line.slice(0, 140)}</Text>
                    ))
                }
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
              items={archivedSessions.map((s) => ({
                label: `${new Date(s.data.lastActiveAt).toLocaleString('tr-TR')} · ${s.data.history.filter(m => m.role === 'user').length} soru`,
                value: s.filename,
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
                ...archivedSessions.map((s) => ({
                  label: `${s.isActive ? '[active] ' : ''}${new Date(s.data.lastActiveAt).toLocaleString('tr-TR')} · ${s.data.history.filter((m: Message) => m.role === 'user').length} soru`,
                  value: s.filename,
                })),
              ]}
              onSelect={handleDeleteSelect}
            />
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {showLog
            ? '/ commands · exit quit · ↑↓ log · ^L close'
            : hasProgressLogs
              ? '/ commands · exit quit · ↑↓ sohbet · ^L log'
              : '/ commands · exit quit · ↑↓ sohbet'}
        </Text>
      </Box>
    </Box>
  );
}

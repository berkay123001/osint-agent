import { EventEmitter } from 'node:events';
import type { LLMTelemetryEvent } from './llmTelemetry.js';

/**
 * Global progress event emitter.
 * All tool/agent log messages are routed through this emitter.
 * chatInk.tsx listens to this emitter and displays messages in the UI.
 * Nothing is written to stderr — Ink stdout management is preserved.
 *
 * 'progress' — short summary (TUI + web)
 * 'detail'   — full tool output (only the web log panel listens)
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const progressEmitter = emitter;

export function emitProgress(message: string): void {
  emitter.emit('progress', message);
}

/**
 * Sends the full tool output to the web log panel — the TUI does not see it.
 * toolName: tool name, output: raw output (untruncated)
 */
export function emitToolDetail(toolName: string, output: string, toolCallId?: string): void {
  emitter.emit('detail', { toolName, output, toolCallId });
}

export function emitTelemetry(event: LLMTelemetryEvent): void {
  emitter.emit('telemetry', event);
}

export function emitSessionReset(): void {
  emitter.emit('session-reset');
}

export function emitSessionGraphDirty(): void {
  emitter.emit('session-graph-dirty');
}

/** Sends full strategy phase content (plan/review/synthesize) to the log panel detail view. */
export function emitStrategyDetail(content: string): void {
  emitter.emit('strategy-detail', content);
}

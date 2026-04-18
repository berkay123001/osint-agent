/**
 * Structured Logger — OSINT Agent
 *
 * Log level control via LOG_LEVEL env var: DEBUG | INFO | WARN | ERROR (default: INFO)
 * LOG_FORMAT=JSON enables structured output mode
 *
 * Usage:
 *   import { logger } from '../lib/logger.js'
 *   logger.info('TOOL', 'Sherlock scan started', { username: 'torvalds' })
 *   logger.toolStart('sherlock', { username: 'torvalds' })
 */

import chalk from 'chalk'
import { emitProgress } from './progressEmitter.js'

// ─── Tipler ──────────────────────────────────────────────────────────────────
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
type Component = 'AGENT' | 'TOOL' | 'UI' | 'GRAPH' | 'OBSIDIAN' | 'SYSTEM' | 'SEARCH' | 'CHAT'

interface LogEntry {
  ts: string
  level: LogLevel
  component: Component
  message: string
  details?: Record<string, unknown>
  duration?: number
}

// ─── Level Priorities ──────────────────────────────────────────────────────
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

// ─── Configuration ──────────────────────────────────────────────────────────
// Lazy evaluation — ESM import hoisting'den etkilenmez
const jsonMode = process.env.LOG_FORMAT?.toUpperCase() === 'JSON'

function getMinPriority(): number {
  const level = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase() as LogLevel
  return LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.INFO
}

// ─── Renkler ─────────────────────────────────────────────────────────────────
const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  DEBUG: chalk.gray,
  INFO: chalk.white,
  WARN: chalk.yellow,
  ERROR: chalk.red,
}

const COMPONENT_COLORS: Record<Component, (s: string) => string> = {
  AGENT: chalk.magenta,
  TOOL: chalk.cyan,
  UI: chalk.green,
  GRAPH: chalk.blue,
  OBSIDIAN: chalk.hex('#a855f7'),
  SYSTEM: chalk.gray,
  SEARCH: chalk.yellow,
  CHAT: chalk.white,
}

// ─── Timestamp ───────────────────────────────────────────────────────────────
function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function isoTimestamp(): string {
  return new Date().toISOString()
}

// ─── Formatlama ──────────────────────────────────────────────────────────────
function formatTerminal(entry: LogEntry): string {
  const time = chalk.gray(`[${entry.ts}]`)
  const level = LEVEL_COLORS[entry.level](`[${entry.level}]`)
  const component = COMPONENT_COLORS[entry.component](`[${entry.component}]`)
  let msg = `${time} ${level} ${component} ${entry.message}`
  if (entry.duration !== undefined) {
    msg += chalk.gray(` (${entry.duration}ms)`)
  }
  return msg
}

function formatJson(entry: LogEntry): string {
  return JSON.stringify({
    ts: isoTimestamp(),
    level: entry.level,
    component: entry.component,
    msg: entry.message,
    ...(entry.details && { details: entry.details }),
    ...(entry.duration !== undefined && { duration: entry.duration }),
  })
}

// ─── Core Log Fonksiyonu ─────────────────────────────────────────────────────
function emit(entry: LogEntry): void {
  if (LEVEL_PRIORITY[entry.level] < getMinPriority()) return

  // Route all log output through emitProgress to the TUI log panel
  // using process.stderr.write would break Ink's layout
  const label = entry.level === 'WARN' ? '⚠️' : entry.level === 'ERROR' ? '❌' : 'ℹ️'
  emitProgress(`${label} [${entry.component}] ${entry.message}`)
}

// ─── Logger API ──────────────────────────────────────────────────────────────
export const logger = {
  debug(component: Component, message: string, details?: Record<string, unknown>): void {
    emit({ ts: timestamp(), level: 'DEBUG', component, message, details })
  },

  info(component: Component, message: string, details?: Record<string, unknown>): void {
    emit({ ts: timestamp(), level: 'INFO', component, message, details })
  },

  warn(component: Component, message: string, details?: Record<string, unknown>): void {
    emit({ ts: timestamp(), level: 'WARN', component, message, details })
  },

  error(component: Component, message: string, details?: Record<string, unknown>): void {
    emit({ ts: timestamp(), level: 'ERROR', component, message, details })
  },

  /** When a tool starts */
  toolStart(name: string, args?: Record<string, unknown>): void {
    emit({
      ts: timestamp(),
      level: 'INFO',
      component: 'TOOL',
      message: `▶ ${name} started`,
      details: args,
    })
  },

  /** When a tool completes */
  toolResult(name: string, result: string, durationMs?: number): void {
    const success = !result.startsWith('❌') && !result.startsWith('Unknown tool')
    emit({
      ts: timestamp(),
      level: success ? 'INFO' : 'WARN',
      component: 'TOOL',
      message: `${success ? '✅' : '❌'} ${name}: ${result.slice(0, 150)}`,
      duration: durationMs,
    })
  },

  /** Agent thinking/reasoning phase */
  agentThinking(agentName: string): void {
    emit({
      ts: timestamp(),
      level: 'INFO',
      component: 'AGENT',
      message: `⚙️  [${agentName}] Thinking...`,
    })
  },

  /** Agent decision/routing log */
  agentDecision(agentName: string, decision: string): void {
    emit({
      ts: timestamp(),
      level: 'DEBUG',
      component: 'AGENT',
      message: `[${agentName}] Decision: ${decision}`,
    })
  },
}

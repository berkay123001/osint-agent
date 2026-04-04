/**
 * Yapılandırılmış Logger — OSINT Agent
 *
 * LOG_LEVEL env var ile seviye kontrolü: DEBUG | INFO | WARN | ERROR (varsayılan: INFO)
 * LOG_FORMAT=JSON ile structured output modu
 *
 * Kullanım:
 *   import { logger } from '../lib/logger.js'
 *   logger.info('TOOL', 'Sherlock taraması başladı', { username: 'torvalds' })
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

// ─── Seviye Öncelikleri ──────────────────────────────────────────────────────
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

// ─── Konfigürasyon ───────────────────────────────────────────────────────────
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

// ─── Zaman Damgası ───────────────────────────────────────────────────────────
function timestamp(): string {
  return new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

  // Tüm log çıktısını emitProgress üzerinden TUI log panel'ine yönlendir
  // process.stderr.write kullanmak Ink layout'unu bozar
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

  /** Tool çalışmaya başladığında */
  toolStart(name: string, args?: Record<string, unknown>): void {
    emit({
      ts: timestamp(),
      level: 'INFO',
      component: 'TOOL',
      message: `▶ ${name} başladı`,
      details: args,
    })
  },

  /** Tool tamamlandığında */
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

  /** Agent düşünme/düşünce aşaması */
  agentThinking(agentName: string): void {
    emit({
      ts: timestamp(),
      level: 'INFO',
      component: 'AGENT',
      message: `⚙️  [${agentName}] Düşünüyor...`,
    })
  },

  /** Agent karar/routing log'u */
  agentDecision(agentName: string, decision: string): void {
    emit({
      ts: timestamp(),
      level: 'DEBUG',
      component: 'AGENT',
      message: `[${agentName}] Karar: ${decision}`,
    })
  },
}

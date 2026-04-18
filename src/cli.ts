#!/usr/bin/env node
/**
 * cli.ts — Entry point for the `osint` global command
 *
 * npm install -g osint-agent → makes the `osint` command available.
 *
 * Usage:
 *   osint                   Start interactive REPL
 *   osint "question"        Send a single question
 *   osint --setup           Docker + .env setup wizard
 *   osint --uninstall       Uninstall wizard (Docker, .env, sessions)
 *   osint --graph           Neo4j graph visualization server (port 3333)
 *   osint --version         Show version
 *   osint --help            Show help
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import chalk from 'chalk'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const pkgPath = join(__dirname, '..', 'package.json')
let version = '1.0.0'
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  version = pkg.version ?? '1.0.0'
} catch { /* fallback */ }

const args = process.argv.slice(2)

// ── Flag handling ───────────────────────────────────────────────────────

if (args.includes('--version') || args.includes('-v')) {
  console.log(`osint-agent v${version}`)
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
${chalk.bold.cyan('osint-agent')} v${version} — Multi-agent open source intelligence system

${chalk.bold('Usage:')}
  ${chalk.green('osint')}                   Start interactive REPL
  ${chalk.green('osint')} "question"        Send a single question and print result
  ${chalk.green('osint')} --setup           Setup wizard (Docker + .env + Neo4j + Python)
  ${chalk.green('osint')} --uninstall       Uninstall wizard (Docker, .env, sessions)
  ${chalk.green('osint')} --graph           Neo4j graph visualization server (port 3333)
  ${chalk.green('osint')} --version         Show version
  ${chalk.green('osint')} --help            This help

${chalk.bold('REPL Commands:')}
  /reset     Reset and archive session
  /history   Session history
  /resume    List and select saved sessions
  exit       Archive session and exit

${chalk.bold('Agents:')}
  Supervisor    Coordinator + graph + report
  Identity      Person/username/email research
  Media         Image/news verification
  Academic      Academic paper search

${chalk.bold('Requirements:')}
  Node.js 18+, OpenRouter API key
  Optional: Docker (SearXNG + Firecrawl), Neo4j, Python 3.10+
`)
  process.exit(0)
}

// ── Docker + .env setup ─────────────────────────────────────────────────

if (args.includes('--setup')) {
  const { runSetup } = await import('./tools/setupCommand.js')
  await runSetup()
  process.exit(0)
}

// ── Uninstall ────────────────────────────────────────────────────────────

if (args.includes('--uninstall')) {
  const { runUninstall } = await import('./tools/setupCommand.js')
  await runUninstall()
  process.exit(0)
}

// ── Graph visualization server ──────────────────────────────────────────

if (args.includes('--graph')) {
  await import('./graphServer.js')
  process.exit(0)
}

// ── Single question mode ────────────────────────────────────────────────

if (args.length > 0 && !args[0].startsWith('-')) {
  const message = args.join(' ')
  const { runSupervisor } = await import('./agents/supervisorAgent.js')
  const { closeNeo4j } = await import('./lib/neo4j.js')
  const history: Array<{ role: string; content: string }> = [
    { role: 'user', content: message },
  ]

  try {
    await runSupervisor(history as any)
  } catch (e) {
    console.error(chalk.red(`Error: ${(e as Error).message}`))
  } finally {
    await closeNeo4j()
    process.exit(0)
  }
}

// ── Interactive REPL ────────────────────────────────────────────────────

await import('./chat.js')

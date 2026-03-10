import { spawn } from 'node:child_process'
import neo4j from 'neo4j-driver'

const TEST_CONTAINER_NAME = 'neo4j-osint-test'
const TEST_HTTP_PORT = '17474'
const TEST_BOLT_PORT = '17687'
const TEST_URI = `bolt://localhost:${TEST_BOLT_PORT}`
const TEST_USER = 'neo4j'
const TEST_PASSWORD = 'graph-test-password'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runCommand(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; stdio?: 'inherit' | 'pipe'; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    stdio: options.stdio === 'inherit' ? 'inherit' : 'pipe',
    env: options.env ?? process.env,
  })

  let stdout = ''
  let stderr = ''

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
  }

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode) => resolve(exitCode ?? 1))
  })

  if (code !== 0 && !options.allowFailure) {
    throw new Error(stderr.trim() || stdout.trim() || `${command} ${args.join(' ')} failed`)
  }

  return { code, stdout, stderr }
}

async function ensureDockerAvailable(): Promise<void> {
  await runCommand('docker', ['ps'])
}

async function cleanupContainer(): Promise<void> {
  await runCommand('docker', ['rm', '-f', TEST_CONTAINER_NAME], { allowFailure: true })
}

async function startContainer(): Promise<void> {
  await cleanupContainer()
  await runCommand('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    TEST_CONTAINER_NAME,
    '-p',
    `${TEST_HTTP_PORT}:7474`,
    '-p',
    `${TEST_BOLT_PORT}:7687`,
    '-e',
    `NEO4J_AUTH=${TEST_USER}/${TEST_PASSWORD}`,
    'neo4j:latest',
  ])
}

async function waitForNeo4j(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const driver = neo4j.driver(TEST_URI, neo4j.auth.basic(TEST_USER, TEST_PASSWORD))
    try {
      await driver.getServerInfo()
      await driver.close()
      return
    } catch {
      await driver.close()
      await delay(2000)
    }
  }

  throw new Error('Disposable Neo4j test container hazır olmadı.')
}

async function runGraphSuite(): Promise<number> {
  const env = {
    ...process.env,
    NEO4J_URI: TEST_URI,
    NEO4J_USER: TEST_USER,
    NEO4J_PASSWORD: TEST_PASSWORD,
    NEO4J_ALLOW_CLEAR: '1',
  }

  const result = await runCommand(
    'node',
    ['--import', 'tsx', '--test', '--test-concurrency=1', 'src/lib/neo4j.integration.test.ts'],
    { stdio: 'inherit', env, allowFailure: true }
  )

  return result.code
}

async function main(): Promise<void> {
  let exitCode = 1

  try {
    await ensureDockerAvailable()
    await startContainer()
    await waitForNeo4j()
    exitCode = await runGraphSuite()
  } finally {
    await cleanupContainer()
  }

  process.exit(exitCode)
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error)
  await cleanupContainer()
  process.exit(1)
})
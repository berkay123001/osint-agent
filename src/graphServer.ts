/**
 * OSINT Graph Visualization Server
 * Neo4j verisini D3.js force-directed graph olarak tarayıcıda görüntüler.
 * Kullanım: npm run graph
 */

import 'dotenv/config'
import http from 'http'
import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { exportGraphForVisualization, closeNeo4j } from './lib/neo4j.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = Number(process.env.GRAPH_PORT) || 3333

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')

  if (req.url === '/api/graph') {
    try {
      const data = await exportGraphForVisualization()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (e as Error).message }))
    }
    return
  }

  // Statik dosya sunumu — sadece public/ klasöründen
  const safePath = (req.url === '/' ? '/index.html' : req.url) ?? '/index.html'
  const cleanPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(__dirname, 'public', cleanPath)

  // Path traversal koruması
  const publicDir = path.join(__dirname, 'public')
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  const ext = path.extname(filePath)
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }

  try {
    const content = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' })
    res.end(content)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }
})

server.listen(PORT, () => {
  console.log(`\n🕸️  OSINT Graph Viewer: http://localhost:${PORT}`)
  console.log(`📊 API endpoint:       http://localhost:${PORT}/api/graph`)
  console.log(`\nÇıkmak için Ctrl+C\n`)
})

process.on('SIGINT', async () => {
  console.log('\nKapatılıyor...')
  await closeNeo4j()
  server.close()
  process.exit(0)
})

#!/usr/bin/env bash
# OSINT Graph Viewer — başlat / yeniden başlat
# Kullanım: ./graph.sh

PORT=3333
cd "$(dirname "$0")"

# Eski instance varsa öldür
OLD_PID=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "⛔ Port $PORT'ta çalışan process kapatılıyor (PID: $OLD_PID)..."
  kill "$OLD_PID" 2>/dev/null
  sleep 0.5
fi

echo "🚀 Graph Viewer başlatılıyor..."
npx tsx src/graphServer.ts

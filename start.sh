#!/usr/bin/env bash
# OSINT Agent — Graph Web UI Başlatıcı
# Kullanım: ./start.sh
#
# Başlattığı servisler:
#   - Graph Server (D3.js görselleştirme)  → http://localhost:3333

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.pids"

cd "$SCRIPT_DIR"

# Zaten çalışıyor mu kontrol et
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "⚠️  Graph server zaten çalışıyor (PID: $EXISTING_PID)"
    echo "   → http://localhost:${GRAPH_PORT:-3333}"
    echo "   Durdurmak için: ./stop.sh"
    exit 0
  fi
fi

echo "🚀 OSINT Agent Graph Server başlatılıyor..."
echo ""

# .env'den port oku (yoksa 3333)
GRAPH_PORT="${GRAPH_PORT:-3333}"

# Graph server'ı arka planda başlat
nohup npx tsx src/graphServer.ts > .graph-server.log 2>&1 &
GRAPH_PID=$!
echo "$GRAPH_PID" > "$PID_FILE"

# Sunucunun başlamasını bekle (max 10 saniye)
echo -n "   Bekleniyor"
for i in {1..20}; do
  sleep 0.5
  echo -n "."
  if kill -0 "$GRAPH_PID" 2>/dev/null; then
    # Port dinleniyor mu kontrol et
    if node -e "
      const net = require('net')
      const s = net.createConnection($GRAPH_PORT, '127.0.0.1')
      s.on('connect', () => { process.exit(0) })
      s.on('error', () => { process.exit(1) })
    " 2>/dev/null; then
      break
    fi
  else
    echo ""
    echo "❌ Graph server başlatılamadı. Log:"
    tail -20 .graph-server.log
    exit 1
  fi
done

echo ""
echo ""
echo "✅ Graph Server çalışıyor"
echo "   PID     : $GRAPH_PID"
echo "   Adres   : http://localhost:$GRAPH_PORT"
echo "   Log     : .graph-server.log"
echo ""
echo "Durdurmak için: ./stop.sh"

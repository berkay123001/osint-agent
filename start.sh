#!/usr/bin/env bash
# OSINT Agent — Graph Web UI Başlatıcı
# Kullanım: ./start.sh
# Servis: Graph Server (D3.js görselleştirme) → http://localhost:3333
# Not: Sadece Node.js/tsx gerekli — Python/conda gerekmez.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.pids"
GRAPH_PORT="${GRAPH_PORT:-3333}"

cd "$SCRIPT_DIR"

# Zaten çalışıyor mu kontrol et (port bazlı)
if node -e "
  const net = require('net')
  const s = net.createConnection($GRAPH_PORT, '127.0.0.1')
  s.on('connect', () => process.exit(0))
  s.on('error',   () => process.exit(1))
" 2>/dev/null; then
  echo "⚠️  Port $GRAPH_PORT zaten açık — Graph server çalışıyor olabilir."
  echo "   → http://localhost:$GRAPH_PORT"
  echo "   Durdurmak için: ./stop.sh"
  exit 0
fi

echo "🚀 OSINT Graph Server başlatılıyor (port $GRAPH_PORT)..."

# Arka planda başlat, log dosyasına yönlendir
nohup npx tsx "$SCRIPT_DIR/src/graphServer.ts" > "$SCRIPT_DIR/.graph-server.log" 2>&1 &
GRAPH_PID=$!
echo "$GRAPH_PID" > "$PID_FILE"

# Port açılana kadar bekle (max 15 saniye)
echo -n "   Bekleniyor"
for i in $(seq 1 30); do
  sleep 0.5
  echo -n "."
  if ! [ -d "/proc/$GRAPH_PID" ] 2>/dev/null && [ "$(uname)" = "Linux" ]; then
    echo ""
    echo "❌ Süreç erken kapandı. Log:"
    tail -20 "$SCRIPT_DIR/.graph-server.log"
    exit 1
  fi
  if node -e "
    const net = require('net')
    const s = net.createConnection($GRAPH_PORT, '127.0.0.1')
    s.on('connect', () => process.exit(0))
    s.on('error',   () => process.exit(1))
  " 2>/dev/null; then
    break
  fi
done

echo ""
echo ""
echo "✅ Graph Server hazır"
echo "   PID   : $GRAPH_PID"
echo "   Adres : http://localhost:$GRAPH_PORT"
echo "   Log   : .graph-server.log"
echo ""
echo "Durdurmak için: ./stop.sh"

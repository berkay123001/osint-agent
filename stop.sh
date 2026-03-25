#!/usr/bin/env bash
# OSINT Agent — Graph Web UI Durdurucusu
# Kullanım: ./stop.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "⚠️  PID dosyası bulunamadı — server çalışmıyor olabilir."
  exit 0
fi

PID=$(cat "$PID_FILE" 2>/dev/null || echo "")

if [[ -z "$PID" ]]; then
  echo "⚠️  PID dosyası boş."
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "🛑 Graph Server durduruluyor (PID: $PID)..."
  kill "$PID"
  sleep 1
  # Hâlâ çalışıyorsa SIGKILL
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "✅ Graph Server durduruldu."
else
  echo "⚠️  PID $PID zaten çalışmıyor."
fi

# Artık tsx ile başlatılan child process'ler de temizle
pkill -f "tsx src/graphServer.ts" 2>/dev/null || true

# PID dosyasını temizle
> "$PID_FILE"
echo "🗑️  PID dosyası temizlendi."

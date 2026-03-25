#!/usr/bin/env bash
# OSINT Agent — Graph Web UI Durdurucusu
# Kullanım: ./stop.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.pids"

PID=""
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
fi

STOPPED=0

# PID dosyasından durdur
if [ -n "$PID" ] && [ -d "/proc/$PID" ] 2>/dev/null; then
  echo "🛑 Graph Server durduruluyor (PID: $PID)..."
  kill "$PID" 2>/dev/null && STOPPED=1
  sleep 1
  # Hâlâ çalışıyorsa SIGKILL
  if [ -d "/proc/$PID" ] 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
fi

# tsx graphServer süreçlerini de temizle (güvenlik ağı)
if pkill -f "tsx.*graphServer" 2>/dev/null; then
  STOPPED=1
fi

if [ "$STOPPED" = "1" ]; then
  echo "✅ Graph Server durduruldu."
else
  echo "⚠️  Çalışan Graph Server bulunamadı."
fi

# PID dosyasını temizle
: > "$PID_FILE"
echo "🗑️  PID dosyası temizlendi."

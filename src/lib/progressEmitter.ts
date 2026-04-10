import { EventEmitter } from 'node:events';

/**
 * Global ilerleme olayı yayıcısı.
 * Tüm araç/ajan log mesajları bu emitter üzerinden iletilir.
 * chatInk.tsx bu emitter'ı dinleyerek mesajları UI'da gösterir.
 * stderr'e hiçbir şey yazılmaz — Ink stdout yönetimi bozulmaz.
 *
 * 'progress' — kısa özet (TUI + web)
 * 'detail'   — tam araç çıktısı (sadece web log paneli dinler)
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const progressEmitter = emitter;

export function emitProgress(message: string): void {
  emitter.emit('progress', message);
}

/**
 * Tam araç çıktısını web log paneline gönderir — TUI görmez.
 * toolName: araç adı, output: ham çıktı (kırpılmamış)
 */
export function emitToolDetail(toolName: string, output: string): void {
  emitter.emit('detail', { toolName, output });
}

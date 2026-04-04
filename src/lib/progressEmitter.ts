import { EventEmitter } from 'node:events';

/**
 * Global ilerleme olayı yayıcısı.
 * Tüm araç/ajan log mesajları bu emitter üzerinden iletilir.
 * chatInk.tsx bu emitter'ı dinleyerek mesajları UI'da gösterir.
 * stderr'e hiçbir şey yazılmaz — Ink stdout yönetimi bozulmaz.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const progressEmitter = emitter;

export function emitProgress(message: string): void {
  emitter.emit('progress', message);
}

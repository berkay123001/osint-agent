#!/usr/bin/env node
import 'dotenv/config';
import { emitProgress } from './lib/progressEmitter.js';
import { startLogServer } from './logServer.js';

// Ink stdout'u yönetir — hiçbir şey stderr/stdout'a doğrudan yazmamalı
// Tüm console.* çağrıları emitProgress üzerinden TUI log panel'ine yönlendirilir
process.env.LOG_LEVEL = 'ERROR';

// Web tabanlı log panelini başlat (http://localhost:3334)
startLogServer();
console.log = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.info = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.warn = (...args: unknown[]) => emitProgress(args.map(String).join(' '));
console.error = (...args: unknown[]) => emitProgress(args.map(String).join(' '));

import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';

const { waitUntilExit } = render(React.createElement(App));
await waitUntilExit();

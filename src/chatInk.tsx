#!/usr/bin/env node
import 'dotenv/config';
import { emitProgress } from './lib/progressEmitter.js';
import { startLogServer } from './logServer.js';

// Ink manages stdout — nothing should write directly to stderr/stdout
// All console.* calls are routed through emitProgress to the TUI log panel
process.env.LOG_LEVEL = 'ERROR';

// Start the web-based log panel (http://localhost:3334)
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

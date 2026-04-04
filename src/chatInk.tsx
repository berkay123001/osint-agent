#!/usr/bin/env node
import 'dotenv/config';

// Ink stdout'u yönetir — tüm console.log çıktısını stderr'e yönlendir
process.env.LOG_LEVEL = 'ERROR';
const _origLog = console.log;
const _origInfo = console.info;
const _origWarn = console.warn;
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
console.warn = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');

import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';

const { waitUntilExit } = render(React.createElement(App));
await waitUntilExit();

#!/usr/bin/env node
import 'dotenv/config';
// Ink stdout'u yönetir — logger/agent console.log çıktısını bastır
process.env.LOG_LEVEL = 'ERROR';
import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';

const { waitUntilExit } = render(React.createElement(App));
await waitUntilExit();

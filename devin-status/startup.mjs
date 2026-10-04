#!/usr/bin/env node
// Startup hook: reconcile once, then spawn the detached daemon loop.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile } from './lib/reconcile.mjs';

try { reconcile(); } catch {}

const root = dirname(fileURLToPath(import.meta.url));
spawn(process.execPath, [join(root, 'daemon.mjs')], {
  detached: true, stdio: 'ignore', env: process.env,
}).unref();

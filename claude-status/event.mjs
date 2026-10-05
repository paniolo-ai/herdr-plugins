#!/usr/bin/env node
// Event hook (pane.agent_detected / pane.exited / pane.closed): reconcile
// immediately so footers appear/disappear without waiting for the daemon tick.
import { reconcile } from './lib/reconcile.mjs';

try { reconcile(); } catch {}

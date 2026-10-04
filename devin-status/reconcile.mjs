#!/usr/bin/env node
// Manual action: paniolo.devin-status.reconcile — provision/repair footers now.
import { reconcile } from './lib/reconcile.mjs';

try { reconcile(); } catch (e) { console.error(e); process.exit(1); }

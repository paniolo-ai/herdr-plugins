#!/usr/bin/env node
// Long-running reconcile loop (spawned detached by startup.mjs). Exits when
// the herdr socket stops answering (server restart -> next startup respawns).
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { herdr, LOCK_DIR, TICK_MS } from './lib/core.mjs';
import { reconcile } from './lib/reconcile.mjs';

const pidFile = join(LOCK_DIR, 'devin-status-daemon.pid');

// Single instance: if a live daemon already holds the pid file, exit.
try {
  const prev = Number(readFileSync(pidFile, 'utf8'));
  if (prev && prev !== process.pid) {
    try { process.kill(prev, 0); process.exit(0); } catch {}
  }
} catch {}
writeFileSync(pidFile, String(process.pid));

let failures = 0;
for (;;) {
  try {
    const before = Date.now();
    reconcile();
    failures = herdr('workspace', 'list') ? 0 : failures + 1;
    if (failures >= 4) process.exit(0); // server is gone
    const elapsed = Date.now() - before;
    await new Promise(r => setTimeout(r, Math.max(1000, TICK_MS - elapsed)));
  } catch {
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

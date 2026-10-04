#!/usr/bin/env node
// Opens the clicked obsidian:// URI in Obsidian, bypassing the browser/OS
// trust interstitial by launching the app directly with the URI as argv
// (the same argv the registered protocol handler would receive).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform, env } from 'node:process';

const uri = env.HERDR_PLUGIN_CLICKED_URL
  ?? JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}').clicked_url;

if (!uri?.startsWith('obsidian://')) {
  console.error(`obsidian-links: no obsidian:// URI in context (got ${JSON.stringify(uri)})`);
  process.exit(1);
}

const launch = (cmd, args) =>
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();

if (platform === 'win32') {
  const candidates = [
    join(env.LOCALAPPDATA ?? '', 'Programs', 'Obsidian', 'Obsidian.exe'),
    join(env.PROGRAMFILES ?? '', 'Obsidian', 'Obsidian.exe'),
  ];
  const exe = candidates.find(existsSync);
  if (exe) {
    launch(exe, [uri]); // direct argv — same as the protocol command, no shell
  } else {
    // fallback: protocol handler via PowerShell (single-quoted, & is safe)
    launch('powershell', ['-NoProfile', '-Command', `Start-Process '${uri.replace(/'/g, "''")}'`]);
  }
} else if (platform === 'darwin') {
  launch('open', ['-b', 'md.obsidian', uri]);
} else {
  launch('xdg-open', [uri]);
}

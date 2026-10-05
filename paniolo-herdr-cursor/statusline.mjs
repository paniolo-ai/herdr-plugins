#!/usr/bin/env node
// Cursor CLI statusLine bridge. Point ~/.cursor/cli-config.json at this file:
//
//   "statusLine": {
//     "type": "command",
//     "command": "node \"/path/to/paniolo-herdr-cursor/statusline.mjs\""
//   }
//
// Cursor spawns it on each conversation update with a StatusLinePayload on
// stdin. We cache that payload for the footer/reconcile loops (model, context
// %, token totals — none of which live in the citation transcript), then
// print a compact line for Cursor's own status area.
import { readFileSync } from 'node:fs';
import { writeSessionCache } from './lib/cursor.mjs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { process.exit(0); }
if (!raw.trim()) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

try { writeSessionCache(payload); } catch {}

const model = payload.model?.display_name ?? payload.model?.id ?? 'cursor';
const param = payload.model?.param_summary
  ? String(payload.model.param_summary).replace(/[()]/g, '').trim()
  : '';
const pct = payload.context_window?.used_percentage;
const ctx = pct == null || !Number.isFinite(Number(pct))
  ? null
  : `C${String(Math.min(99, Math.max(0, Math.round(Number(pct))))).padStart(2, '0')}%`;
const max = payload.model?.max_mode ? 'max' : '';
const bits = [model, param, ctx, max].filter(Boolean);
process.stdout.write(bits.join(' ') + '\n');

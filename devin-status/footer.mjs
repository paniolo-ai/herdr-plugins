#!/usr/bin/env node
// Renders the status footer inside a plugin pane. The pane's label
// (devin-status:<target>) names the devin pane it mirrors; if that label is
// missing it falls back to the devin pane in its own tab.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { env } from 'node:process';
import {
  herdr, readTranscript, transcriptPath, fmtTok, fmtDur,
  git, repoRoot, TICK_MS, USAGE_CACHE,
} from './lib/core.mjs';

const ESC = '\x1b';
const BAND = '48;2;49;50;68';   // surface0
const TEXT = '38;2;205;214;244'; // text
const DIM = '38;2;147;153;178';  // subtext0

const selfId = env.HERDR_PANE_ID;
const argvTarget = process.argv[2] ?? null;
let target = argvTarget;
let prevTotal = 0, prevTime = Date.now();
let lastSig = '', tick = 0;

function resolveTarget(selfPane) {
  const m = (selfPane?.label ?? '').match(/^devin-status:(\S+)/);
  if (m) return m[1];
  if (argvTarget) return argvTarget;
  const panes = herdr('pane', 'list')?.panes ?? [];
  return panes.find(p => p.tab_id === selfPane?.tab_id && p.agent === 'devin')?.pane_id ?? null;
}

function readUsageCache() {
  try { return JSON.parse(readFileSync(USAGE_CACHE, 'utf8')); } catch { return null; }
}

function frame(p) {
  const title = String(p?.title ?? '');
  const task = String(p?.terminal_title_stripped ?? '').replace(/^\S+\.exe:\s*/, '');
  const state = String(p?.agent_status ?? '');
  const sess = String(p?.agent_session?.value ?? '');

  let tokens = '', idle = '', dirty = '';
  if (sess) {
    try {
      const tp = transcriptPath(sess);
      const idleSecs = (Date.now() - statSync(tp).mtimeMs) / 1000;
      if (idleSecs >= 90) idle = `idle ${fmtDur(idleSecs)}`;
      const t = readTranscript(sess);
      const fm = t?.final_metrics;
      if (fm?.total_prompt_tokens) {
        tokens = `${fmtTok(fm.total_prompt_tokens)} in - ${fmtTok(fm.total_completion_tokens)} out`;
        if (fm.total_cached_tokens) tokens += ` - ${fmtTok(fm.total_cached_tokens)} cached`;
        const total = fm.total_prompt_tokens + fm.total_completion_tokens;
        const elapsedMin = (Date.now() - prevTime) / 60000;
        if (prevTotal > 0 && total > prevTotal && elapsedMin > 0)
          tokens += ` - +${fmtTok(Math.round((total - prevTotal) / elapsedMin))}/min`;
        prevTotal = total; prevTime = Date.now();
      }
      // Dirty repos: pane cwd + every repo devin wrote to this session.
      const roots = new Map();
      if (p?.cwd) { const r = repoRoot(p.cwd); if (r) roots.set(r, 1); }
      for (const s of t?.steps ?? [])
        for (const tc of s.tool_calls ?? []) {
          if (!['edit', 'write', 'notebook_edit'].includes(tc.function_name)) continue;
          const fp = tc.arguments?.file_path;
          const r = fp && repoRoot(fp);
          if (r) roots.set(r, 1);
        }
      const parts = [];
      for (const root of roots.keys()) {
        const st = git(['status', '--porcelain'], root).split('\n').filter(Boolean);
        if (!st.length) continue;
        const m = st.filter(l => !l.startsWith('??')).length;
        const u = st.length - m;
        let seg2 = basename(root);
        if (m) seg2 += ` ${m}m`;
        if (u) seg2 += ` ${u}u`;
        parts.push(seg2);
      }
      if (parts.length) dirty = `dirty ${parts.join(' - ')}`;
    } catch {}
  }

  let quota = '', spent = '';
  const u = readUsageCache();
  if (u) {
    const parts = [];
    const now = Math.floor(Date.now() / 1000);
    if (u.daily != null) {
      let d = `daily ${u.daily}%`;
      const r = u.dailyReset && fmtDur(u.dailyReset - now);
      if (r) d += ` (${r})`;
      parts.push(d);
    }
    if (u.weekly != null) {
      let w = `weekly ${u.weekly}%`;
      const r = u.weeklyReset && fmtDur(u.weeklyReset - now);
      if (r) w += ` (${r})`;
      parts.push(w);
    }
    if (u.monthlyCredits > 0)
      parts.push(`monthly ${Math.floor(100 * u.availableCredits / u.monthlyCredits)}%`);
    if (parts.length) quota = `quota ${parts.join(' - ')}`;
    if (u.overageMicros != null && Number(u.overageMicros) !== 0) {
      spent = `spent $${Math.abs(Number(u.overageMicros) / 1e6).toFixed(2)}`;
      const r = u.planEnd && fmtDur((Date.parse(u.planEnd) - Date.now()) / 1000);
      if (r) spent += ` (${r} left)`;
    }
  }

  const scroll = (p?.scroll?.offset_from_bottom ?? 0) > 0
    ? `scrolled +${p.scroll.offset_from_bottom}` : '';
  const stateLine = [state, sess, scroll, idle].filter(Boolean).join(' - ');
  const taskLine = [task, dirty].filter(Boolean).join(' - ');
  const spendLine = [quota, spent].filter(Boolean).join(' - ');
  const lines = [title, taskLine, stateLine, tokens, spendLine];
  return { sig: lines.join('|'), lines };
}

function paint(lines) {
  const h = process.stdout.rows ?? 24, w = process.stdout.columns ?? 80;
  let out = `${ESC}[${BAND}m${ESC}[2J${ESC}[H${ESC}[1m${ESC}[${TEXT}m`;
  for (let i = 0; i < lines.length && i < h; i++) {
    let line = ` ${lines[i]}`;
    if (line.length > w - 1) line = line.slice(0, w - 1);
    if (i === 1) out += `${ESC}[0m${ESC}[${BAND}m${ESC}[${DIM}m`;
    out += line;
    if (i < lines.length - 1 && i < h - 1) out += '\r\n';
  }
  process.stdout.write(out + `${ESC}[0m`);
}

for (;;) {
  const self = selfId ? herdr('pane', 'get', selfId)?.pane : null;
  target = resolveTarget(self);
  // Drop a resolved target whose pane no longer exists.
  if (target && !herdr('pane', 'get', target)) target = null;
  const p = target ? herdr('pane', 'get', target)?.pane : null;
  const { sig, lines } = frame(p);
  tick++;
  if (sig !== lastSig || tick % 4 === 0) { paint(lines); lastSig = sig; }
  await new Promise(r => setTimeout(r, TICK_MS));
}

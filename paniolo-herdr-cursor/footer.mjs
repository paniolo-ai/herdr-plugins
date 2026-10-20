#!/usr/bin/env node
// Renders the status footer inside a plugin pane. The pane's label
// (cursor-status:<target>) names the Cursor pane it mirrors; if that
// label is missing it falls back to the Cursor pane in its own tab.
import { env } from 'node:process';
import { panioloStats, panioloLine, dirtySeg } from './lib/paniolo-stats.mjs';
import {
  herdr, fmtTok, fmtDur, fmtWhen, repoRoot, TICK_MS,
} from './lib/core.mjs';
import {
  loadScan, scanTranscript, transcriptIdleSecs, MODE_LABELS, quota, quotaSeg,
} from './lib/cursor.mjs';
import { paneSnapshot, statusline } from './lib/reconcile.mjs';

const ESC = '\x1b';
const BAND = '48;2;49;50;68';    // surface0
const TEXT = '38;2;205;214;244'; // text
const DIM = '38;2;147;153;178';  // subtext0

const selfId = env.HERDR_PANE_ID;
const argvTarget = process.argv[2] ?? null;
let target = argvTarget;
let prevTotal = 0, prevTime = Date.now();
let scan = null, scanSession = null;
let lastSig = '', tick = 0;

function resolveTarget(selfPane) {
  const m = (selfPane?.label ?? '').match(/^cursor-status:(\S+)/);
  if (m) return m[1];
  if (argvTarget) return argvTarget;
  const panes = herdr('pane', 'list')?.panes ?? [];
  return panes.find(p => p.tab_id === selfPane?.tab_id && p.agent === 'cursor')?.pane_id ?? null;
}

// Monthly plan quota lane (Cursor's real windows — Included / Auto / API /
// On-Demand on a billing cycle — not Claude 5h/W or Devin D/W/M).
// Reset stamps stay as long as possible; extras drop first.
function quotaLine(q, snap, width) {
  const budget = Math.max(20, (width ?? 80) - 2);
  const build = (extras, stamps) => {
    const parts = [];
    if (q) {
      if (extras >= 2 && q.planName) parts.push(q.planName);
      if (q.includedPct != null) {
        let s = `included ${q.includedPct}%`;
        if (stamps && q.resetMs) {
          const when = fmtWhen(q.resetMs);
          const left = extras >= 1 && fmtDur((q.resetMs - Date.now()) / 1000);
          if (when) s += ` resets ${when}`;
          if (left) s += ` (${left})`;
        }
        parts.push(s);
      }
      if (q.autoPct != null) parts.push(`auto ${q.autoPct}%`);
      if (q.apiPct != null) parts.push(`api ${q.apiPct}%`);
      if (extras >= 1) {
        if (q.onDemand?.off) parts.push(`on-demand ${q.onDemand.off}`);
        else if (q.onDemand?.unlimited) parts.push('on-demand unlimited');
        else if (q.onDemand?.limit > 0) {
          const pct = Math.floor(100 * (q.onDemand.used ?? 0) / q.onDemand.limit);
          parts.push(`on-demand ${pct}% of $${q.onDemand.limit}`);
        }
      }
      const age = q.ageMs != null && fmtDur(q.ageMs / 1000);
      if (extras >= 2 && age && q.ageMs > 600_000) parts.push(`usage ${age} old`);
    } else {
      parts.push('quota —');
    }
    if (extras >= 2) {
      if (snap.vim) parts.push(`vim ${snap.vim}`);
      if (snap.worktree) parts.push(`worktree ${snap.worktree}`);
      if (snap.cacheAgeMs == null) parts.push('statusline off');
    }
    return parts.length ? `quota ${parts.join(' - ')}` : '';
  };
  for (const [extras, stamps] of [[2, true], [1, true], [0, true], [0, false]]) {
    const line = build(extras, stamps);
    if (line.length <= budget) return line;
  }
  return build(0, false);
}

function frame(p, width) {
  if (!p) return { sig: '', lines: ['cursor - no pane', '', '', '', ''] };
  const q = quota();
  const snap = paneSnapshot(p);
  const { title } = statusline(p, snap, quotaSeg(q));

  let tokens = '', dirty = '', toolCount = '';
  if (snap.path && snap.sessionId) {
    if (scanSession !== snap.sessionId) {
      scan = loadScan(snap.sessionId);
      scanSession = snap.sessionId;
      prevTotal = 0;
    }
    scan = scanTranscript(snap.path, snap.sessionId, scan);
    if (scan.tools) toolCount = `${scan.tools} tools`;
    if (scan.edits) toolCount += toolCount ? ` ${scan.edits} edits` : `${scan.edits} edits`;

    // Token totals come from the statusLine cache (not the citation transcript).
    if (snap.inTok || snap.outTok) {
      tokens = `${fmtTok(snap.inTok)} in`;
      if (snap.outTok) tokens += ` - ${fmtTok(snap.outTok)} out`;
      const total = (snap.inTok || 0) + (snap.outTok || 0);
      const elapsedMin = (Date.now() - prevTime) / 60000;
      if (prevTotal > 0 && total > prevTotal && elapsedMin > 0)
        tokens += ` - +${fmtTok(Math.round((total - prevTotal) / elapsedMin))}/min`;
      prevTotal = total; prevTime = Date.now();
    }

    const roots = new Set(scan.roots);
    const own = p.cwd && repoRoot(p.cwd);
    if (own) roots.add(own);
    dirty = dirtySeg(roots);
  }

  const idleSecs = snap.path ? transcriptIdleSecs(snap.path) : -1;
  const status = String(p.agent_status ?? '');
  const idle = idleSecs >= 90
    ? (status === 'idle' ? fmtDur(idleSecs) : `idle ${fmtDur(idleSecs)}`) : '';
  const scroll = (p.scroll?.offset_from_bottom ?? 0) > 0
    ? `scrolled +${p.scroll.offset_from_bottom}` : '';
  const task = String(snap.title ?? p.terminal_title_stripped ?? '');
  const mode = MODE_LABELS[snap.mode] ?? '';
  const agents = snap.agents > 0 ? `${snap.agents} agent${snap.agents > 1 ? 's' : ''}` : '';
  const working = status === 'working';
  const pending = working && snap.pending?.length
    ? `${[...new Set(snap.pending)].slice(0, 3).join('/')}…` : '';
  const ctx = snap.window && snap.ctxTokens
    ? `ctx ${fmtTok(snap.ctxTokens)}/${fmtTok(snap.window)}`
    : (snap.ctxPct != null ? `ctx ${snap.ctxPct}%` : '');

  const lines = [
    title,
    [task, dirty].filter(Boolean).join(' - '),
    [status, (snap.sessionId ?? '').slice(0, 8), mode, agents, pending,
      scroll, idle, ctx, toolCount, tokens].filter(Boolean).join(' - '),
    quotaLine(q, snap, width),
    panioloLine(panioloStats(p.cwd && repoRoot(p.cwd))),
  ];
  return { sig: lines.join('|'), lines };
}

// The pty's reported size can drift from the pane's real cell rect — a line
// that wraps pushes the band's first line off the top, which is where the
// statusline lives. The layout rect is the truthful size when herdr knows it.
function selfRect() {
  const panes = selfId ? herdr('pane', 'layout', '--pane', selfId)?.layout?.panes : null;
  const r = panes?.find(q => q.pane_id === selfId)?.rect;
  return r ? { w: r.width, h: r.height } : null;
}

function paint(lines, w, h) {
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

// A throw anywhere in a frame would otherwise end the render loop for good
// and leave the pane frozen on its last paint, so each tick is contained.
for (;;) {
  try {
    const self = selfId ? herdr('pane', 'get', selfId)?.pane : null;
    target = resolveTarget(self);
    if (target && !herdr('pane', 'get', target)) target = null;
    const p = target ? herdr('pane', 'get', target)?.pane : null;
    const rect = selfRect();
    const w = rect?.w ?? process.stdout.columns ?? 80;
    const h = rect?.h ?? process.stdout.rows ?? 24;
    const { sig, lines } = frame(p, w);
    tick++;
    if (sig !== lastSig || tick % 4 === 0) { paint(lines, w, h); lastSig = sig; }
  } catch {}
  await new Promise(r => setTimeout(r, TICK_MS));
}

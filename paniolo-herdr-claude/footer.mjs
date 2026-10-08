#!/usr/bin/env node
// Renders the status footer inside a plugin pane. The pane's label
// (claude-status:<target>) names the Claude Code pane it mirrors; if that
// label is missing it falls back to the Claude pane in its own tab.
import { spawn } from 'node:child_process';
import { basename, join, delimiter } from 'node:path';
import { env } from 'node:process';
import {
  herdr, fmtTok, fmtDur, fmtWhen, git, repoRoot, TICK_MS,
} from './lib/core.mjs';
import {
  quotaWindows, loadScan, scanTranscript, transcriptIdleSecs, MODE_LABELS,
} from './lib/claude.mjs';
import { paneSnapshot, quotaSeg, statusline } from './lib/reconcile.mjs';

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
  const m = (selfPane?.label ?? '').match(/^claude-status:(\S+)/);
  if (m) return m[1];
  if (argvTarget) return argvTarget;
  const panes = herdr('pane', 'list')?.panes ?? [];
  return panes.find(p => p.tab_id === selfPane?.tab_id && p.agent === 'claude')?.pane_id ?? null;
}

// Paniolo stats per repo (staleness ledger, wiki findings, qmd index), cached
// 5 min. Each probe is far heavier than git status, so they run detached and
// in parallel: the footer paints immediately with whatever it already has and
// picks up the new numbers on the tick after they land.
const panioloCache = new Map(); // root -> { at, stats, running }

// A child environment with the repo's node_modules/.bin ahead of PATH.
// Windows exposes the variable as `Path`, so every casing is dropped before
// ours goes in — otherwise the child can read the original and ignore it.
function withBinPath(root) {
  const next = { ...env };
  for (const k of Object.keys(next)) if (k.toLowerCase() === 'path') delete next[k];
  next.PATH = [join(root, 'node_modules', '.bin'), env.PATH ?? '']
    .filter(Boolean).join(delimiter);
  return next;
}

function runAsync(cmd, cwd, childEnv) {
  return new Promise(resolve => {
    let out = '';
    try {
      const child = spawn(cmd, {
        cwd, shell: true, windowsHide: true, env: childEnv,
      });
      child.stdout?.on('data', d => { out += d; });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out));
      setTimeout(() => { try { child.kill(); } catch {} }, 30_000).unref();
    } catch { resolve(''); }
  });
}

async function refreshPaniolo(root) {
  const entry = panioloCache.get(root) ?? { at: 0, stats: null };
  entry.running = true;
  panioloCache.set(root, entry);
  const childEnv = withBinPath(root);
  const [staleOut, wikiOut, qmdOut] = await Promise.all([
    runAsync('paniolo stale list', root, childEnv),
    runAsync('paniolo wiki', root, childEnv),
    runAsync('paniolo qmd status', root, childEnv),
  ]);
  const stats = {};
  try {
    const items = JSON.parse(staleOut || 'null');
    if (Array.isArray(items)) {
      const c = {};
      for (const it of items) c[it.state] = (c[it.state] ?? 0) + 1;
      stats.stale = c;
    }
  } catch {}
  try {
    let e = 0, w = 0;
    for (const m of wikiOut.matchAll(/(\d+) error,\s*(\d+) warn/g)) {
      e += Number(m[1]); w += Number(m[2]);
    }
    if (e || w) { stats.wikiErr = e; stats.wikiWarn = w; }
  } catch {}
  try {
    const m = qmdOut.match(/(\d+) active document/);
    if (m) stats.qmdDocs = Number(m[1]);
  } catch {}
  panioloCache.set(root, { at: Date.now(), stats, running: false });
}

function panioloStats(root) {
  const hit = panioloCache.get(root);
  if (hit?.running) return hit.stats;
  if (!hit || Date.now() - hit.at >= 300_000) refreshPaniolo(root);
  return hit?.stats ?? null;
}

function dirtySeg(roots) {
  const parts = [];
  for (const root of roots) {
    const st = git(['status', '--porcelain'], root).split('\n').filter(Boolean);
    if (!st.length) continue;
    const m = st.filter(l => !l.startsWith('??')).length;
    const u = st.length - m;
    let seg = basename(root);
    if (m) seg += ` ${m}m`;
    if (u) seg += ` ${u}u`;
    parts.push(seg);
  }
  return parts.length ? `dirty ${parts.join(' - ')}` : '';
}

// Rate-limit lane. A window whose cached reading has expired renders as `?`
// with the cache age alongside, rather than a number that is no longer true.
// Rate-limit lane, written to fit the pane. The reset stamps are the point of
// the lane, so the extras (time remaining, credits, cache age) are dropped
// before the stamps are, and the stamps only go in the narrowest pane.
function limitsLine(q, width) {
  if (!q) return '';
  const now = Date.now();

  const build = (tier, extras) => {
    const parts = [];
    for (const w of q.windows) {
      if (w.pct == null) {
        // The window rolled over since the reading was taken. Say when it
        // rolled and what the old one ended at, rather than a bare `?`. The
        // next reset is extrapolated, so it carries a `~`.
        const next = w.nextResetMs ? fmtWhen(w.nextResetMs) : '';
        if (tier === 0) {
          const ago = fmtDur((now - w.rolledAtMs) / 1000);
          const was = w.lastPct != null ? `, was ${w.lastPct}%` : '';
          parts.push(`${w.label} rolled ${fmtWhen(w.rolledAtMs)}${ago ? ` (${ago} ago)` : ''}${was}`
            + `${next ? `, next ~${next}` : ''}`);
        } else if (tier === 1) {
          parts.push(`${w.label} ?${next ? ` ~${next}` : ''}`);
        } else {
          parts.push(`${w.label} ?`);
        }
        continue;
      }
      const when = fmtWhen(w.resetMs);
      if (tier === 0) {
        const left = w.resetMs && fmtDur((w.resetMs - now) / 1000);
        parts.push(`${w.label} ${w.pct}%${when ? ` resets ${when}` : ''}${left ? ` (${left})` : ''}`);
      } else if (tier === 1) {
        parts.push(`${w.label} ${w.pct}%${when ? ` ${when}` : ''}`);
      } else {
        parts.push(`${w.label} ${w.pct}%`);
      }
    }
    let line = parts.length ? `limits ${parts.join(' - ')}` : '';
    if (extras >= 1) {
      if (q.spend?.limit > 0) {
        const pct = Math.floor(100 * (q.spend.used ?? 0) / q.spend.limit);
        line += `${line ? ' - ' : ''}credits ${pct}% of $${q.spend.limit}`;
      } else if (q.spend?.off) {
        line += `${line ? ' - ' : ''}credits ${q.spend.off}`;
      }
    }
    // Say how old the reading is, so a stale one is never mistaken for live.
    const age = q.ageMs != null && fmtDur(q.ageMs / 1000);
    if (extras >= 2 && age && q.ageMs > 600_000) {
      line += `${line ? ' - ' : ''}usage ${age} old${q.live ? '' : ' (/usage)'}`;
    }
    return line;
  };

  // Widest form that fits, giving up the extras before the reset stamps.
  const budget = Math.max(20, (width ?? 80) - 2);
  const forms = [[0, 2], [0, 1], [0, 0], [1, 2], [1, 1], [1, 0]];
  for (const [tier, extras] of forms) {
    const line = build(tier, extras);
    if (line.length <= budget) return line;
  }
  return build(2, 0);
}

// Fixed display order for the stale lane — positions never move; unknown
// ids append at the end with their full name.
const STALE_ORDER = [
  'pending-verification', 'confirmed-stale', 'insufficient-evidence',
  'dismissed', 'resolved-updated', 'remediation-proposed', 'obsolete',
];
const STALE_LABELS = {
  'pending-verification': 'pend',
  'confirmed-stale': 'conf',
  'insufficient-evidence': 'ins',
  'dismissed': 'dis',
  'resolved-updated': 'res',
  'remediation-proposed': 'prop',
  'obsolete': 'obs',
};

function staleSegs(c) {
  const rank = id => (STALE_ORDER.indexOf(id) + 1 || STALE_ORDER.length + 1);
  return Object.keys(c)
    .filter(id => c[id] > 0)
    .sort((a, b) => rank(a) - rank(b))
    .map(id => `${STALE_LABELS[id] ?? id} ${c[id]}`);
}

function panioloLine(cwd) {
  if (!cwd) return '';
  const root = repoRoot(cwd);
  const s = root && panioloStats(root);
  if (!s) return '';
  const parts = [];
  const segs = staleSegs(s.stale ?? {});
  if (segs.length) parts.push(`stale ${segs.join(' ')}`);
  if (s.wikiErr || s.wikiWarn) parts.push(`wiki err ${s.wikiErr} warn ${s.wikiWarn}`);
  if (s.qmdDocs) parts.push(`qmd docs ${s.qmdDocs >= 1e3 ? (s.qmdDocs / 1e3).toFixed(1) + 'k' : s.qmdDocs}`);
  return parts.length ? `Paniolo: ${parts.join(' - ')}` : '';
}

function frame(p, width) {
  if (!p) return { sig: '', lines: ['claude - no pane', '', '', '', ''] };
  const q = quotaWindows();
  const snap = paneSnapshot(p);
  const { title } = statusline(p, snap, quotaSeg(q));

  // Session totals come from an incremental walk of the transcript, so a
  // multi-megabyte file is read once and then only its new tail.
  let tokens = '', dirty = '';
  if (snap.path && snap.sessionId) {
    if (scanSession !== snap.sessionId) {
      scan = loadScan(snap.sessionId);
      scanSession = snap.sessionId;
      prevTotal = 0;
    }
    scan = scanTranscript(snap.path, snap.sessionId, scan);
    if (scan.inTok || scan.outTok) {
      tokens = `${fmtTok(scan.inTok)} in - ${fmtTok(scan.outTok)} out`;
      if (scan.cachedTok) tokens += ` - ${fmtTok(scan.cachedTok)} cached`;
      const total = scan.inTok + scan.outTok;
      const elapsedMin = (Date.now() - prevTime) / 60000;
      if (prevTotal > 0 && total > prevTotal && elapsedMin > 0)
        tokens += ` - +${fmtTok(Math.round((total - prevTotal) / elapsedMin))}/min`;
      prevTotal = total; prevTime = Date.now();
    }
    // Dirty repos: the pane cwd plus every repo Claude wrote to this session.
    const roots = new Set(scan.roots);
    const own = p.cwd && repoRoot(p.cwd);
    if (own) roots.add(own);
    dirty = dirtySeg(roots);
  }

  // The duration carries its own `idle` word only when the status has not
  // already said it, so an idle pane reads `idle 36m` rather than `idle - idle 36m`.
  const idleSecs = snap.path ? transcriptIdleSecs(snap.path) : -1;
  const status = String(p.agent_status ?? '');
  const idle = idleSecs >= 90
    ? (status === 'idle' ? fmtDur(idleSecs) : `idle ${fmtDur(idleSecs)}`) : '';
  const scroll = (p.scroll?.offset_from_bottom ?? 0) > 0
    ? `scrolled +${p.scroll.offset_from_bottom}` : '';
  const task = String(snap.title ?? p.terminal_title_stripped ?? '');
  const mode = MODE_LABELS[snap.mode] ?? '';
  const agents = snap.agents > 0 ? `${snap.agents} agent${snap.agents > 1 ? 's' : ''}` : '';
  // Tool calls still awaiting a result — what the pane is actually doing.
  const pending = snap.pending?.length
    ? `${[...new Set(snap.pending)].slice(0, 3).join('/')}…` : '';
  const ctx = snap.window
    ? `ctx ${fmtTok(snap.ctxTokens)}/${fmtTok(snap.window)}` : '';

  const lines = [
    title,
    [task, dirty].filter(Boolean).join(' - '),
    [status, (snap.sessionId ?? '').slice(0, 8), mode, agents, pending,
      scroll, idle, ctx, tokens].filter(Boolean).join(' - '),
    limitsLine(q, width),
    panioloLine(p.cwd),
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
    // Drop a resolved target whose pane no longer exists.
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

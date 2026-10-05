// Reconcile pass: report statusline metadata for every Cursor pane, clean
// up stale labels, close orphaned footers, provision missing ones, clamp heights.
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { herdr, git, FOOTER_PREFIX, FOOTER_MAX_ROWS, LOCK_DIR } from './core.mjs';
import {
  transcriptPath, tailSnapshot, MODE_LABELS, quotaSeg, refreshUsageSoon,
} from './cursor.mjs';

const home = env.USERPROFILE ?? env.HOME ?? '';
const pluginRoot = env.HERDR_PLUGIN_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));
const footerCmd = `node "${join(pluginRoot, 'footer.mjs')}"`;
const SHELL_RE = /powershell|pwsh|cmd\.exe|bash|zsh|fish/i;
// Our own statusline labels, so they can be cleared off panes that stopped
// running Cursor. Narrow enough not to touch another plugin's labels.
const OUR_LABEL_RE = /^cursor\b.*\bC\d+%/;

export function paneSnapshot(agent) {
  const sessionId = agent.agent_session?.value ?? null;
  const path = sessionId ? transcriptPath(sessionId, agent.cwd) : null;
  const snap = tailSnapshot(path, sessionId);
  return { ...snap, sessionId, path };
}

export function statusline(agent, snap, seg = quotaSeg()) {
  const model = (snap.model ?? '').replace(/^cursor-/, '');
  const cwd = agent.cwd ?? '';
  const branch = git(['branch', '--show-current'], cwd) || git(['rev-parse', '--short', 'HEAD'], cwd);
  let disp = cwd;
  if (home && disp.startsWith(home)) disp = '~' + disp.slice(home.length);
  disp = disp.replaceAll('\\', '/').replace(/\/+$/, '');

  const ctx = snap.ctxPct != null
    ? `C${String(snap.ctxPct).padStart(2, '0')}%`
    : 'C??%';
  const parts = [ctx];
  if (seg) parts.push(seg);
  if (snap.param) parts.push(String(snap.param).replace(/[()]/g, ''));
  if (snap.maxMode) parts.push('max');
  const mode = MODE_LABELS[snap.mode];
  if (mode && mode !== 'unrestricted') parts.push(mode);
  if (snap.autorun) parts.push('autorun');
  if (snap.agents > 0) parts.push(`${snap.agents} agent${snap.agents > 1 ? 's' : ''}`);
  if (branch) parts.push(branch);
  if (disp) parts.push(disp);

  const head = ['cursor', model].filter(Boolean).join(' ');
  const stats = parts.join(' ');
  return { title: `${head} ${stats}`, stats, model };
}

// Serialize reconciles across daemon + event hooks. Lock = pid file; a dead
// holder's lock is reclaimed, and the file is removed on release.
const lockPath = join(LOCK_DIR, 'cursor-status-reconcile.lock');

function acquireLock() {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    return fd;
  } catch {}
  try {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return null; } catch {} // live holder
    }
    unlinkSync(lockPath); // stale lock
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    return fd;
  } catch { return null; }
}

export function reconcile() {
  const fd = acquireLock();
  if (fd === null) return;
  try { reconcileInner(); }
  finally { closeSync(fd); try { unlinkSync(lockPath); } catch {} }
}

function reconcileInner() {
  refreshUsageSoon();
  const agents = herdr('agent', 'list')?.agents ?? [];
  const panes = herdr('pane', 'list')?.panes ?? [];
  const labelByPane = Object.fromEntries(panes.map(p => [p.pane_id, p.label]));
  const cursorAgents = agents.filter(a => a.agent === 'cursor');
  const cursorPanes = new Set(cursorAgents.map(a => a.pane_id));
  const seg = quotaSeg();

  for (const a of cursorAgents) {
    const snap = paneSnapshot(a);
    const { title, stats, model } = statusline(a, snap, seg);
    herdr('pane', 'report-metadata', a.pane_id, '--source', 'cursor-statusline',
      '--seq', String(Date.now() * 1e6), '--ttl-ms', '120000',
      '--token', `model=${model}`, '--token', `stats=${stats}`, '--title', title);
    if (labelByPane[a.pane_id] !== title) herdr('pane', 'rename', a.pane_id, title);
  }

  // Stale statusline labels on panes that no longer run Cursor.
  for (const p of panes) {
    if (cursorPanes.has(p.pane_id)) continue;
    if (OUR_LABEL_RE.test(p.label ?? '')) herdr('pane', 'rename', p.pane_id, '--clear');
  }

  // Footer bookkeeping: footers carry label cursor-status:<target>.
  const footerByTarget = new Map();
  const footerByTab = new Map();
  for (const p of panes) {
    const m = (p.label ?? '').match(/^cursor-status:(\S+)/);
    if (m) { footerByTarget.set(m[1], p.pane_id); footerByTab.set(p.tab_id, p.pane_id); }
  }
  // Orphans: footer target no longer runs Cursor -> close.
  for (const [target, footer] of footerByTarget) {
    if (!cursorPanes.has(target)) {
      herdr('pane', 'close', footer);
      const tab = panes.find(p => p.pane_id === footer)?.tab_id;
      if (tab) footerByTab.delete(tab);
      footerByTarget.delete(target);
    }
  }
  // Provision one footer per Cursor tab.
  for (const a of cursorAgents) {
    if (!a.tab_id || footerByTab.has(a.tab_id)) continue;
    const opened = herdr('plugin', 'pane', 'open', '--plugin', env.HERDR_PLUGIN_ID ?? 'paniolo-herdr-cursor',
      '--entrypoint', 'footer', '--placement', 'split', '--target-pane', a.pane_id, '--direction', 'down');
    const id = opened?.plugin_pane?.pane?.pane_id ?? opened?.pane?.pane_id ?? opened?.pane_id;
    if (id) {
      herdr('pane', 'rename', id, `${FOOTER_PREFIX}${a.pane_id}`);
      herdr('pane', 'focus', a.pane_id); // pane open may steal focus
    }
  }
  // Clamp footers to FOOTER_MAX_ROWS and resurrect dead render loops (a
  // server restart kills the footer process, leaving a bare shell prompt).
  const panesNow = herdr('pane', 'list')?.panes ?? [];
  for (const p of panesNow) {
    const m = (p.label ?? '').match(/^cursor-status:(\S+)/);
    if (!m) continue;
    const target = m[1];
    const info = herdr('pane', 'get', p.pane_id)?.pane;
    if (SHELL_RE.test(info?.terminal_title_stripped ?? '')) {
      herdr('pane', 'send-text', p.pane_id, `${footerCmd} ${target}`);
      herdr('pane', 'send-keys', p.pane_id, 'enter');
    }
    for (let i = 0; i < 8; i++) {
      const rows = herdr('pane', 'get', p.pane_id)?.pane?.scroll?.viewport_rows;
      if (!rows || rows <= FOOTER_MAX_ROWS) break;
      const r = herdr('pane', 'resize', '--pane', p.pane_id, '--direction', 'down', '--amount', '20');
      if (!r?.resize?.changed) break;
    }
  }
}

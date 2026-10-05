// Reconcile pass: report statusline metadata for every Codex pane, clean
// up stale labels, close orphaned footers, provision missing ones, clamp heights.
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { herdr, git, FOOTER_PREFIX, FOOTER_MAX_ROWS, LOCK_DIR } from './core.mjs';
import {
  quotaWindows, transcriptPath, tailSnapshot,
} from './codex.mjs';

const home = env.USERPROFILE ?? env.HOME ?? '';
const pluginRoot = env.HERDR_PLUGIN_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));
const footerCmd = `node "${join(pluginRoot, 'footer.mjs')}"`;
const SHELL_RE = /powershell|pwsh|cmd\.exe|bash|zsh|fish/i;
// Our own statusline labels, so they can be cleared off panes that stopped
// running Codex. Narrow enough not to touch another plugin's labels.
const OUR_LABEL_RE = /^codex\b.*\bC(?:\d+|\?\?)%/;

export function paneSnapshot(agent) {
  const sessionId = agent.agent_session?.value ?? null;
  const path = transcriptPath(sessionId);
  return { ...tailSnapshot(path), sessionId, path };
}

// Compact quota segment for the statusline: `5h72% 7d44%`, with `?` for a
// window whose cached reading has expired.
export function quotaSeg(q = quotaWindows()) {
  if (!q?.windows.length) return '';
  return q.windows
    .filter(w => w.label === '5h' || w.label === 'W')
    .map(w => `${w.label}${w.pct == null ? '?' : w.pct + '%'}`)
    .join(' ');
}

export function statusline(agent, snap, seg) {
  const model = (snap.model ?? '').replace(/^codex-/, '');
  const cwd = agent.cwd ?? '';
  const branch = git(['branch', '--show-current'], cwd) || git(['rev-parse', '--short', 'HEAD'], cwd);
  let disp = cwd;
  if (home && disp.startsWith(home)) disp = '~' + disp.slice(home.length);
  disp = disp.replaceAll('\\', '/').replace(/\/+$/, '');

  const parts = [snap.ctxPct == null ? 'C??%' : `C${String(snap.ctxPct).padStart(2, '0')}%`];
  if (seg) parts.push(seg);
  const mode = (snap.mode ?? '').replace('workspace-write', 'work').replace('read-only', 'read')
    .replace('danger-full-access', 'full').replace('on-request', 'ask');
  if (mode) parts.push(mode);
  if (snap.agents > 0) parts.push(`${snap.agents} agent${snap.agents > 1 ? 's' : ''}`);
  if (branch) parts.push(branch);
  if (disp) parts.push(disp);

  const head = ['codex', model, snap.effort].filter(Boolean).join(' ');
  const stats = parts.join(' ');
  return { title: `${head} ${stats}`, stats, model };
}

// Serialize reconciles across daemon + event hooks. Lock = pid file; a dead
// holder's lock is reclaimed, and the file is removed on release.
const lockPath = join(LOCK_DIR, 'paniolo-codex-reconcile.lock');

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

export function reconcile(request = herdr) {
  const fd = acquireLock();
  if (fd === null) return;
  try { reconcileInner(request); }
  finally { closeSync(fd); try { unlinkSync(lockPath); } catch {} }
}

function reconcileInner(herdr) {
  const agents = herdr('agent', 'list')?.agents;
  const panes = herdr('pane', 'list')?.panes;
  // A disconnected server is not evidence that the target agents exited.
  if (!agents || !panes) return;
  const labelByPane = Object.fromEntries(panes.map(p => [p.pane_id, p.label]));
  const codexAgents = agents.filter(a => a.agent === 'codex');
  const codexPanes = new Set(codexAgents.map(a => a.pane_id));

  for (const a of codexAgents) {
    const snap = paneSnapshot(a);
    const { title, stats, model } = statusline(a, snap, quotaSeg(quotaWindows(snap)));
    herdr('pane', 'report-metadata', a.pane_id, '--source', 'paniolo-codexline',
      '--seq', String(Date.now()), '--ttl-ms', '120000',
      '--token', `model=${model}`, '--token', `stats=${stats}`, '--title', title);
    if (labelByPane[a.pane_id] !== title) herdr('pane', 'rename', a.pane_id, title);
  }

  // Stale statusline labels on panes that no longer run Codex.
  for (const p of panes) {
    if (codexPanes.has(p.pane_id)) continue;
    if (OUR_LABEL_RE.test(p.label ?? '')) herdr('pane', 'rename', p.pane_id, '--clear');
  }

  // Footer bookkeeping: footers carry label paniolo-codex:<target>.
  const footerByTarget = new Map();
  for (const p of panes) {
    const m = (p.label ?? '').match(/^paniolo-codex:(\S+)/);
    if (m) footerByTarget.set(m[1], p.pane_id);
  }
  // Orphans: footer target no longer runs Codex -> close.
  for (const [target, footer] of footerByTarget) {
    if (!codexPanes.has(target)) {
      herdr('pane', 'close', footer);
      footerByTarget.delete(target);
    }
  }
  // Provision one footer per Codex pane, including panes that share a tab.
  for (const a of codexAgents) {
    if (!a.tab_id || footerByTarget.has(a.pane_id)) continue;
    const opened = herdr('plugin', 'pane', 'open', '--plugin', env.HERDR_PLUGIN_ID ?? 'paniolo-herdr-codex',
      '--entrypoint', 'footer', '--placement', 'split', '--target-pane', a.pane_id, '--direction', 'down', '--no-focus', '--env', `CODEX_STATUS_TARGET=${a.pane_id}`);
    const id = opened?.plugin_pane?.pane?.pane_id ?? opened?.pane?.pane_id ?? opened?.pane_id;
    if (id) {
      herdr('pane', 'rename', id, `${FOOTER_PREFIX}${a.pane_id}`);
      footerByTarget.set(a.pane_id, id);
    }
  }
  // Clamp footers to FOOTER_MAX_ROWS and resurrect dead render loops (a
  // server restart kills the footer process, leaving a bare shell prompt).
  const panesNow = herdr('pane', 'list')?.panes ?? [];
  for (const p of panesNow) {
    const m = (p.label ?? '').match(/^paniolo-codex:(\S+)/);
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

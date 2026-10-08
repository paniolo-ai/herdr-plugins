// Reconcile pass: report statusline metadata for every Claude Code pane, clean
// up stale labels, close orphaned footers, provision missing ones, clamp heights.
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { herdr, herdrText, git, FOOTER_PREFIX, FOOTER_MAX_ROWS, LOCK_DIR } from './core.mjs';
import {
  quotaWindows, contextWindow, noteContext, transcriptPath, tailSnapshot, MODE_LABELS,
} from './claude.mjs';

const home = env.USERPROFILE ?? env.HOME ?? '';
const pluginRoot = env.HERDR_PLUGIN_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));
const footerCmd = `node "${join(pluginRoot, 'footer.mjs')}"`;
// Matches a bare shell prompt line: `PS C:\path>`, `C:\path>`, or a Unix
// prompt trailing `$`/`#`/`%`. The painted footer band never ends like this.
const BARE_PROMPT_RE = /^PS\s.*>\s*$|[$#%>]\s*$/;
// Our own statusline labels, so they can be cleared off panes that stopped
// running Claude Code. Narrow enough not to touch another plugin's labels.
const OUR_LABEL_RE = /^claude\b.*\bC\d+%/;

export function paneSnapshot(agent) {
  const sessionId = agent.agent_session?.value ?? null;
  const path = sessionId ? transcriptPath(sessionId, agent.cwd) : null;
  if (!path) return { sessionId, path: null, ctxPct: 0 };
  const snap = tailSnapshot(path);
  noteContext(snap.model, snap.ctxTokens);
  const window = contextWindow(snap.model ?? '');
  return {
    ...snap,
    sessionId,
    path,
    window,
    ctxPct: window > 0 ? Math.min(99, Math.floor(100 * snap.ctxTokens / window)) : 0,
  };
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
  const model = (snap.model ?? '').replace(/^claude-/, '');
  const cwd = agent.cwd ?? '';
  const branch = git(['branch', '--show-current'], cwd) || git(['rev-parse', '--short', 'HEAD'], cwd);
  let disp = cwd;
  if (home && disp.startsWith(home)) disp = '~' + disp.slice(home.length);
  disp = disp.replaceAll('\\', '/').replace(/\/+$/, '');

  const parts = [`C${String(snap.ctxPct).padStart(2, '0')}%`];
  if (seg) parts.push(seg);
  const mode = MODE_LABELS[snap.mode];
  if (mode) parts.push(mode);
  if (snap.agents > 0) parts.push(`${snap.agents} agent${snap.agents > 1 ? 's' : ''}`);
  if (branch) parts.push(branch);
  if (disp) parts.push(disp);

  const head = ['claude', model, snap.effort].filter(Boolean).join(' ');
  const stats = parts.join(' ');
  return { title: `${head} ${stats}`, stats, model };
}

// Serialize reconciles across daemon + event hooks. Lock = pid file; a dead
// holder's lock is reclaimed, and the file is removed on release.
const lockPath = join(LOCK_DIR, 'claude-status-reconcile.lock');

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
  const agents = herdr('agent', 'list')?.agents ?? [];
  const panes = herdr('pane', 'list')?.panes ?? [];
  const labelByPane = Object.fromEntries(panes.map(p => [p.pane_id, p.label]));
  const claudeAgents = agents.filter(a => a.agent === 'claude');
  const claudePanes = new Set(claudeAgents.map(a => a.pane_id));
  const seg = quotaSeg();

  for (const a of claudeAgents) {
    const snap = paneSnapshot(a);
    const { title, stats, model } = statusline(a, snap, seg);
    herdr('pane', 'report-metadata', a.pane_id, '--source', 'claude-statusline',
      '--seq', String(Date.now() * 1e6), '--ttl-ms', '120000',
      '--token', `model=${model}`, '--token', `stats=${stats}`, '--title', title);
    if (labelByPane[a.pane_id] !== title) herdr('pane', 'rename', a.pane_id, title);
  }

  // Stale statusline labels on panes that no longer run Claude Code.
  for (const p of panes) {
    if (claudePanes.has(p.pane_id)) continue;
    if (OUR_LABEL_RE.test(p.label ?? '')) herdr('pane', 'rename', p.pane_id, '--clear');
  }

  // Footer bookkeeping: footers carry label claude-status:<target>. A live
  // render loop also shows `footer.mjs` in the pane's foreground argv, which
  // is how unlabeled survivors of an interrupted provision are found — a
  // bare shell left by a killed loop is indistinguishable from a user pane
  // and is left alone.
  const footerByTarget = new Map();
  const footerByTab = new Map();
  for (const p of panes) {
    const m = (p.label ?? '').match(/^claude-status:(\S+)/);
    if (m) {
      if (footerByTab.has(p.tab_id)) { herdr('pane', 'close', p.pane_id); continue; }
      footerByTarget.set(m[1], p.pane_id);
      footerByTab.set(p.tab_id, p.pane_id);
      continue;
    }
    if (p.label) continue; // user-named pane — never a plugin footer
    const fg = herdr('pane', 'process-info', '--pane', p.pane_id)
      ?.process_info?.foreground_processes ?? [];
    const isFooter = fg.some(pr =>
      /(^|[\\/])footer\.mjs$/.test(pr.argv?.at(-1) ?? '') || /footer\.mjs/.test(pr.cmdline ?? ''));
    if (!isFooter) continue;
    // Unlabeled live footer: adopt when its tab has a Claude pane and no
    // footer yet (the loop already renders that pane per its fallback);
    // otherwise it is a duplicate or orphan — close it.
    const claudeOnTab = claudeAgents.find(a => a.tab_id === p.tab_id);
    if (claudeOnTab && !footerByTab.has(p.tab_id)) {
      herdr('pane', 'rename', p.pane_id, `${FOOTER_PREFIX}${claudeOnTab.pane_id}`);
      footerByTarget.set(claudeOnTab.pane_id, p.pane_id);
      footerByTab.set(p.tab_id, p.pane_id);
    } else {
      herdr('pane', 'close', p.pane_id);
    }
  }
  // Orphans: footer target no longer runs Claude Code -> close.
  for (const [target, footer] of footerByTarget) {
    if (!claudePanes.has(target)) {
      herdr('pane', 'close', footer);
      const tab = panes.find(p => p.pane_id === footer)?.tab_id;
      if (tab) footerByTab.delete(tab);
      footerByTarget.delete(target);
    }
  }
  // Provision one footer per Claude tab.
  for (const a of claudeAgents) {
    if (!a.tab_id || footerByTab.has(a.tab_id)) continue;
    const opened = herdr('plugin', 'pane', 'open', '--plugin', env.HERDR_PLUGIN_ID ?? 'paniolo-herdr-claude',
      '--entrypoint', 'footer', '--placement', 'split', '--target-pane', a.pane_id, '--direction', 'down', '--no-focus');
    const id = opened?.plugin_pane?.pane?.pane_id ?? opened?.pane?.pane_id ?? opened?.pane_id;
    if (id) {
      herdr('pane', 'rename', id, `${FOOTER_PREFIX}${a.pane_id}`);
    }
  }
  // Clamp footers to FOOTER_MAX_ROWS and resurrect dead render loops (a
  // server restart kills the footer process, leaving a bare shell prompt).
  const panesNow = herdr('pane', 'list')?.panes ?? [];
  for (const p of panesNow) {
    const m = (p.label ?? '').match(/^claude-status:(\S+)/);
    if (!m) continue;
    const target = m[1];
    // pane.get carries no shell-title field on herdr 0.9.3, so a killed loop
    // is found by its screen instead: a dead footer leaves the pane sitting
    // on a bare prompt, a live one's band never does.
    const screen = herdrText('pane', 'read', p.pane_id);
    const lastLine = screen.split('\n').map(l => l.trimEnd()).filter(Boolean).at(-1) ?? '';
    if (BARE_PROMPT_RE.test(lastLine)) {
      herdr('pane', 'send-text', p.pane_id, `${footerCmd} ${target}`);
      herdr('pane', 'send-keys', p.pane_id, 'enter');
    }
    // Resize grows the named pane's edge toward the direction, so a footer
    // shrinks by growing a neighbor into it: the pane above first (the
    // footer's own bottom edge is a dead end once something sits below).
    for (let i = 0; i < 8; i++) {
      const rows = herdr('pane', 'get', p.pane_id)?.pane?.scroll?.viewport_rows;
      if (!rows || rows <= FOOTER_MAX_ROWS) break;
      const above = herdr('pane', 'neighbor', '--pane', p.pane_id, '--direction', 'up')
        ?.neighbor?.neighbor_pane_id;
      const below = herdr('pane', 'neighbor', '--pane', p.pane_id, '--direction', 'down')
        ?.neighbor?.neighbor_pane_id;
      const amount = String(rows - FOOTER_MAX_ROWS + 8);
      let r = above
        ? herdr('pane', 'resize', '--pane', above, '--direction', 'down', '--amount', amount)
        : null;
      if (!r?.resize?.changed && below)
        r = herdr('pane', 'resize', '--pane', below, '--direction', 'up', '--amount', amount);
      if (!r?.resize?.changed) break;
    }
  }
}

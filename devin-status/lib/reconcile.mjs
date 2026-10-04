// Reconcile pass: report statusline metadata for every devin pane, clean up
// stale labels, close orphaned footers, provision missing ones, clamp heights.
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import {
  herdr, usage, readTranscript, contextWindow, git,
  FOOTER_PREFIX, FOOTER_MAX_ROWS, LOCK_DIR,
} from './core.mjs';

const home = env.USERPROFILE ?? env.HOME ?? '';

function devinInfo(agent) {
  const sessionId = agent.agent_session?.value;
  let model = null, ctxUsed = 0;
  if (sessionId) {
    const t = readTranscript(sessionId);
    if (t) {
      const steps = (t.steps ?? []).filter(s => (s.metrics?.prompt_tokens ?? 0) > 0);
      const last = steps.at(-1);
      model = last?.model_name ?? ((t.agent?.model_name ?? '').replace(/ /g, '-').toLowerCase() || null);
      if (last) ctxUsed = Math.floor(100 * last.metrics.prompt_tokens / contextWindow(model));
    }
  }
  return { model, ctxUsed };
}

function quotaSeg() {
  const u = usage();
  const pct = v => v == null ? '00' : String(Math.max(0, 100 - Math.round(v))).padStart(2, '0');
  let m = '00';
  if (u && u.monthlyCredits > 0 && u.availableCredits >= 0)
    m = String(Math.max(0, 100 - Math.floor(100 * u.availableCredits / u.monthlyCredits))).padStart(2, '0');
  return `500% D${pct(u?.daily)}% W${pct(u?.weekly)}% M${m}%`;
}

// Serialize reconciles across daemon + event hooks.
function acquireLock() {
  const f = join(LOCK_DIR, 'devin-status-reconcile.lock');
  try { return openSync(f, 'wx'); } catch { return null; }
}

export function reconcile() {
  const fd = acquireLock();
  if (fd === null) return;
  try { reconcileInner(); }
  finally { closeSync(fd); }
}

function reconcileInner() {
  const agents = herdr('agent', 'list')?.agents ?? [];
  const panes = herdr('pane', 'list')?.panes ?? [];
  const labelByPane = Object.fromEntries(panes.map(p => [p.pane_id, p.label]));
  const devinAgents = agents.filter(a => a.agent === 'devin');
  const devinPanes = new Set(devinAgents.map(a => a.pane_id));
  const seg = quotaSeg();

  for (const a of devinAgents) {
    const { model, ctxUsed } = devinInfo(a);
    const cwd = a.cwd ?? '';
    const branch = git(['branch', '--show-current'], cwd) || git(['rev-parse', '--short', 'HEAD'], cwd);
    let disp = cwd;
    if (home && disp.startsWith(home)) disp = '~' + disp.slice(home.length);
    disp = disp.replaceAll('\\', '/').replace(/\/+$/, '');
    let stats = `C${String(ctxUsed).padStart(2, '0')}% ${seg}`;
    if (branch) stats += ` ${branch}`;
    if (disp) stats += ` ${disp}`;
    const title = `devin${model ? ' ' + model : ''} ${stats}`;
    herdr('pane', 'report-metadata', a.pane_id, '--source', 'devin-statusline',
      '--seq', String(Date.now() * 10_000), '--ttl-ms', '120000',
      '--token', `model=${model}`, '--token', `stats=${stats}`, '--title', title);
    if (labelByPane[a.pane_id] !== title) herdr('pane', 'rename', a.pane_id, title);
  }

  // Stale statusline labels on panes that no longer run devin.
  for (const p of panes) {
    if (devinPanes.has(p.pane_id)) continue;
    if (/^devin \S* ?C\d+% /.test(p.label ?? '')) herdr('pane', 'rename', p.pane_id, '--clear');
  }

  // Footer bookkeeping: footers carry label devin-status:<target>.
  const footerByTarget = new Map();
  const footerByTab = new Map();
  for (const p of panes) {
    const m = (p.label ?? '').match(/^devin-status:(\S+)/);
    if (m) { footerByTarget.set(m[1], p.pane_id); footerByTab.set(p.tab_id, p.pane_id); }
  }
  // Orphans: footer target no longer runs devin -> close.
  for (const [target, footer] of footerByTarget) {
    if (!devinPanes.has(target)) {
      herdr('pane', 'close', footer);
      const tab = panes.find(p => p.pane_id === footer)?.tab_id;
      if (tab) footerByTab.delete(tab);
      footerByTarget.delete(target);
    }
  }
  // Provision one footer per devin tab.
  for (const a of devinAgents) {
    if (!a.tab_id || footerByTab.has(a.tab_id)) continue;
    const opened = herdr('plugin', 'pane', 'open', '--plugin', env.HERDR_PLUGIN_ID ?? 'paniolo.devin-status',
      '--entrypoint', 'footer', '--placement', 'split', '--target-pane', a.pane_id, '--direction', 'down');
    const id = opened?.plugin_pane?.pane?.pane_id ?? opened?.pane?.pane_id ?? opened?.pane_id;
    if (id) {
      herdr('pane', 'rename', id, `${FOOTER_PREFIX}${a.pane_id}`);
      herdr('pane', 'focus', a.pane_id); // pane open may steal focus
    }
  }
  // Clamp footers to FOOTER_MAX_ROWS (splits floor at 10% of tab height).
  const panesNow = herdr('pane', 'list')?.panes ?? [];
  for (const p of panesNow) {
    if (!/^devin-status:/.test(p.label ?? '')) continue;
    for (let i = 0; i < 8; i++) {
      const rows = herdr('pane', 'get', p.pane_id)?.pane?.scroll?.viewport_rows;
      if (!rows || rows <= FOOTER_MAX_ROWS) break;
      const r = herdr('pane', 'resize', '--pane', p.pane_id, '--direction', 'down', '--amount', '20');
      if (!r?.resize?.changed) break;
    }
  }
}

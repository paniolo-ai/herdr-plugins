// Shared, agent-neutral helpers for the paniolo-herdr-cursor plugin.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { env } from 'node:process';

export const HERDR = env.HERDR_BIN_PATH ?? 'herdr';
export const STATE_DIR = env.HERDR_PLUGIN_STATE_DIR ?? tmpdir();
// Fixed across plugin/manual invocation AND the Cursor statusLine bridge
// (which runs outside herdr and never sees HERDR_PLUGIN_STATE_DIR).
export const LOCK_DIR = tmpdir();
export const CACHE_DIR = join(tmpdir(), 'cursor-status');
export const FOOTER_PREFIX = 'cursor-status:';
export const FOOTER_MAX_ROWS = 5;
export const TICK_MS = 15_000;

export function ensureCacheDir() {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  return CACHE_DIR;
}

export function herdr(...args) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout).result; } catch { return null; }
}

export function fmtTok(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

export function fmtDur(secs) {
  if (!Number.isFinite(secs) || secs < 0) return null;
  if (secs < 60) return `${Math.floor(secs)}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return `${h}h${mm}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Wall-clock stamp in local time, carrying only as much date as it needs:
// `15:49` today, `Thu 09:59` within the week, `Oct 9 09:59` beyond it.
export function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const days = Math.abs(d - now) / 86_400_000;
  if (days < 6) return `${DAYS[d.getDay()]} ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

export function git(args, cwd) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 ? r.stdout.trimEnd() : '';
}

// Walk up from a file/dir path to the nearest .git root.
export function repoRoot(path) {
  try {
    let d = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
    for (;;) {
      if (existsSync(join(d, '.git'))) return d;
      const parent = dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  } catch { return null; }
}

// Shared helpers for the devin-status plugin.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { env, platform } from 'node:process';

export const HERDR = env.HERDR_BIN_PATH ?? 'herdr';
export const STATE_DIR = env.HERDR_PLUGIN_STATE_DIR ?? tmpdir();
export const LOCK_DIR = tmpdir(); // fixed across plugin/manual invocation
export const USAGE_CACHE = join(tmpdir(), 'devin-statusline-usage.json');
export const FOOTER_PREFIX = 'devin-status:';
export const FOOTER_MAX_ROWS = 5;
export const TICK_MS = 15_000;
export const USAGE_TTL_MS = 300_000;

export function herdr(...args) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout).result; } catch { return null; }
}

export function devinDir() {
  const candidates = platform === 'win32'
    ? [join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'devin')]
    : platform === 'darwin'
      ? [join(homedir(), 'Library', 'Application Support', 'devin'),
         join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'devin')]
      : [join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'devin')];
  return candidates.find(existsSync) ?? candidates[0];
}

export function devinCredentials() {
  try {
    const cred = {};
    for (const line of readFileSync(join(devinDir(), 'credentials.toml'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*"?(.*?)"?\s*$/);
      if (m) cred[m[1]] = m[2];
    }
    return cred;
  } catch { return {}; }
}

export function transcriptPath(sessionId) {
  return join(devinDir(), 'cli', 'transcripts', `${sessionId}.json`);
}

export function readTranscript(sessionId) {
  try { return JSON.parse(readFileSync(transcriptPath(sessionId), 'utf8')); }
  catch { return null; }
}

// Context window (tokens) per model family, for the C% figure.
export function contextWindow(model = '') {
  if (/swe-2|swe-1p6/.test(model)) return 262_000;
  if (/claude/.test(model)) return 200_000;
  if (/gpt|codex|astra|sol/.test(model)) return 272_000;
  if (/gemini/.test(model)) return 1_048_576;
  return 262_000;
}

export function fmtTok(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

export function fmtDur(secs) {
  if (secs < 0) return null;
  if (secs < 60) return `${Math.floor(secs)}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return `${h}h${mm}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

// Devin account quotas via the SeatManagement GetUserStatus RPC.
// Cached in USAGE_CACHE for USAGE_TTL_MS; returns null on failure.
export function usage() {
  let u = null;
  try {
    if (Date.now() - statSync(USAGE_CACHE).mtimeMs < USAGE_TTL_MS)
      u = JSON.parse(readFileSync(USAGE_CACHE, 'utf8'));
  } catch {}
  if (u) return u;
  const cred = devinCredentials();
  const server = (cred.api_server_url ?? 'https://server.codeium.com').replace(/\/+$/, '');
  try {
    const body = JSON.stringify({
      metadata: { apiKey: cred.windsurf_api_key, ideName: 'devin', ideVersion: '3000.11.3', extensionVersion: '3000.11.3', locale: 'en' },
    });
    const r = spawnSync('curl', ['-sS', '-m', '8', '-X', 'POST', `${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      '-H', 'content-type: application/json', '-H', 'Connect-Protocol-Version: 1', '--data-binary', body], { encoding: 'utf8', timeout: 12_000 });
    const ps = JSON.parse(r.stdout)?.userStatus?.planStatus;
    if (!ps) throw new Error('no planStatus');
    const info = ps.planInfo ?? {};
    u = {
      daily: ps.dailyQuotaRemainingPercent,
      weekly: ps.weeklyQuotaRemainingPercent,
      monthlyCredits: info.monthlyPromptCredits,
      availableCredits: ps.availablePromptCredits,
      overageMicros: ps.overageBalanceMicros,
      dailyReset: ps.dailyQuotaResetAtUnix,
      weeklyReset: ps.weeklyQuotaResetAtUnix,
      planEnd: ps.planEnd,
    };
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(USAGE_CACHE, JSON.stringify(u));
    return u;
  } catch {
    try { return JSON.parse(readFileSync(USAGE_CACHE, 'utf8')); } catch { return null; }
  }
}

export function git(args, cwd) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 });
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

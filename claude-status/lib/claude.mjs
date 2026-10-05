// Readers for Claude Code's local state. Everything here is a local file read —
// no API calls, no credentials, no network.
//
//   ~/.claude.json                             quota cache + model windows
//   ~/.claude/projects/<slug>/<session>.jsonl  append-only transcript
//
// Only metadata is read out of the transcript (token usage, model, record
// types, tool names, edited file paths). Prompt and response text is never
// parsed or rendered.
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  openSync, readSync, closeSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env, platform } from 'node:process';
import { STATE_DIR, repoRoot } from './core.mjs';

const CONFIG_DIR = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const PROJECTS_DIR = join(CONFIG_DIR, 'projects');
// Claude Code keeps .claude.json inside CLAUDE_CONFIG_DIR when that is set,
// and in $HOME otherwise.
const SETTINGS_PATHS = [join(CONFIG_DIR, '.claude.json'), join(homedir(), '.claude.json')];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const OPEN_BRACE = 123;

// ---------------------------------------------------------------- settings

// .claude.json is rewritten often but is small; re-parse only on mtime change.
let settingsCache = { sig: '', data: null };

export function settings() {
  const found = [];
  for (const p of SETTINGS_PATHS) {
    try { found.push([p, statSync(p).mtimeMs]); } catch {}
  }
  if (!found.length) return null;
  const sig = found.map(([p, m]) => `${p}:${m}`).join('|');
  if (sig === settingsCache.sig) return settingsCache.data;
  // Both paths can exist with one of them a small stub, so prefer whichever
  // file actually carries the fields this plugin reads rather than the first.
  let best = null, bestScore = -1;
  for (const [p] of found) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      const score = (data.cachedUsageUtilization ? 2 : 0) + (data.oauthAccount ? 1 : 0);
      if (score > bestScore) { best = data; bestScore = score; }
    } catch {}
  }
  settingsCache = { sig, data: best };
  return best;
}

// ------------------------------------------------------- live usage fetch

// Claude Code's cached reading can be hours old, which leaves a rolled window
// with no number at all. This asks the same endpoint Claude Code asks
// (`GET /api/oauth/usage`) for a current one, using the OAuth access token
// from Claude Code's own credential store.
//
// Reading your own quota for your own status display, with your own token, on
// your own machine. The token is read and never written, and the refresh
// endpoint is never called — rotating it is Claude Code's job, and touching it
// here could invalidate a live session. Set CLAUDE_STATUS_NO_FETCH=1 to turn
// this off and fall back to Claude Code's cache alone.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?skip_spend=1';
const OAUTH_BETA = 'oauth-2025-04-20';
const LIVE_CACHE = join(STATE_DIR, 'claude-status-usage.json');
const LIVE_TTL_MS = 300_000;
const CRED_PATHS = [
  join(CONFIG_DIR, '.credentials.json'),
  join(homedir(), '.claude', '.credentials.json'),
];

function tokenFromFile() {
  for (const p of CRED_PATHS) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      const o = d.claudeAiOauth ?? d.oauth ?? d;
      const token = o.accessToken ?? o.access_token;
      if (!token) continue;
      const exp = o.expiresAt ?? o.expires_at ?? 0;
      // An expired token is left alone rather than refreshed; the cached
      // reading is a better answer than disturbing the credential store.
      if (exp && exp <= Date.now()) return null;
      return token;
    } catch {}
  }
  return null;
}

// macOS keeps these in the login Keychain rather than a file, so there is no
// credentials.json to read there. The Keychain item's service name is not
// discoverable from outside, so it is supplied by configuration:
//
//   CLAUDE_STATUS_KEYCHAIN_SERVICE   service name  (-s)
//   CLAUDE_STATUS_KEYCHAIN_ACCOUNT   account name  (-a), defaults to $USER
//
// Unset, the plugin falls back to Claude Code's cached reading on macOS.
// Reading an item may prompt for Keychain access the first time.
function tokenFromKeychain() {
  const service = env.CLAUDE_STATUS_KEYCHAIN_SERVICE;
  if (platform !== 'darwin' || !service) return null;
  const account = env.CLAUDE_STATUS_KEYCHAIN_ACCOUNT ?? env.USER ?? '';
  try {
    const r = spawnSync('security',
      ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'],
      { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0 || !r.stdout) return null;
    const raw = r.stdout.trim();
    if (!raw) return null;
    // The item may hold either a bare token or Claude Code's credential JSON.
    try {
      const d = JSON.parse(raw);
      const o = d.claudeAiOauth ?? d.oauth ?? d;
      const exp = o.expiresAt ?? o.expires_at ?? 0;
      if (exp && exp <= Date.now()) return null;
      return o.accessToken ?? o.access_token ?? null;
    } catch { return raw; }
  } catch { return null; }
}

function oauthToken() {
  return tokenFromFile() ?? tokenFromKeychain();
}

function readLive() {
  try {
    const d = JSON.parse(readFileSync(LIVE_CACHE, 'utf8'));
    if (d?.utilization) return d;
  } catch {}
  return null;
}

let refreshing = false;

// Fire-and-forget: callers paint with whatever they have and pick the new
// numbers up on a later tick.
export function refreshUsageSoon() {
  if (refreshing || env.CLAUDE_STATUS_NO_FETCH === '1') return;
  // Node 18 is where global fetch lands. On anything older the footer runs on
  // Claude Code's cached reading instead of failing.
  if (typeof fetch !== 'function') return;
  const live = readLive();
  if (live && Date.now() - (live.fetchedAtMs ?? 0) < LIVE_TTL_MS) return;
  let token = null;
  try { token = oauthToken(); } catch {}
  if (!token) return;
  refreshing = true;
  try {
  fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  })
    .then(r => (r.ok ? r.json() : null))
    .then(body => {
      const utilization = body?.utilization ?? body;
      if (!utilization || typeof utilization !== 'object') return;
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(LIVE_CACHE, JSON.stringify({ fetchedAtMs: Date.now(), utilization }));
    })
    .catch(() => {})
    .finally(() => { refreshing = false; });
  } catch { refreshing = false; }
}

// ------------------------------------------------------------------ quota

// Normalized rate-limit windows from Claude Code's own usage cache.
//
// `pct` is null for a window whose `resets_at` has already passed: the window
// restarted and the cache does not say what has been spent since, so repeating
// the old number (or showing 0%) would misstate the headroom. Any Claude Code
// session that refreshes usage — `/usage` does — updates this cache for every
// footer at once.
export function quotaWindows() {
  refreshUsageSoon();
  // Whichever reading is newer: our own fetch, or Claude Code's cache.
  const own = readLive();
  const theirs = settings()?.cachedUsageUtilization;
  const cached = (own?.fetchedAtMs ?? 0) >= (theirs?.fetchedAtMs ?? 0) ? own : theirs;
  const u = cached?.utilization;
  if (!u) return null;
  const now = Date.now();
  const out = {
    ageMs: cached.fetchedAtMs ? now - cached.fetchedAtMs : null,
    live: cached === own,
    windows: [],
    spend: null,
  };
  const add = (key, label, periodMs) => {
    const w = u[key];
    if (!w || w.utilization == null) return;
    const resetMs = Date.parse(w.resets_at ?? '') || 0;
    const expired = resetMs > 0 && resetMs <= now;
    // For a window that has already rolled, the next reset is the cached one
    // advanced by whole periods. That is an extrapolation, not a reading, so
    // callers mark it as approximate.
    let nextResetMs = 0;
    if (expired && periodMs > 0) {
      nextResetMs = resetMs + Math.ceil((now - resetMs) / periodMs) * periodMs;
    }
    out.windows.push({
      label,
      // `pct` is the reading for the window now in force, so an expired
      // window reports none. What it does report is that the window rolled
      // over and when — which says more about headroom than the old number.
      pct: expired ? null : Math.round(w.utilization),
      resetMs: expired ? 0 : resetMs,
      rolledAtMs: expired ? resetMs : 0,
      nextResetMs,
      lastPct: expired ? Math.round(w.utilization) : null,
    });
  };
  const HOUR = 3_600_000, DAY = 86_400_000;
  add('five_hour', '5h', 5 * HOUR);
  add('seven_day', 'W', 7 * DAY);
  add('seven_day_opus', 'W opus', 7 * DAY);
  add('seven_day_sonnet', 'W sonnet', 7 * DAY);
  const extra = u.extra_usage;
  if (extra?.is_enabled && extra.monthly_limit > 0) {
    out.spend = { used: extra.used_credits ?? 0, limit: extra.monthly_limit };
  } else if (extra && extra.is_enabled === false) {
    out.spend = { off: String(extra.disabled_reason ?? 'off').replace(/_/g, ' ') };
  }
  return out;
}

// --------------------------------------------------------- context window

// The usable window is account-dependent (a 1M-context entitlement changes the
// denominator), so it is resolved from evidence rather than a fixed table:
// Claude Code's own cache first, then a per-model high-water mark of context
// actually observed, then a family default.
const WINDOW_STEPS = [200_000, 500_000, 1_000_000, 2_000_000];
const FAMILY_DEFAULTS = [[/haiku/, 200_000], [/opus-5|sonnet-5|fable-5/, 1_000_000]];
const hwPath = join(STATE_DIR, 'claude-status-context.json');
let hw = null;

function highWater() {
  if (hw) return hw;
  try { hw = JSON.parse(readFileSync(hwPath, 'utf8')); } catch { hw = {}; }
  return hw;
}

export function noteContext(model, tokens) {
  if (!model || !(tokens > 0)) return;
  const marks = highWater();
  if ((marks[model] ?? 0) >= tokens) return;
  marks[model] = tokens;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(hwPath, JSON.stringify(marks));
  } catch {}
}

export function contextWindow(model = '') {
  const cache = settings()?.autoCompactWindowsCache;
  const known = cache && (typeof cache[model] === 'number' ? cache[model] : cache[model]?.window);
  if (known > 0) return known;
  let base = 200_000;
  for (const [re, n] of FAMILY_DEFAULTS) if (re.test(model)) { base = n; break; }
  const seen = highWater()[model] ?? 0;
  if (seen > base) base = WINDOW_STEPS.find(n => n >= seen) ?? seen;
  return base;
}

// ------------------------------------------------------------- transcript

const pathCache = new Map();

export function transcriptPath(sessionId, cwd) {
  if (!sessionId) return null;
  const hit = pathCache.get(sessionId);
  if (hit && existsSync(hit)) return hit;
  // Claude Code slugifies the project cwd for the directory name.
  if (cwd) {
    const p = join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    if (existsSync(p)) { pathCache.set(sessionId, p); return p; }
  }
  try {
    for (const dir of readdirSync(PROJECTS_DIR)) {
      const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(p)) { pathCache.set(sessionId, p); return p; }
    }
  } catch {}
  return null;
}

function* records(text) {
  for (const line of text.split('\n')) {
    if (line.charCodeAt(0) !== OPEN_BRACE) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

// Read the last `bytes` of a file, dropping the leading partial line (which
// also discards any split UTF-8 sequence at the boundary).
function readTail(path, bytes) {
  let fd;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

// Current state of a session, from the tail of its transcript: live model,
// context in use, permission mode, thinking effort, and tool calls still
// awaiting a result — which is how running subagents are counted.
export function tailSnapshot(path, bytes = 512 * 1024) {
  const out = {
    model: null, advisor: null, effort: null, mode: null, title: null,
    ctxTokens: 0, lastAt: 0, pending: [], agents: 0,
  };
  const open = new Map(); // tool_use id -> tool name
  for (const r of records(readTail(path, bytes))) {
    if (r.type === 'mode') { out.mode = r.mode ?? out.mode; continue; }
    if (r.type === 'ai-title') { out.title = r.aiTitle ?? out.title; continue; }
    const content = r.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use' && b.id) open.set(b.id, b.name ?? '?');
        else if (b?.type === 'tool_result' && b.tool_use_id) open.delete(b.tool_use_id);
      }
    }
    if (r.type !== 'assistant' || r.isSidechain) continue;
    const m = r.message ?? {};
    const u = m.usage ?? {};
    const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      + (u.cache_read_input_tokens ?? 0);
    if (ctx > 0) { out.ctxTokens = ctx; out.model = m.model ?? out.model; }
    out.advisor = r.advisorModel ?? out.advisor;
    out.effort = r.perTurnEffort ?? r.effort ?? out.effort;
    out.lastAt = Math.max(out.lastAt, Date.parse(r.timestamp ?? '') || 0);
  }
  for (const name of open.values()) {
    if (name === 'Task') out.agents++; else out.pending.push(name);
  }
  return out;
}

// -------------------------------------------------- incremental full scan

// Session totals need every record, and transcripts reach tens of megabytes,
// so the file is walked once and then only its new tail on each later tick.
// Checkpoints are keyed by session and survive a footer restart.
const MAX_CHUNK = 8 * 1024 * 1024; // catch a cold large file up over a few ticks

function emptyScan() {
  return { offset: 0, inTok: 0, outTok: 0, cachedTok: 0, turns: 0, roots: [] };
}

function statePath(sessionId) {
  return join(STATE_DIR, `claude-status-scan-${sessionId}.json`);
}

export function loadScan(sessionId) {
  try {
    const s = JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    if (s && typeof s.offset === 'number') return { ...emptyScan(), ...s };
  } catch {}
  return emptyScan();
}

function saveScan(sessionId, s) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(s));
  } catch {}
}

export function scanTranscript(path, sessionId, prev) {
  let size;
  try { size = statSync(path).size; } catch { return prev; }
  // A shorter file is a different session file; start over.
  let s = size < prev.offset ? emptyScan() : prev;
  if (size === s.offset) return s;

  const len = Math.min(size - s.offset, MAX_CHUNK);
  let fd, text;
  try {
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, s.offset);
    text = buf.toString('utf8');
  } catch { return s; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }

  // Keep the trailing partial line for the next pass.
  const cut = text.lastIndexOf('\n');
  if (cut < 0) return s;
  const complete = text.slice(0, cut);
  const roots = new Set(s.roots);
  for (const r of records(complete)) {
    const m = r.message;
    if (!m) continue;
    const u = m.usage;
    if (r.type === 'assistant' && u) {
      s.inTok += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      s.cachedTok += u.cache_read_input_tokens ?? 0;
      s.outTok += u.output_tokens ?? 0;
      s.turns++;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
      const fp = b.input?.file_path ?? b.input?.notebook_path;
      const root = fp && repoRoot(fp);
      if (root) roots.add(root);
    }
  }
  s.roots = [...roots];
  s.offset += Buffer.byteLength(complete, 'utf8') + 1;
  saveScan(sessionId, s);
  return s;
}

export function transcriptIdleSecs(path) {
  try { return (Date.now() - statSync(path).mtimeMs) / 1000; } catch { return -1; }
}

export const MODE_LABELS = {
  plan: 'plan',
  acceptEdits: 'auto-accept',
  bypassPermissions: 'bypass',
  dangerouslySkipPermissions: 'bypass',
};

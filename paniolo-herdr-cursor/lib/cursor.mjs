// Readers for Cursor Agent CLI's local state.
//
//   ~/.cursor/cli-config.json
//     selected model, approval mode, maxMode (global — fallback only)
//   ~/.cursor/projects/<slug>/agent-transcripts/<session>/<session>.jsonl
//     citation transcript: roles, tool_use names/paths (no token usage)
//   $TMP/cursor-status/<session>.json
//     live statusLine payload written by statusline.mjs (model, context %,
//     token totals). Cursor does not persist those fields anywhere else.
//
// Only metadata is read out of the transcript (tool names, edited file
// paths). Prompt and response text is never parsed or rendered.
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  openSync, readSync, closeSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env, platform } from 'node:process';
import { CACHE_DIR, STATE_DIR, ensureCacheDir, repoRoot } from './core.mjs';

const CURSOR_DIR = env.CURSOR_CONFIG_DIR ?? join(homedir(), '.cursor');
const PROJECTS_DIR = join(CURSOR_DIR, 'projects');
const CLI_CONFIG = join(CURSOR_DIR, 'cli-config.json');
const API_BASE = (env.CURSOR_API_ENDPOINT ?? 'https://api2.cursor.sh').replace(/\/+$/, '');
const USAGE_URL = `${API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const HARD_LIMIT_URL = `${API_BASE}/aiserver.v1.DashboardService/GetHardLimit`;
const PLAN_INFO_URL = `${API_BASE}/aiserver.v1.DashboardService/GetPlanInfo`;
const USAGE_CACHE = join(CACHE_DIR, 'usage.json');
const USAGE_TTL_MS = 300_000;

const EDIT_TOOLS = new Set(['Write', 'StrReplace', 'Delete', 'EditNotebook', 'Edit', 'MultiEdit']);
const OPEN_BRACE = 123;

// Cursor slugifies project cwds the same way Claude Code does, then collapses
// runs of dashes (see cursor-agent workspace-paths helper).
export function projectSlug(cwd) {
  if (!cwd) return null;
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------- settings

let settingsCache = { sig: '', data: null };

export function settings() {
  try {
    const mtime = String(statSync(CLI_CONFIG).mtimeMs);
    if (mtime === settingsCache.sig) return settingsCache.data;
    const data = JSON.parse(readFileSync(CLI_CONFIG, 'utf8'));
    settingsCache = { sig: mtime, data };
    return data;
  } catch { return null; }
}

export function configuredModel() {
  const s = settings();
  if (!s) return null;
  const selected = s.selectedModel?.modelId;
  const fromSelected = selected && s.model?.modelId === selected ? s.model : null;
  const m = fromSelected ?? s.model ?? null;
  if (!m) return null;
  return {
    id: m.modelId ?? selected ?? null,
    display: m.displayName ?? m.displayNameShort ?? m.displayModelId ?? m.modelId ?? null,
    maxMode: !!(s.maxMode || m.maxMode),
  };
}

export function approvalMode() {
  return settings()?.approvalMode ?? null;
}

// -------------------------------------------------------------- auth / quota

// Cursor stores CLI OAuth tokens in auth.json. Paths match cursor-agent's
// credential helper: Roaming/Cursor on Windows, ~/.cursor on macOS, XDG on Linux.
function authPaths() {
  if (platform === 'win32') {
    return [
      join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json'),
      join(CURSOR_DIR, 'auth.json'),
    ];
  }
  if (platform === 'darwin') {
    return [join(homedir(), '.cursor', 'auth.json'), join(CURSOR_DIR, 'auth.json')];
  }
  return [
    join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cursor', 'auth.json'),
    join(CURSOR_DIR, 'auth.json'),
  ];
}

function oauthToken() {
  for (const p of authPaths()) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      const token = d.accessToken ?? d.access_token;
      if (token) return token;
    } catch {}
  }
  return null;
}

function readUsageCache() {
  try {
    const d = JSON.parse(readFileSync(USAGE_CACHE, 'utf8'));
    if (d && typeof d === 'object') return d;
  } catch {}
  return null;
}

function epochMs(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Cursor sometimes serializes ms as a decimal string already in ms.
  return n < 1e12 ? n * 1000 : n;
}

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Math.min(99, Math.max(0, Math.round(Number(n))));
}

let refreshing = false;

// Fire-and-forget: callers paint with whatever they have and pick the new
// numbers up on a later tick. Token is read, never written; refresh of the
// OAuth token is Cursor's job. Set CURSOR_STATUS_NO_FETCH=1 to disable.
export function refreshUsageSoon() {
  if (refreshing || env.CURSOR_STATUS_NO_FETCH === '1') return;
  if (typeof fetch !== 'function') return;
  const live = readUsageCache();
  if (live && Date.now() - (live.fetchedAtMs ?? 0) < USAGE_TTL_MS) return;
  const token = (() => { try { return oauthToken(); } catch { return null; } })();
  if (!token) return;
  refreshing = true;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    accept: 'application/json',
  };
  const opts = { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(8000) };
  Promise.all([
    fetch(USAGE_URL, opts).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch(HARD_LIMIT_URL, opts).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch(PLAN_INFO_URL, opts).then(r => (r.ok ? r.json() : null)).catch(() => null),
  ])
    .then(([usage, hard, plan]) => {
      if (!usage || typeof usage !== 'object') return;
      ensureCacheDir();
      writeFileSync(USAGE_CACHE, JSON.stringify({
        fetchedAtMs: Date.now(),
        usage,
        hardLimit: hard ?? null,
        planInfo: plan?.planInfo ?? plan ?? null,
      }));
    })
    .catch(() => {})
    .finally(() => { refreshing = false; });
}

// Cursor's quotas are a monthly billing-cycle model (Included / Auto / API /
// On-Demand), not Claude-style 5h/weekly or Devin-style daily/weekly windows.
export function quota() {
  refreshUsageSoon();
  const cached = readUsageCache();
  if (!cached?.usage) return null;
  const u = cached.usage;
  const plan = u.planUsage ?? {};
  const spend = u.spendLimitUsage ?? {};
  const hard = cached.hardLimit ?? {};
  const planInfo = cached.planInfo ?? {};
  const limit = Number(plan.limit ?? 0);
  const includedSpend = Number(plan.includedSpend ?? plan.totalSpend ?? 0);
  // Prefer spend/limit (matches Cursor's "You've used N% of your included
  // usage" copy) over totalPercentUsed, which can disagree with that message.
  const includedPct = limit > 0
    ? pct(100 * includedSpend / limit)
    : pct(plan.totalPercentUsed);
  const out = {
    ageMs: cached.fetchedAtMs ? Date.now() - cached.fetchedAtMs : null,
    planName: planInfo.planName ?? null,
    period: planInfo.includedUsagePeriod ?? null,
    resetMs: epochMs(u.billingCycleEnd) || epochMs(planInfo.billingCycleEnd),
    startMs: epochMs(u.billingCycleStart),
    includedPct,
    autoPct: pct(plan.autoPercentUsed),
    apiPct: pct(plan.apiPercentUsed),
    includedSpend,
    limit,
    remaining: Number(plan.remaining ?? 0),
    message: u.displayMessage ?? null,
    onDemand: null,
  };
  if (hard.noUsageBasedAllowed) {
    out.onDemand = { off: 'off' };
  } else if (Number(hard.hardLimit) > 0 && Number(hard.hardLimit) < 2147483647) {
    const used = Number(spend.individualUsed ?? 0) / 100;
    out.onDemand = { used, limit: Number(hard.hardLimit) };
  } else if (spend.individualLimit > 0) {
    out.onDemand = {
      used: Number(spend.individualUsed ?? 0) / 100,
      limit: Number(spend.individualLimit) / 100,
    };
  } else if (hard.hardLimit >= 2147483647) {
    out.onDemand = { unlimited: true, used: Number(spend.individualUsed ?? 0) / 100 };
  }
  return out;
}

// Compact statusline segment: `I47% A02% P00%` (Included / Auto / API).
export function quotaSeg(q = quota()) {
  if (!q) return '';
  const parts = [];
  if (q.includedPct != null) parts.push(`I${String(q.includedPct).padStart(2, '0')}%`);
  if (q.autoPct != null) parts.push(`A${String(q.autoPct).padStart(2, '0')}%`);
  if (q.apiPct != null) parts.push(`P${String(q.apiPct).padStart(2, '0')}%`);
  return parts.join(' ');
}

// --------------------------------------------------------- statusLine cache

export function sessionCachePath(sessionId) {
  return join(CACHE_DIR, `${sessionId}.json`);
}

export function readSessionCache(sessionId) {
  if (!sessionId) return null;
  try {
    const d = JSON.parse(readFileSync(sessionCachePath(sessionId), 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch { return null; }
}

// Write path used by statusline.mjs (also exported for tests).
export function writeSessionCache(payload) {
  const id = payload?.session_id;
  if (!id) return null;
  ensureCacheDir();
  const out = { at: Date.now(), ...payload };
  writeFileSync(sessionCachePath(id), JSON.stringify(out));
  return out;
}

// --------------------------------------------------------- context window

const WINDOW_STEPS = [200_000, 272_000, 500_000, 1_000_000, 2_000_000];
const FAMILY_DEFAULTS = [
  [/composer|auto|default/, 200_000],
  [/gpt|sol|codex/, 272_000],
  [/claude|sonnet|opus|fable/, 200_000],
  [/gemini/, 1_000_000],
  [/grok/, 256_000],
];
const hwPath = join(STATE_DIR, 'cursor-status-context.json');
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

export function contextWindow(model = '', fromCache = null) {
  const cached = fromCache?.context_window?.context_window_size;
  if (cached > 0) return cached;
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

  const tryPath = (slug) => {
    if (!slug) return null;
    const p = join(PROJECTS_DIR, slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
    return existsSync(p) ? p : null;
  };

  if (cwd) {
    const p = tryPath(projectSlug(cwd));
    if (p) { pathCache.set(sessionId, p); return p; }
  }
  try {
    for (const dir of readdirSync(PROJECTS_DIR)) {
      const p = join(PROJECTS_DIR, dir, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
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

function toolPath(input) {
  if (!input || typeof input !== 'object') return null;
  return input.path ?? input.file_path ?? input.target_file ?? input.notebook_path ?? null;
}

// Current state from the transcript tail + statusLine cache. Cursor's
// citation transcript has no token usage; those come from the cache.
export function tailSnapshot(path, sessionId) {
  const cache = readSessionCache(sessionId);
  const conf = configuredModel();
  const out = {
    model: cache?.model?.display_name ?? cache?.model?.id ?? conf?.display ?? conf?.id ?? null,
    modelId: cache?.model?.id ?? conf?.id ?? null,
    param: cache?.model?.param_summary ?? null,
    maxMode: !!(cache?.model?.max_mode || conf?.maxMode),
    autorun: !!cache?.autorun,
    mode: approvalMode(),
    title: cache?.session_name ?? null,
    vim: cache?.vim?.mode ?? null,
    worktree: cache?.worktree?.name ?? null,
    version: cache?.version ?? null,
    ctxTokens: 0,
    window: 0,
    ctxPct: null,
    inTok: cache?.context_window?.total_input_tokens ?? 0,
    outTok: cache?.context_window?.total_output_tokens ?? 0,
    cacheAgeMs: cache?.at ? Date.now() - cache.at : null,
    pending: [],
    agents: 0,
    lastAt: 0,
  };

  const usedPct = cache?.context_window?.used_percentage;
  const window = contextWindow(out.modelId ?? out.model ?? '', cache);
  out.window = window;
  if (usedPct != null && Number.isFinite(usedPct)) {
    out.ctxPct = Math.min(99, Math.max(0, Math.round(usedPct)));
    if (window > 0) out.ctxTokens = Math.round(usedPct / 100 * window);
  } else if (cache?.context_window?.total_input_tokens > 0 && window > 0) {
    out.ctxTokens = cache.context_window.total_input_tokens;
    out.ctxPct = Math.min(99, Math.floor(100 * out.ctxTokens / window));
  }
  noteContext(out.modelId ?? out.model, out.ctxTokens);

  if (!path) return out;

  // Walk the tail; tools after the last user/turn_ended are the in-flight set.
  const open = [];
  let agents = 0;
  for (const r of records(readTail(path, 512 * 1024))) {
    const role = r.role ?? r.type;
    if (role === 'user' || role === 'turn_ended') {
      open.length = 0;
      agents = 0;
      continue;
    }
    if (role !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      const name = b.name ?? '?';
      if (name === 'Task') agents++;
      else open.push(name);
    }
    out.lastAt = Math.max(out.lastAt, Date.parse(r.timestamp ?? '') || 0);
  }
  out.pending = open;
  out.agents = agents;
  if (!out.lastAt) {
    try { out.lastAt = statSync(path).mtimeMs; } catch {}
  }
  return out;
}

// -------------------------------------------------- incremental full scan

const MAX_CHUNK = 8 * 1024 * 1024;

function emptyScan() {
  return { offset: 0, tools: 0, edits: 0, roots: [] };
}

function statePath(sessionId) {
  return join(STATE_DIR, `cursor-status-scan-${sessionId}.json`);
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

  const cut = text.lastIndexOf('\n');
  if (cut < 0) return s;
  const complete = text.slice(0, cut);
  const roots = new Set(s.roots);
  for (const r of records(complete)) {
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      s.tools++;
      if (!EDIT_TOOLS.has(b.name)) continue;
      s.edits++;
      const fp = toolPath(b.input);
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
  unrestricted: 'unrestricted',
  allowlist: 'allowlist',
  ask: 'ask',
};

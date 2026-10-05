// Codex rollout metadata only; no credential reads or network requests.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync,
  openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { STATE_DIR, repoRoot } from './core.mjs';

const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
const paths = new Map();
const scans = new Map();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CHUNK_BYTES = 8 * 1024 * 1024;

export function transcriptPath(sessionId, home = codexHome) {
  if (!UUID.test(sessionId ?? '')) return null;
  const key = `${home}:${sessionId}`;
  const cached = paths.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.path;
  function find(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) return path;
        if (entry.isDirectory()) {
          const found = find(path);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  }
  const path = find(join(home, 'sessions'));
  paths.set(key, { at: Date.now(), path });
  return path;
}

export function emptySnapshot() {
  return { offset: 0, model: null, effort: null, mode: null, cwd: null,
    ctxPct: null, ctxTokens: 0, window: 0, inTok: 0, outTok: 0, cachedTok: 0,
    pending: [], calls: {}, agents: 0, roots: [], rateLimits: null, rateAt: 0, lastAt: 0 };
}

export function applyRecord(s, record) {
  const p = record.payload ?? {};
  s.lastAt = Math.max(s.lastAt, Date.parse(record.timestamp) || 0);
  if (record.type === 'session_meta') s.cwd = p.cwd ?? s.cwd;
  if (record.type === 'turn_context') {
    s.model = p.model ?? s.model;
    s.effort = p.effort ?? p.reasoning_effort ?? s.effort;
    s.cwd = p.cwd ?? s.cwd;
    const sandbox = typeof p.sandbox_policy === 'string' ? p.sandbox_policy : p.sandbox_policy?.type;
    s.mode = [p.collaboration_mode?.mode === 'plan' ? 'plan' : '', sandbox,
      p.approval_policy].filter(Boolean).join('/');
  }
  if (record.type === 'event_msg' && p.type === 'token_count') {
    const info = p.info;
    if (info?.total_token_usage) {
      const total = info.total_token_usage;
      s.inTok = total.input_tokens ?? 0;
      s.outTok = total.output_tokens ?? 0;
      s.cachedTok = total.cached_input_tokens ?? 0;
    }
    if (info?.last_token_usage) s.ctxTokens = info.last_token_usage.total_tokens
      ?? (info.last_token_usage.input_tokens ?? 0) + (info.last_token_usage.output_tokens ?? 0);
    if (info?.model_context_window > 0) s.window = info.model_context_window;
    if (info?.last_token_usage && s.window > 0) s.ctxPct = Math.min(100, Math.floor(100 * s.ctxTokens / s.window));
    if (p.rate_limits) {
      s.rateLimits = p.rate_limits;
      s.rateAt = Date.parse(record.timestamp) || 0;
    }
  }
  if (record.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) {
    s.calls = {};
  }
  if (record.type === 'response_item') {
    if (['function_call', 'custom_tool_call'].includes(p.type) && p.call_id) s.calls[p.call_id] = p.name ?? 'tool';
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) delete s.calls[p.call_id];
  }
  s.pending = [...new Set(Object.values(s.calls))];
  // Only explicit cwd metadata establishes repositories; tool arguments may contain secrets.
  if (s.cwd && !s.roots.includes(s.cwd)) s.roots.push(s.cwd);
  return s;
}

export function tailSnapshot(path, stateDir = STATE_DIR) {
  if (!path || !existsSync(path)) return emptySnapshot();
  const checkpoint = join(stateDir, `paniolo-codex-${path.split(/[\\/]/).at(-1)}.json`);
  let s = scans.get(path);
  if (!s) {
    try {
      const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
      if (saved.version === 1 && saved.path === path) s = { ...emptySnapshot(), ...saved.snapshot };
    } catch {}
    s ??= emptySnapshot();
  }
  const stat = statSync(path);
  if (s.offset > stat.size || (s.mtimeMs && s.mtimeMs !== stat.mtimeMs && s.offset === stat.size)) s = emptySnapshot();
  if (s.offset < stat.size) {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size - s.offset));
    const fd = openSync(path, 'r');
    let count;
    try { count = readSync(fd, buf, 0, buf.length, s.offset); }
    finally { closeSync(fd); }
    const cut = buf.subarray(0, count).lastIndexOf(10);
    if (cut >= 0) {
      for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
        try { applyRecord(s, JSON.parse(line)); } catch {}
      }
      s.offset += cut + 1;
      s.mtimeMs = stat.mtimeMs;
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(checkpoint, JSON.stringify({ version: 1, path, snapshot: s }));
      } catch {}
    }
  }
  scans.set(path, s);
  return { ...s, roots: [...new Set(s.roots.map(repoRoot).filter(Boolean))] };
}

export function quotaWindows(s = emptySnapshot(), now = Date.now()) {
  if (!s.rateLimits) return null;
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = s.rateLimits[key];
    if (!w || !Number.isFinite(w.used_percent)) continue;
    const minutes = w.window_minutes;
    const label = minutes === 300 ? '5h' : minutes === 10080 ? 'W'
      : minutes ? `${minutes / 60}h` : key;
    const resetMs = w.resets_at ? w.resets_at * 1000 : 0;
    const rolled = resetMs > 0 && resetMs <= now;
    // A recorded window can expire between turns; usage since rollover is unknown.
    windows.push({ label, pct: rolled ? null : Math.round(w.used_percent),
      resetMs, rolledAtMs: rolled ? resetMs : 0, lastPct: w.used_percent });
  }
  return { windows, ageMs: s.rateAt ? Math.max(0, now - s.rateAt) : null, live: false };
}

export function transcriptIdleSecs(path, snapshot) {
  if (snapshot?.lastAt) return Math.max(0, (Date.now() - snapshot.lastAt) / 1000);
  try { return (Date.now() - statSync(path).mtimeMs) / 1000; } catch { return -1; }
}

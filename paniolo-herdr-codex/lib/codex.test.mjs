import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRecord, emptySnapshot, quotaWindows, tailSnapshot, transcriptPath } from './codex.mjs';
import { reconcile } from './reconcile.mjs';

test('uses cumulative token totals without summing repeated quota-only updates', () => {
  const s = emptySnapshot();
  applyRecord(s, { type: 'turn_context', payload: { model: 'gpt-test', effort: 'high',
    sandbox_policy: { type: 'workspace-write' }, approval_policy: 'on-request' } });
  const record = { type: 'event_msg', timestamp: '2026-10-04T12:00:00Z', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 200,
      cached_input_tokens: 800 }, last_token_usage: { total_tokens: 100 }, model_context_window: 400 } } };
  applyRecord(s, record);
  applyRecord(s, record);
  applyRecord(s, { type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 100 } } } });
  assert.equal(s.ctxPct, 25);
  assert.equal(s.inTok, 1000);
  assert.equal(s.cachedTok, 800);
  assert.equal(s.mode, 'workspace-write/on-request');
  assert.equal(quotaWindows(s, 99_000).windows[0].pct, 100);
  assert.equal(quotaWindows(s, 101_000).windows[0].pct, null);
});

test('matches tool call IDs and clears pending tools at turn boundaries', () => {
  const s = emptySnapshot();
  for (const [id, name] of [['a', 'exec'], ['b', 'read_file']]) applyRecord(s,
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name } });
  applyRecord(s, { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a' } });
  assert.deepEqual(s.pending, ['read_file']);
  applyRecord(s, { type: 'event_msg', payload: { type: 'task_complete' } });
  assert.deepEqual(s.pending, []);
});

test('finds only the exact session and handles partial UTF-8 appends and truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-footer-test-'));
  try {
    const day = join(dir, 'sessions', '2026', '10', '04');
    mkdirSync(day, { recursive: true });
    const id = '01a109b6-8f3e-7f63-8bbb-2ebf65e53b3c';
    const path = join(day, `rollout-date-${id}.jsonl`);
    const first = JSON.stringify({ type: 'turn_context', payload: { model: 'test-é', effort: 'high' } });
    writeFileSync(path, first + '\n');
    assert.equal(transcriptPath(id, dir), path);
    assert.equal(transcriptPath('../other', dir), null);
    assert.equal(transcriptPath('01a109b6-8f3e-7f63-8bbb-2ebf65e53b3d', dir), null);
    const state = join(dir, 'state');
    const s = tailSnapshot(path, state);
    assert.equal(s.offset, Buffer.byteLength(first + '\n'));
    assert.equal(s.model, 'test-é');
    appendFileSync(path, '{"type":"turn_context","payload":{"effort":"low"}}');
    assert.equal(tailSnapshot(path, state).effort, 'high');
    appendFileSync(path, '\n');
    assert.equal(tailSnapshot(path, state).effort, 'low');
    writeFileSync(path, '{"type":"turn_context","payload":{"model":"new"}}\n');
    assert.equal(tailSnapshot(path, state).model, 'new');
    assert.equal(tailSnapshot(path, state).effort, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provisions each Codex pane, leaves other footers alone and tolerates discovery failures', () => {
  const agents = ['p1', 'p2'].map(pane_id => ({ pane_id, tab_id: 't1', agent: 'codex' }));
  const panes = [{ pane_id: 'old', label: 'paniolo-codex:gone', tab_id: 't0' },
    { pane_id: 'claude', label: 'claude-status:c1', tab_id: 't0' }];
  const calls = [];
  const request = (...args) => {
    calls.push(args);
    if (args[0] === 'agent') return { agents };
    if (args[0] === 'pane' && args[1] === 'list') return { panes };
    if (args[0] === 'plugin') return { pane_id: `footer${calls.length}` };
    return null;
  };
  reconcile(request);
  assert.equal(calls.filter(a => a[0] === 'plugin').length, 2);
  assert.ok(calls.filter(a => a[0] === 'plugin').every(a => a.includes('--no-focus')));
  assert.deepEqual(calls.filter(a => a[1] === 'close'), [['pane', 'close', 'old']]);
  const failed = [];
  reconcile((...args) => { failed.push(args); return null; });
  assert.ok(failed.every(a => a[1] === 'list'));
});

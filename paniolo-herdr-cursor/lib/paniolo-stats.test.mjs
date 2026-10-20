import assert from 'node:assert/strict';
import test from 'node:test';
import { panioloLine } from './paniolo-stats.mjs';

test('status line keeps producer failures and active indexing visible', () => {
  const line = panioloLine({
    repo: { domains: {
      stale: { availability: 'outdated', reason: 'source-generation-changed', data: { states: { 'confirmed-stale': 2 } } },
      wiki: { availability: 'never-run', reason: 'no-check-recorded' },
      storage: { availability: 'available', reason: 'current', data: {
        roots: [{ role: 'modelCache', availability: 'unavailable', reason: 'root-missing', volumeKey: null }],
        volumes: [],
      } },
    } },
    workspace: { domains: {
      'qmd.health': { availability: 'degraded', reason: 'vector-backlog' },
      'qmd.maintenance': { availability: 'available', reason: 'current', data: { phase: 'embedding', indexingActive: true } },
      'qmd.retrieval': { availability: 'unavailable', reason: 'telemetry-disabled' },
      'git.workingTree': { availability: 'never-run', reason: 'projection-not-built' },
      storage: { availability: 'available', reason: 'current' },
      operations: { availability: 'never-run', reason: 'queue-not-created' },
    } },
  });
  assert.match(line, /^Paniolo: index embedding/);
  assert.match(line, /stale outdated \(source-generation-changed\)/);
  assert.match(line, /modelCache unavailable \(root-missing\)/);
  assert.match(line, /hooks unavailable \(telemetry-disabled\)/);
});

test('a missing stats response stays unknown', () => {
  assert.equal(panioloLine({ workspace: null, repo: null }), 'Paniolo: stats unavailable');
});

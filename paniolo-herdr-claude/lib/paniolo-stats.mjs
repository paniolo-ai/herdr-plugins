// Thin Herdr adapter for the Paniolo-owned, read-only stats snapshot.
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { env, platform } from 'node:process';

const POLL_MS = 10_000;
const FIELDS = 'stale,qmd.inventory,qmd.maintenance,qmd.health,qmd.retrieval,git.workingTree,storage,operations';
const REPO_FIELDS = 'stale,scan,wiki,git.workingTree,storage';
const snapshots = new Map();

function childEnv(root) {
  const next = { ...env };
  for (const key of Object.keys(next)) if (key.toLowerCase() === 'path') delete next[key];
  next.PATH = [join(root, 'node_modules', '.bin'), env.PATH ?? env.Path ?? '']
    .filter(Boolean).join(delimiter);
  return next;
}

function request(root, scope, fields) {
  return new Promise(resolve => {
    const command = platform === 'win32' ? 'paniolo.cmd' : 'paniolo';
    const args = ['stats', '--json', '--scope', scope, '--fields', fields];
    let output = '';
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    try {
      const child = spawn(command, args, {
        cwd: root, env: childEnv(root), windowsHide: true, shell: platform === 'win32',
      });
      const timeout = setTimeout(() => { child.kill(); finish(null); }, 5_000);
      timeout.unref();
      child.stdout?.on('data', chunk => {
        output += chunk;
        if (output.length > 65_536) { child.kill(); finish(null); }
      });
      child.on('error', () => { clearTimeout(timeout); finish(null); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) return finish(null);
        try { finish(JSON.parse(output)); } catch { finish(null); }
      });
    } catch { finish(null); }
  });
}

function poll(root, entry) {
  entry.running = true;
  Promise.all([
    request(root, 'workspace', FIELDS),
    request(root, 'repo', REPO_FIELDS),
  ]).then(([workspace, repo]) => {
    entry.workspace = workspace;
    entry.repo = repo;
    entry.running = false;
  }).catch(() => { entry.workspace = null; entry.repo = null; entry.running = false; });
}

/** Return the last display snapshot and schedule the next read-only poll. */
export function panioloStats(root) {
  if (!root) return null;
  let entry = snapshots.get(root);
  if (!entry) {
    entry = { at: 0, running: false, workspace: null, repo: null };
    snapshots.set(root, entry);
  }
  if (!entry.running && Date.now() - entry.at >= POLL_MS) {
    entry.at = Date.now();
    poll(root, entry);
  }
  return entry;
}

function domain(entry, scope, name) {
  return entry?.[scope]?.domains?.[name] ?? null;
}

function label(name, value) {
  if (!value) return `${name} unknown`;
  if (value.availability !== 'available') return `${name} ${value.availability} (${value.reason})`;
  return null;
}

function compactBytes(value) {
  if (typeof value !== 'number') return '?';
  return `${Math.round(value / (1024 ** 3))}G`;
}

/** Render the same availability labels that Paniolo returned. */
export function panioloLine(entry) {
  if (!entry) return '';
  const issues = [];
  const facts = [];
  const repo = entry.repo;
  const workspace = entry.workspace;
  if (!repo || !workspace) return 'Paniolo: stats unavailable';
  const maintenance = domain(entry, 'workspace', 'qmd.maintenance')?.data;
  if (maintenance?.indexingActive === true && ['indexing', 'embedding'].includes(maintenance.phase)) {
    issues.push(`index ${maintenance.phase}`);
  }

  for (const [scope, name, short] of [
    ['repo', 'stale', 'stale'], ['repo', 'scan', 'scan'], ['repo', 'wiki', 'wiki'],
    ['workspace', 'qmd.health', 'qmd'], ['workspace', 'qmd.maintenance', 'index'],
    ['workspace', 'qmd.retrieval', 'hooks'], ['workspace', 'git.workingTree', 'git'],
    ['workspace', 'storage', 'disk'], ['workspace', 'operations', 'jobs'],
  ]) {
    const issue = label(short, domain(entry, scope, name));
    if (issue) issues.push(issue);
  }
  const stale = domain(entry, 'repo', 'stale')?.data?.states;
  if (stale) {
    const open = (stale['pending-verification'] ?? 0) + (stale['confirmed-stale'] ?? 0)
      + (stale['remediation-proposed'] ?? 0);
    facts.push(`stale ${open}`);
  }
  const wiki = domain(entry, 'repo', 'wiki')?.data;
  const scan = domain(entry, 'repo', 'scan')?.data;
  if (scan && scan.errors != null && scan.warnings != null) {
    facts.push(`scan ${scan.errors}e/${scan.warnings}w`);
  }
  if (wiki && wiki.errors != null && wiki.warnings != null) {
    facts.push(`wiki ${wiki.errors}e/${wiki.warnings}w`);
  }
  const inventory = domain(entry, 'workspace', 'qmd.inventory')?.data;
  if (inventory) {
    facts.push(`qmd ${inventory.surfaces?.wiki ?? '?'}w/${inventory.surfaces?.docs ?? '?'}d/${inventory.surfaces?.codeComments ?? '?'}c`);
    if (inventory.vectorEligible != null && inventory.vectorReady != null) {
      facts.push(`vectors ${inventory.vectorReady}/${inventory.vectorEligible}`);
    }
  }
  const health = domain(entry, 'workspace', 'qmd.health');
  if (health && health.availability !== 'available') facts.push(`health ${health.reason}`);
  if (maintenance?.phase && maintenance.indexingActive !== true) facts.push(`index ${maintenance.phase}`);
  const retrieval = domain(entry, 'workspace', 'qmd.retrieval')?.data?.windows?.last24Hours;
  if (retrieval?.hitRate != null) facts.push(`hooks ${Math.round(retrieval.hitRate * 100)}%/${retrieval.samples}`);
  const operations = domain(entry, 'workspace', 'operations')?.data;
  if (operations) facts.push(`jobs ${operations.pending ?? '?'}q/${operations.leased ?? '?'}run`);
  const storage = domain(entry, 'repo', 'storage')?.data;
  if (storage) {
    for (const root of storage.roots ?? []) {
      const volume = (storage.volumes ?? []).find(item => item.volumeKey === root.volumeKey);
      if (root.availability !== 'available') {
        issues.push(`${root.role} ${root.availability} (${root.reason})`);
      }
      if (volume && root.availability === 'available') {
        facts.push(`${root.role} ${compactBytes(volume.availableBytes)}${root.pressure && root.pressure !== 'normal' ? ` ${root.pressure}` : ''}`);
      }
    }
  }
  return `Paniolo: ${[...issues, ...facts].join(' - ')}`;
}

/** Cached Git counts for a root; missing and failed readings are never clean. */
export function dirtySeg(roots) {
  const parts = [];
  for (const root of roots) {
    const entry = panioloStats(root);
    const git = domain(entry, 'repo', 'git.workingTree');
    if (!git || git.availability !== 'available') {
      parts.push(`${root.split(/[\\/]/).at(-1)} ?`);
      continue;
    }
    for (const checkout of git.data?.checkouts ?? []) {
      if (checkout.availability !== 'available' || !checkout.counts) {
        parts.push(`${checkout.repository} ?`);
      } else if (checkout.counts.uniqueDirtyPaths > 0) {
        parts.push(`${checkout.repository} ${checkout.counts.uniqueDirtyPaths}`);
      }
    }
  }
  return parts.length ? `dirty ${parts.join(' - ')}` : '';
}

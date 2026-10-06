#!/usr/bin/env node
// Writes Harbor Mutual's Apps (Claims Weekly, Finance Monthly) from the
// certified Datasets' current identities, so their tiles bind without drift.
//
//   node demo/harbor/build-apps.mjs --connector-root <dir with duckdb installed>
//
// Run it again after changing a Dataset block; commit what it writes. It
// starts the open-source DQL runtime on a scratch copy of each project, reads
// each Dataset's source id, revision and contract from /api/app-datasets, and
// writes the App files into demo/harbor/<workspace>/apps/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const oss = join(repo, 'oss');
const args = process.argv.slice(2);
const at = args.indexOf('--connector-root');
const connectorRoot = at >= 0 ? args[at + 1] : process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT;
if (!connectorRoot) {
  console.error('Pass --connector-root <dir with duckdb installed> (or set DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).');
  process.exit(1);
}
const { startProjectRuntime } = await import(join(oss, 'apps/cli/dist/host/index.js'));

/** Identities of every governed Dataset in a project, by title. */
async function datasetsOf(workspace) {
  const scratch = mkdtempSync(join(tmpdir(), `harbor-${workspace}-`));
  try {
    cpSync(join(here, workspace), scratch, { recursive: true, filter: (source) => !source.includes(`${workspace}/apps`) });
    mkdirSync(join(scratch, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(resolve(connectorRoot), 'node_modules'), join(scratch, '.dql', 'connectors', 'node_modules'), 'dir');
    execFileSync(process.execPath, [join(here, 'seed.mjs'), '--workspace', workspace, '--out', join(scratch, 'seeds', 'seed.json')], { stdio: 'pipe' });
    execFileSync(process.execPath, [join(oss, 'scripts/seed-eval-warehouse.mjs'), '--seed', join(scratch, 'seeds', 'seed.json'), '--connector-root', connectorRoot, '--out', join(scratch, 'harbor.duckdb')], { stdio: 'pipe' });
    const runtime = await startProjectRuntime(scratch, { preferredPort: 0 });
    try {
      const catalog = await (await fetch(`${runtime.url}/api/app-datasets`)).json();
      return new Map(catalog.datasets.map((dataset) => [dataset.title, { ...dataset, snapshotId: catalog.snapshotId }]));
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const datasetId = (sourceId) => `dataset_${createHash('sha256').update(sourceId).digest('hex').slice(0, 16)}`;
const binding = (dataset) => ({ id: datasetId(dataset.sourceId), sourceId: dataset.sourceId, sourceRevision: dataset.sourceRevision, snapshotId: dataset.snapshotId, contractFingerprint: dataset.contractFingerprint });

function tile(dataset, { i, x, y, w, h, title, viz, dimensions = [], measures = [], orderBy, limit }) {
  return {
    i, x, y, w, h,
    sourceId: dataset.sourceId,
    sourceRevision: dataset.sourceRevision,
    query: { dimensions, measures: measures.map((measure) => ({ measure })), ...(orderBy ? { orderBy } : {}), ...(limit ? { limit } : {}) },
    viz: { type: viz },
    title,
    sourceClass: 'certified_block',
    filterBindings: [],
    review: { status: 'not_required', sourceFingerprint: dataset.sourceRevision },
    trustState: 'certified',
    reviewStatus: 'certified',
  };
}

/** The same tiles laid out for wide, medium and narrow screens. */
function layoutOf(tiles) {
  const scaled = (cols) => tiles.map((item) => ({ ...item, x: Math.floor((item.x * cols) / 12), w: Math.max(1, Math.floor((item.w * cols) / 12)) }));
  let y = 0;
  const narrow = tiles.map((item) => { const placed = { ...item, x: 0, y, w: 1 }; y += item.h; return placed; });
  return { kind: 'grid', cols: 12, rowHeight: 80, items: tiles, responsive: { wide: { kind: 'grid', cols: 12, rowHeight: 80, items: tiles }, medium: { kind: 'grid', cols: 6, rowHeight: 80, items: scaled(6) }, narrow: { kind: 'grid', cols: 1, rowHeight: 80, items: narrow } } };
}

function page({ id, title, description, domain, audience, datasets, tiles, regionFilter = true }) {
  return {
    version: 3,
    id,
    metadata: { title, description, domain, audience, visibility: 'shared', lifecycle: 'certified' },
    layout: layoutOf(tiles),
    datasets: datasets.map(binding),
    filters: regionFilter ? [{ id: 'region', type: 'multiselect', label: 'Region', scope: { app: true }, datasetBindings: Object.fromEntries(datasets.map((dataset) => [datasetId(dataset.sourceId), { field: 'region' }])) }] : [],
  };
}

function app({ id, name, description, domain, owner, schedules, homepage, readers = ['viewer', 'analyst', 'owner'] }) {
  return {
    version: 1,
    id,
    name,
    description,
    visibility: 'shared',
    publicationIntent: 'shared_project',
    ownerDomain: domain,
    usesDomains: [domain],
    requiredExports: [],
    domain,
    audience: 'stakeholders',
    lifecycle: 'certified',
    owners: [owner],
    members: [{ userId: owner, displayName: owner, roles: ['owner', 'analyst'] }],
    // DQL's standard App roles, and each IdP group a policy names (the host passes people's groups through).
    roles: [{ id: 'owner', displayName: 'Owner' }, { id: 'analyst', displayName: 'Analyst' }, { id: 'viewer', displayName: 'Viewer' },
      ...readers.filter((role) => !['owner', 'analyst', 'viewer'].includes(role)).map((group) => ({ id: group, displayName: `${group} (IdP group)` }))],
    policies: [
      { id: 'readers', domain, minClassification: 'internal', allowedRoles: readers, accessLevel: 'read', enabled: true },
      ...(readers.includes('viewer') ? [{ id: 'analyst-execute', domain, minClassification: 'internal', allowedRoles: ['analyst', 'owner'], accessLevel: 'execute', enabled: true }] : []),
      { id: 'owner-admin', domain, minClassification: 'restricted', allowedRoles: ['owner'], accessLevel: 'admin', enabled: true },
    ],
    rlsBindings: [],
    schedules,
    homepage,
  };
}

function write(workspace, appDoc, pages) {
  const dir = join(here, workspace, 'apps', appDoc.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'dashboards'), { recursive: true });
  writeFileSync(join(dir, 'dql.app.json'), `${JSON.stringify(appDoc, null, 2)}\n`);
  for (const item of pages) writeFileSync(join(dir, 'dashboards', `${item.id}.dqld`), `${JSON.stringify(item, null, 2)}\n`);
  console.log(`Wrote ${workspace}/apps/${appDoc.id} (${pages.length} page${pages.length === 1 ? '' : 's'})`);
}

const claims = await datasetsOf('claims');
const claimsDataset = claims.get('Claims Dataset');
const payments = claims.get('Claim payments Dataset');
if (!claimsDataset || !payments) throw new Error('The Claims project has no Claims Dataset or Claim payments Dataset.');
write('claims', app({
  id: 'claims-weekly',
  name: 'Claims Weekly',
  description: 'What the claims team looks at every Monday: claims filed, amounts claimed and paid, the weekly trend and where claims come from.',
  domain: 'claims',
  owner: 'maria@harbor.example',
  homepage: { type: 'dashboard', id: 'overview' },
  schedules: [{
    id: 'monday-digest',
    cron: '0 7 * * 1',
    timezone: 'America/New_York',
    dashboard: 'overview',
    runAs: 'maria@harbor.example',
    deliver: [{ kind: 'email', to: ['claims-leadership@harbor.example'] }, { kind: 'slack', channel: '#claims-leadership' }],
  }],
}), [page({
  id: 'overview',
  title: 'Claims this week',
  description: 'Claims filed, amounts claimed and paid, the weekly trend, and claims by region and product.',
  domain: 'claims',
  audience: 'stakeholders',
  datasets: [claimsDataset, payments],
  tiles: [
    tile(claimsDataset, { i: 'claims-filed', x: 0, y: 0, w: 4, h: 2, title: 'Claims filed', viz: 'kpi', measures: ['claim_count'] }),
    tile(claimsDataset, { i: 'amount-claimed', x: 4, y: 0, w: 4, h: 2, title: 'Amount claimed', viz: 'kpi', measures: ['claimed_amount_total'] }),
    tile(payments, { i: 'claims-paid', x: 8, y: 0, w: 4, h: 2, title: 'Claims paid', viz: 'kpi', measures: ['paid_amount'] }),
    tile(claimsDataset, { i: 'claims-by-week', x: 0, y: 2, w: 12, h: 4, title: 'Claims filed by week', viz: 'line', dimensions: [{ field: 'reported_date', timeGrain: 'week' }], measures: ['claim_count'], orderBy: [{ alias: 'reported_date_week', direction: 'asc' }] }),
    tile(claimsDataset, { i: 'claims-by-region', x: 0, y: 6, w: 12, h: 5, title: 'Claims by region and product', viz: 'table', dimensions: [{ field: 'region' }, { field: 'product' }], measures: ['claim_count', 'claimed_amount_total'], orderBy: [{ alias: 'claim_count', direction: 'desc' }], limit: 50 }),
  ],
})]);

const finance = await datasetsOf('finance');
const premiums = finance.get('Premiums Dataset');
if (!premiums) throw new Error('The Finance project has no Premiums Dataset.');
write('finance', app({
  id: 'finance-monthly',
  name: 'Finance Monthly',
  description: 'Premium written and earned each month, by region and product.',
  domain: 'finance',
  owner: 'frank@harbor.example',
  homepage: { type: 'dashboard', id: 'overview' },
  schedules: [],
  // Finance's leaders (an IdP group) and the App's owner read it; anyone else asks for access (flow 8).
  readers: ['finance-leaders', 'owner'],
}), [page({
  id: 'overview',
  title: 'Premiums this month',
  description: 'Premium written and earned, the monthly trend, and premium by region.',
  domain: 'finance',
  audience: 'stakeholders',
  datasets: [premiums],
  tiles: [
    tile(premiums, { i: 'written', x: 0, y: 0, w: 6, h: 2, title: 'Premium written', viz: 'kpi', measures: ['written_premium_total'] }),
    tile(premiums, { i: 'earned', x: 6, y: 0, w: 6, h: 2, title: 'Premium earned', viz: 'kpi', measures: ['earned_premium_total'] }),
    tile(premiums, { i: 'by-month', x: 0, y: 2, w: 12, h: 4, title: 'Premium by month', viz: 'bar', dimensions: [{ field: 'month', timeGrain: 'month' }], measures: ['written_premium_total', 'earned_premium_total'], orderBy: [{ alias: 'month_month', direction: 'asc' }] }),
    tile(premiums, { i: 'by-region', x: 0, y: 6, w: 12, h: 4, title: 'Premium by region', viz: 'table', dimensions: [{ field: 'region' }], measures: ['written_premium_total', 'earned_premium_total'], orderBy: [{ alias: 'written_premium_total', direction: 'desc' }] }),
  ],
})]);
process.exit(0);

#!/usr/bin/env node
// Harbor Mutual's fake warehouse: the same rows every time.
//
//   node demo/harbor/seed.mjs --workspace claims --out <dir>/seeds/seed.json
//
// Writes a seed file in the shape the open-source seed script reads
// (oss/scripts/seed-eval-warehouse.mjs), which then builds the DuckDB file.
// Everything here is invented: names are "Test Member 0001", social security
// numbers are in the 900 range (never issued), emails are @example.test,
// phone numbers are 555-01xx, and diagnosis codes start with ZZ (not an
// ICD-10 chapter).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGIONS = ['Northeast', 'Southeast', 'Midwest', 'West'];
const PRODUCTS = ['Auto', 'Home', 'Health'];
const CLAIM_TYPES = { Auto: ['Collision', 'Glass', 'Theft'], Home: ['Water damage', 'Fire', 'Storm'], Health: ['Outpatient', 'Inpatient', 'Pharmacy'] };
const TEAMS = ['Property', 'Casualty', 'Medical'];

/** A small deterministic generator (mulberry32), so every start builds the same warehouse. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (value, width) => String(value).padStart(width, '0');
const day = (start, offset) => {
  const date = new Date(Date.UTC(2026, 0, 1) + (start + offset) * 86_400_000);
  return date.toISOString().slice(0, 10);
};
const money = (value) => Math.round(value * 100) / 100;

/** Every table, for both workspaces; each workspace takes the ones it serves. */
export function harborTables() {
  const next = random(20260926);
  const pick = (items) => items[Math.floor(next() * items.length)];
  const between = (low, high) => low + next() * (high - low);

  const adjusters = [];
  for (let index = 1; index <= 16; index += 1) {
    adjusters.push({ adjuster_id: `ADJ-${pad(index, 2)}`, adjuster_name: `Test Adjuster ${pad(index, 2)}`, region: REGIONS[(index - 1) % REGIONS.length], team: TEAMS[(index - 1) % TEAMS.length] });
  }

  const members = [];
  for (let index = 1; index <= 200; index += 1) {
    const id = pad(index, 4);
    members.push({
      member_id: `M-${id}`,
      full_name: `Test Member ${id}`,
      ssn: `9${pad(Math.floor(next() * 100), 2)}-${pad(10 + Math.floor(next() * 89), 2)}-${pad(Math.floor(next() * 10_000), 4)}`,
      date_of_birth: day(-365 * (25 + Math.floor(next() * 50)), Math.floor(next() * 365)),
      email: `member${id}@example.test`,
      phone: `555-01${pad(Math.floor(next() * 100), 2)}`,
      region: REGIONS[index % REGIONS.length],
      joined_date: day(-900, Math.floor(next() * 800)),
    });
  }

  const policies = [];
  for (let index = 1; index <= 260; index += 1) {
    const member = members[(index * 7) % members.length];
    const product = PRODUCTS[index % PRODUCTS.length];
    policies.push({
      policy_id: `P-${pad(index, 5)}`,
      member_id: member.member_id,
      product,
      region: member.region,
      effective_date: day(-400, Math.floor(next() * 400)),
      annual_premium: money(product === 'Health' ? between(3600, 9000) : product === 'Home' ? between(900, 2400) : between(700, 1900)),
      status: next() < 0.9 ? 'active' : 'lapsed',
    });
  }

  const claims = [];
  const payments = [];
  let paymentNumber = 0;
  for (let index = 1; index <= 600; index += 1) {
    const policy = policies[Math.floor(next() * policies.length)];
    const loss = Math.floor(next() * 262); // Jan 1 to Sep 19, 2026
    const reported = loss + 1 + Math.floor(next() * 6);
    const regionAdjusters = adjusters.filter((adjuster) => adjuster.region === policy.region);
    const age = 268 - reported;
    const roll = next();
    const status = age < 21 ? (roll < 0.8 ? 'open' : 'closed') : roll < 0.12 ? 'open' : roll < 0.2 ? 'denied' : 'closed';
    const claimed = money(policy.product === 'Health' ? between(200, 12_000) : policy.product === 'Home' ? between(1_500, 40_000) : between(400, 15_000));
    const claim = {
      claim_id: `C-${pad(index, 6)}`,
      policy_id: policy.policy_id,
      member_id: policy.member_id,
      region: policy.region,
      adjuster_id: pick(regionAdjusters).adjuster_id,
      product: policy.product,
      claim_type: pick(CLAIM_TYPES[policy.product]),
      diagnosis_code: policy.product === 'Health' ? `ZZ${pad(Math.floor(next() * 90) + 10, 2)}.${Math.floor(next() * 10)}` : null,
      loss_date: day(0, loss),
      reported_date: day(0, reported),
      status,
      claimed_amount: claimed,
    };
    claims.push(claim);
    if (status === 'closed' || (status === 'open' && next() < 0.4)) {
      const parts = status === 'closed' ? 1 + Math.floor(next() * 3) : 1;
      const total = status === 'closed' ? claimed * between(0.55, 1) : claimed * between(0.1, 0.4);
      for (let part = 0; part < parts; part += 1) {
        paymentNumber += 1;
        payments.push({
          payment_id: `PAY-${pad(paymentNumber, 6)}`,
          claim_id: claim.claim_id,
          region: claim.region,
          product: claim.product,
          paid_date: day(0, Math.min(reported + 5 + part * 9 + Math.floor(next() * 10), 267)),
          amount: money(total / parts),
          method: pick(['ACH', 'Check', 'Card']),
        });
      }
    }
  }

  // Finance: premiums written and earned per policy per month (Jan to Sep 2026).
  const premiums = [];
  for (const policy of policies) {
    for (let month = 1; month <= 9; month += 1) {
      const monthStart = `2026-${pad(month, 2)}-01`;
      if (policy.effective_date > `2026-${pad(month, 2)}-28`) continue;
      premiums.push({
        policy_id: policy.policy_id,
        region: policy.region,
        product: policy.product,
        month: monthStart,
        written_premium: money(policy.annual_premium / 12),
        earned_premium: money((policy.annual_premium / 12) * (policy.status === 'active' ? 1 : 0.5)),
      });
    }
  }

  const text = (name) => ({ name, type: 'text' });
  const ts = (name) => ({ name, type: 'timestamp' });
  const num = (name) => ({ name, type: 'decimal' });
  return {
    regions: { columns: [text('region'), text('region_manager')], rows: REGIONS.map((region, index) => ({ region, region_manager: `Test Manager ${pad(index + 1, 2)}` })) },
    adjusters: { columns: [text('adjuster_id'), text('adjuster_name'), text('region'), text('team')], rows: adjusters },
    members: { columns: [text('member_id'), text('full_name'), text('ssn'), ts('date_of_birth'), text('email'), text('phone'), text('region'), ts('joined_date')], rows: members },
    policies: { columns: [text('policy_id'), text('member_id'), text('product'), text('region'), ts('effective_date'), num('annual_premium'), text('status')], rows: policies },
    claims: { columns: [text('claim_id'), text('policy_id'), text('member_id'), text('region'), text('adjuster_id'), text('product'), text('claim_type'), text('diagnosis_code'), ts('loss_date'), ts('reported_date'), text('status'), num('claimed_amount')], rows: claims },
    claim_payments: { columns: [text('payment_id'), text('claim_id'), text('region'), text('product'), ts('paid_date'), num('amount'), text('method')], rows: payments },
    premiums: { columns: [text('policy_id'), text('region'), text('product'), ts('month'), num('written_premium'), num('earned_premium')], rows: premiums },
  };
}

/** The tables each workspace's warehouse holds. */
export const WORKSPACE_TABLES = {
  claims: ['regions', 'adjusters', 'members', 'policies', 'claims', 'claim_payments'],
  finance: ['regions', 'policies', 'premiums', 'claim_payments'],
};

export function seedFor(workspace) {
  const names = WORKSPACE_TABLES[workspace];
  if (!names) throw new Error(`No Harbor workspace ${workspace}; choose ${Object.keys(WORKSPACE_TABLES).join(' or ')}.`);
  const all = harborTables();
  return {
    _comment: `Harbor Mutual ${workspace} warehouse. Invented data for the DQL Enterprise demo; see demo/harbor/seed.mjs.`,
    tables: Object.fromEntries(names.map((name) => [name, all[name]])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const workspace = value('--workspace') ?? 'claims';
  const out = value('--out');
  const seed = seedFor(workspace);
  if (!out) {
    process.stdout.write(`${JSON.stringify(seed)}\n`);
  } else {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(seed)}\n`);
    console.error(`Wrote ${Object.keys(seed.tables).length} tables (${Object.values(seed.tables).reduce((sum, table) => sum + table.rows.length, 0)} rows) to ${out}`);
  }
}

/**
 * Phase 15.1 production hardening — offline logic tests.
 * Run: node scripts/test-phase15-1-hardening.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Holder tier (mirror _shared/holder.ts) ──
const TIERS = [
  { tier: 'whale', mult: 1.5, minBal: 250_000_000_000n },
  { tier: 'gold', mult: 1.25, minBal: 50_000_000_000n },
  { tier: 'silver', mult: 1.1, minBal: 10_000_000_000n },
  { tier: 'holder', mult: 1.05, minBal: 1_000_000_000n },
  { tier: 'none', mult: 1.0, minBal: 0n },
];

function tierFromBalance(balance) {
  for (const t of TIERS) {
    if (balance >= t.minBal) return t;
  }
  return TIERS[TIERS.length - 1];
}

assert.equal(tierFromBalance(0n).tier, 'none');
assert.equal(tierFromBalance(5_000_000_000n).tier, 'holder');
assert.equal(tierFromBalance(250_000_000_000n).tier, 'whale');

// Client cannot upgrade tier without balance
assert.notEqual(tierFromBalance(0n).tier, 'whale');

// ── Epoch remainder distribution ──
function distributePool(pool, players) {
  const totalPts = players.reduce((s, p) => s + p.pts, 0n);
  if (totalPts <= 0n) return players.map((p) => ({ ...p, alloc: 0n }));

  const withFloor = players.map((p) => ({
    ...p,
    alloc: (pool * p.pts) / totalPts,
  }));
  let allocated = withFloor.reduce((s, p) => s + p.alloc, 0n);
  let remainder = pool - allocated;
  const sorted = [...withFloor].sort((a, b) => (b.pts > a.pts ? 1 : b.pts < a.pts ? -1 : (a.id > b.id ? 1 : -1)));
  for (const row of sorted) {
    if (remainder <= 0n) break;
    row.alloc += 1n;
    remainder -= 1n;
    allocated += 1n;
  }
  return withFloor;
}

const pool = 100n;
const players = [
  { id: 'a', pts: 30n },
  { id: 'b', pts: 70n },
];
const result = distributePool(pool, players);
const sum = result.reduce((s, r) => s + r.alloc, 0n);
assert.equal(sum, pool);

const zero = distributePool(1000n, [{ id: 'x', pts: 0n }]);
assert.equal(zero[0].alloc, 0n);

// ── Guild contract pool validation ──
const guildConfig = readFileSync(join(root, 'src/config/guildConfig.ts'), 'utf8');
assert.match(guildConfig, /GUILD_TRACKED_OBJECTIVES/);
assert.match(guildConfig, /GUILD_DISABLED_AT_LAUNCH/);

const tracked = ['visit_districts', 'complete_missions', 'meet_players', 'discover_landmarks', 'join_event', 'join_events'];
for (const t of tracked) assert.match(guildConfig, new RegExp(`'${t}'`));

const migration = readFileSync(join(root, 'database/migrations/20260813_phase15_1_production_hardening.sql'), 'utf8');
assert.match(migration, /apply_verified_holder_status/);
assert.match(migration, /run_reward_epoch_maintenance/);
assert.match(migration, /begin_epoch_reward_claim/);
assert.match(migration, /Use refresh-holder-status edge function/);

// Edge functions exist
for (const fn of ['refresh-holder-status', 'claim-rugtown-reward', 'finalize-reward-epochs']) {
  readFileSync(join(root, `supabase/functions/${fn}/index.ts`), 'utf8');
}

// No client balance in HolderService
const holderService = readFileSync(join(root, 'src/lib/vault/HolderService.ts'), 'utf8');
assert.doesNotMatch(holderService, /p_balance_base_units/);
assert.match(holderService, /refresh-holder-status/);

// Vault uses edge claim
const vaultService = readFileSync(join(root, 'src/lib/vault/VaultService.ts'), 'utf8');
assert.match(vaultService, /claim-rugtown-reward/);

console.log('test-phase15-1-hardening: all assertions passed');

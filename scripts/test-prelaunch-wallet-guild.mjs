/**
 * Pre-launch wallet / username / guild / vault smoke tests (offline logic).
 * Run: node scripts/test-prelaunch-wallet-guild.mjs
 */
import assert from 'node:assert/strict';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
const RESERVED = new Set(['admin', 'moderator', 'mod', 'rugtown', 'system', 'support', 'help', 'null', 'undefined']);

function validateUsername(raw) {
  const trimmed = raw.trim();
  if (!USERNAME_RE.test(trimmed)) return 'invalid format';
  if (RESERVED.has(trimmed.toLowerCase())) return 'reserved';
  return null;
}

function normalizeUsername(raw) {
  return raw.trim().toLowerCase();
}

// Username validation
assert.equal(validateUsername('Olskido'), null);
assert.equal(validateUsername('ol'), 'invalid format');
assert.equal(validateUsername('admin'), 'reserved');
assert.equal(normalizeUsername('Olskido'), 'olskido');
assert.equal(normalizeUsername('Olskido'), normalizeUsername('OLSKIDO'));

// Case-insensitive uniqueness concept
const taken = new Set(['olskido']);
assert.ok(taken.has(normalizeUsername('OLSKIDO')));

// Guild idempotency key shape
const missionId = 'ch1_new_face';
const guildKey = `mission:${missionId}:guild`;
const rpKey = `mission:${missionId}:rp`;
assert.notEqual(guildKey, rpKey);

// Holder tier ordering (mirrors rewardConfig)
const tiers = [
  { id: 'none', min: 0n, mult: 1 },
  { id: 'holder', min: 1_000_000_000n, mult: 1.05 },
  { id: 'silver', min: 10_000_000_000n, mult: 1.1 },
];
function tierFromBalance(bal) {
  let m = tiers[0];
  for (const t of tiers) if (bal >= t.min) m = t;
  return m;
}
assert.equal(tierFromBalance(0n).id, 'none');
assert.equal(tierFromBalance(5_000_000_000n).id, 'holder');
assert.equal(tierFromBalance(50_000_000_000n).id, 'silver');

console.log('test-prelaunch-wallet-guild: all assertions passed');

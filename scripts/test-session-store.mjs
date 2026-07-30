/**
 * test-session-store.mjs — focused persistence checks (no test runner required).
 * Run: node scripts/test-session-store.mjs
 */

import assert from 'node:assert/strict';

// Minimal mirror of parseSession validation logic for CI without TS transpile.
const SESSION_SCHEMA_VERSION = 2;

function parseSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw;
  if (o.schemaVersion !== 1 && o.schemaVersion !== 2) return null;
  let position = null;
  if (o.position && typeof o.position === 'object') {
    const p = o.position;
    if (typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y)) {
      position = { x: p.x, y: p.y };
    }
  }
  const allowed = ['/', '/auth', '/auth/callback', '/character', '/play'];
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    route: allowed.includes(o.route) ? o.route : '/',
    enteredGame: o.enteredGame === true,
    playerName: typeof o.playerName === 'string' ? o.playerName.slice(0, 32) : '',
    position,
    districtId: typeof o.districtId === 'string' ? o.districtId : null,
    interiorId: typeof o.interiorId === 'string' ? o.interiorId : null,
    activeMissionId: typeof o.activeMissionId === 'string' ? o.activeMissionId : null,
    cameraZoom: typeof o.cameraZoom === 'number' && Number.isFinite(o.cameraZoom) ? o.cameraZoom : null,
    savedAt: typeof o.savedAt === 'number' ? o.savedAt : Date.now(),
  };
}

function clampWorldPosition(pos, worldW, worldH, margin = 40) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  const x = Math.min(worldW - margin, Math.max(margin, pos.x));
  const y = Math.min(worldH - margin, Math.max(margin, pos.y));
  return { x, y };
}

function sessionStorageKey(userId) {
  if (userId && !String(userId).startsWith('guest_')) return `rugtown:session:v2:user:${userId}`;
  return `rugtown:session:v2:guest:test`;
}

// malformed
assert.equal(parseSession(null), null);
assert.equal(parseSession({ schemaVersion: 99 }), null);
assert.equal(parseSession({ schemaVersion: 2, position: { x: 'nope', y: 1 } }).position, null);

// valid
const ok = parseSession({
  schemaVersion: 2,
  route: '/play',
  enteredGame: true,
  playerName: 'Boom',
  position: { x: 100, y: 200 },
  savedAt: Date.now(),
});
assert.equal(ok.route, '/play');
assert.equal(ok.enteredGame, true);
assert.deepEqual(ok.position, { x: 100, y: 200 });

// bad route falls back
assert.equal(parseSession({ schemaVersion: 2, route: '/hack' }).route, '/');

// per-user keys
assert.equal(sessionStorageKey('abc-uuid'), 'rugtown:session:v2:user:abc-uuid');
assert.match(sessionStorageKey(null), /^rugtown:session:v2:guest:/);

// clamp
assert.deepEqual(clampWorldPosition({ x: -10, y: 9999 }, 1000, 800), { x: 40, y: 760 });
assert.equal(clampWorldPosition(null, 1000, 800), null);

console.log('test-session-store: all passed');

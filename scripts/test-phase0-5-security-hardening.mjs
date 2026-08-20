/**
 * test-phase0-5-security-hardening.mjs — offline logic tests.
 * Run: node scripts/test-phase0-5-security-hardening.mjs
 *
 * IMPORTANT SCOPE NOTE: this suite can only exercise the PURE ARITHMETIC and
 * BOOLEAN-LOGIC portions of the Phase 0.5 migration (delta caps, rate-limit
 * windowing, and the corrected NULL-bypass condition shape) by mirroring
 * them in plain JS, exactly like test-phase15-1-hardening.mjs mirrors SQL
 * tier logic. It CANNOT exercise the actual REVOKE/GRANT execution
 * privileges, RLS policies, or auth.uid() semantics -- those only exist
 * inside a real Postgres engine and require a live (or local) Supabase
 * project. See the Phase 0.5 completion report for the manual live-Supabase
 * verification steps and the read-only SQL queries to run after applying
 * database/migrations/20260820_phase0_5_security_hardening.sql.
 */
import assert from 'node:assert/strict';

// ── Mirror: push_progression_snapshot delta caps (Section 4) ──
const MAX_XP_DELTA_PER_CALL = 5000;
const MAX_REP_DELTA_PER_CALL = 500;
const MAX_POINTS_DELTA_PER_CALL = 2000;
const MIN_SYNC_INTERVAL_MS = 5000;

function mergeCapped(serverValue, clientValue, maxDelta) {
  const wanted = Math.max(serverValue, clientValue);
  return Math.min(wanted, serverValue + maxDelta);
}

function rateLimited(lastUpdatedAtMs, nowMs) {
  if (lastUpdatedAtMs == null) return false;
  return nowMs - lastUpdatedAtMs < MIN_SYNC_INTERVAL_MS;
}

// A legitimate burst (multiple mission completions within the 10s client
// debounce window) must still get through uncapped.
{
  const serverXp = 10_000;
  const legitimateClientXp = 10_000 + 320; // e.g. all 10 starter missions in one sync
  const result = mergeCapped(serverXp, legitimateClientXp, MAX_XP_DELTA_PER_CALL);
  assert.equal(result, serverXp + 320, 'legitimate small XP gain must pass through uncapped');
}

// The exact exploit the migration closes: a single call trying to set XP to
// an arbitrary huge number must be clamped to the per-call ceiling, not
// accepted verbatim.
{
  const serverXp = 500;
  const maliciousClientXp = 999_999_999;
  const result = mergeCapped(serverXp, maliciousClientXp, MAX_XP_DELTA_PER_CALL);
  assert.equal(result, serverXp + MAX_XP_DELTA_PER_CALL, 'oversized XP claim must be capped, not accepted verbatim');
  assert.ok(result < maliciousClientXp, 'capped result must be far below the malicious claim');
}

// Same shape for REP and Points.
{
  assert.equal(mergeCapped(0, 999_999, MAX_REP_DELTA_PER_CALL), MAX_REP_DELTA_PER_CALL, 'REP delta must be capped');
  assert.equal(mergeCapped(0, 999_999, MAX_POINTS_DELTA_PER_CALL), MAX_POINTS_DELTA_PER_CALL, 'Points delta must be capped');
}

// The merge must never DECREASE a value even if the client reports less
// than the server already has (server-wins-on-the-low-side is unchanged
// behavior from before Phase 0.5 and must not regress).
{
  const serverXp = 50_000;
  const staleClientXp = 100; // e.g. a stale localStorage snapshot
  assert.equal(mergeCapped(serverXp, staleClientXp, MAX_XP_DELTA_PER_CALL), serverXp, 'server value must never decrease from a stale/low client report');
}

// Rate limiting: a call arriving faster than the minimum interval must be
// rejected; one arriving after it must be allowed.
{
  const now = 1_000_000;
  assert.equal(rateLimited(now - 2000, now), true, 'a call 2s after the last one must be rate-limited');
  assert.equal(rateLimited(now - 6000, now), false, 'a call 6s after the last one must be allowed');
  assert.equal(rateLimited(null, now), false, 'a player with no prior sync (new account) must not be rate-limited');
}

// ── Mirror: corrected NULL-bypass authorization shape (Section 5) ──
// Old (buggy) shape: `authUid != null && authUid !== target && !isOperator`
//   -> when authUid is null, condition is false, so authorization SILENTLY
//      PASSES (fail open). This is the bug the migration fixes.
// New (fixed) shape: reject null first, then check ownership/operator for
//   everyone else. Fails closed on null in all cases.
function oldBuggyAuthorized(authUid, target, isOperator) {
  // returns true if the call would be ALLOWED (i.e. no exception raised)
  const bypassSkipped = !(authUid !== null && authUid !== target && !isOperator);
  return bypassSkipped; // "allowed" whenever the guard condition is false
}
function fixedAuthorized(authUid, target, isOperator) {
  if (authUid === null) return false; // fixed: NULL always rejected
  if (authUid !== target && !isOperator) return false;
  return true;
}

{
  // The actual vulnerability: an unauthenticated/service context (auth.uid()
  // IS NULL) trying to act on an arbitrary OTHER player's data.
  const authUid = null;
  const targetPlayer = 'victim-player-id';
  const isOperator = false;

  assert.equal(
    oldBuggyAuthorized(authUid, targetPlayer, isOperator),
    true,
    'demonstrates the bug: old logic silently ALLOWS a null-auth caller to act on an arbitrary player'
  );
  assert.equal(
    fixedAuthorized(authUid, targetPlayer, isOperator),
    false,
    'fixed logic must REJECT a null-auth caller regardless of target'
  );
}

{
  // Legitimate self-call must still work under the fix.
  const authUid = 'player-a';
  assert.equal(fixedAuthorized(authUid, authUid, false), true, 'a player acting on their own data must still be allowed');
}

{
  // Legitimate operator-on-behalf-of-another-player call must still work.
  assert.equal(fixedAuthorized('operator-uid', 'other-player', true), true, 'an operator acting on another player must still be allowed');
}

{
  // A non-operator authenticated player acting on someone else must still
  // be rejected (unchanged from before Phase 0.5 -- this was never the bug).
  assert.equal(fixedAuthorized('player-a', 'player-b', false), false, 'a non-operator must still be rejected from acting on another player');
}

console.log('test-phase0-5-security-hardening: all assertions passed');
console.log('NOTE: REVOKE/GRANT execution privileges and RLS policies were NOT tested here -- see the Phase 0.5 report for required live-Supabase verification steps.');

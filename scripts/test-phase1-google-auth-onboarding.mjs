/**
 * test-phase1-google-auth-onboarding.mjs — offline logic tests.
 * Run: node scripts/test-phase1-google-auth-onboarding.mjs
 *
 * SCOPE NOTE: this suite mirrors the PURE DECISION LOGIC extracted directly
 * from the actual Phase 1 source (AuthCallbackPage.tsx, App.tsx's
 * handleNameSelect/pathToRoute, and the handle_new_user SQL trigger's
 * chose_username predicate), the same way the rest of this repo's offline
 * tests mirror SQL/React logic in plain JS (see test-phase15-1-hardening.mjs,
 * test-phase0-5-security-hardening.mjs). It intentionally does NOT attempt to
 * fake a Supabase client or simulate network/OAuth round-trips — that would
 * be testing a mock, not real behavior, which is exactly the "fake test"
 * anti-pattern the Phase 1 brief asked to avoid.
 *
 * What genuinely requires LIVE Supabase / a real browser and is NOT covered
 * here (see the Phase 1 report's manual verification matrix instead):
 *   - The actual OAuth redirect round-trip and PKCE code exchange
 *   - Whether handle_new_user's chose_username predicate compiles/runs
 *     correctly inside real Postgres against a real auth.users insert
 *   - Simultaneous username claim atomicity (this is fundamentally a
 *     database-level UNIQUE-constraint guarantee — see
 *     uq_profiles_username_normalized_col — that cannot be meaningfully
 *     exercised without two real concurrent connections to a real database)
 *   - RLS / grants on create_rugtown_profile, update_player_username,
 *     get_rugtown_profile_state
 */
import assert from 'node:assert/strict';

// ── Mirror: AuthCallbackPage's needsOnboarding decision ──
function needsOnboarding(profile) {
  return !profile || profile.onboardingCompleted !== true;
}

{
  // 1. New Google-authenticated user with no profile row yet (defensive case
  // -- in practice handle_new_user always creates one synchronously, but the
  // client must not assume that and skip onboarding on a lookup failure).
  assert.equal(needsOnboarding(null), true, 'missing profile must route to onboarding');
}
{
  // Fresh profile, trigger-created, onboarding_completed defaults false.
  assert.equal(needsOnboarding({ onboardingCompleted: false }), true, 'onboardingCompleted=false must route to onboarding');
}
{
  // 2. Existing authenticated user with a completed profile.
  assert.equal(needsOnboarding({ onboardingCompleted: true }), false, 'onboardingCompleted=true must skip onboarding');
}
{
  // Defensive: a malformed/partial server response must fail safe (treat as
  // needing onboarding) rather than silently letting an incomplete profile
  // into the game.
  assert.equal(needsOnboarding({}), true, 'missing onboardingCompleted field must fail safe to "needs onboarding"');
  assert.equal(needsOnboarding({ onboardingCompleted: undefined }), true, 'undefined onboardingCompleted must fail safe');
}

// ── Mirror: handle_new_user's chose_username predicate (SQL) ──
// chose_username := coalesce(nullif(trim(raw_username), ''), '') <> ''
function choseUsername(rawUsername) {
  const trimmed = (rawUsername ?? '').trim();
  return trimmed !== '';
}

{
  // Google OAuth identities never populate `username` in raw_user_meta_data.
  assert.equal(choseUsername(null), false, 'Google OAuth (no username field) must NOT mark onboarding complete');
  assert.equal(choseUsername(undefined), false, 'undefined username must NOT mark onboarding complete');
  assert.equal(choseUsername(''), false, 'empty-string username must NOT mark onboarding complete');
  assert.equal(choseUsername('   '), false, 'whitespace-only username must NOT mark onboarding complete');
}
{
  // This app's own email signup form always sends the typed username.
  assert.equal(choseUsername('RugKing'), true, 'a real chosen username from email signup must mark onboarding complete');
  assert.equal(choseUsername('  RugKing  '), true, 'a chosen username with surrounding whitespace must still count');
}

// ── Mirror: handleNameSelect's "only rename if changed" guard (App.tsx) ──
function shouldAttemptRename(userId, trimmedNewName, currentPlayerName) {
  return Boolean(userId && trimmedNewName && trimmedNewName !== currentPlayerName);
}

{
  // Returning player: OutfitSelectPage is pre-filled with their existing
  // username; clicking through unchanged must NOT fire a rename RPC.
  assert.equal(shouldAttemptRename('uid-1', 'RugKing', 'RugKing'), false, 'unchanged name must not trigger a rename call');
}
{
  // Player actually typed a new name.
  assert.equal(shouldAttemptRename('uid-1', 'NewName', 'RugKing'), true, 'a genuinely changed name must trigger a rename call');
}
{
  // Guest (no userId) must never attempt a server rename.
  assert.equal(shouldAttemptRename(null, 'AnyName', ''), false, 'a guest (no userId) must never attempt a server rename');
}
{
  // Empty submitted name must not attempt a rename (nothing to save).
  assert.equal(shouldAttemptRename('uid-1', '', 'RugKing'), false, 'an empty trimmed name must not trigger a rename call');
}

// ── Mirror: saveUsername's response-parsing (profile.ts) ──
// The RPC returns a normal 200 response with {ok:false, reason} for a
// cooldown/collision -- it does NOT raise a SQL exception for those. A
// caller that only checks the transport-level `error` misses this.
function parseSaveUsernameResponse(rpcError, data) {
  if (rpcError) return { ok: false, reason: rpcError.message };
  if (data && typeof data === 'object' && data.ok === false) {
    return { ok: false, reason: typeof data.reason === 'string' ? data.reason : 'Username rejected.' };
  }
  return { ok: true };
}

{
  // The exact bug this migration/fix closes: a 200 response with ok:false
  // (e.g. 14-day rename cooldown) must be surfaced, not treated as success.
  const result = parseSaveUsernameResponse(null, { ok: false, reason: 'cooldown' });
  assert.equal(result.ok, false, 'a 200 response with ok:false must be treated as a failure');
  assert.equal(result.reason, 'cooldown', 'the failure reason must be surfaced, not swallowed');
}
{
  const result = parseSaveUsernameResponse(null, { ok: false, reason: 'taken' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'taken');
}
{
  const result = parseSaveUsernameResponse(null, { ok: true, username: 'RugKing' });
  assert.equal(result.ok, true, 'a genuine success must be treated as success');
}
{
  const result = parseSaveUsernameResponse({ message: 'network error' }, null);
  assert.equal(result.ok, false, 'a transport-level error must still be treated as a failure');
}

// ── Mirror: pathToRoute (App.tsx) — route classification used by hydration ──
function pathToRoute(pathname) {
  if (pathname.startsWith('/auth/callback')) return '/auth/callback';
  if (pathname.startsWith('/onboarding/username')) return '/onboarding/username';
  if (pathname.startsWith('/auth')) return '/auth';
  if (pathname.startsWith('/character')) return '/character';
  if (pathname.startsWith('/play')) return '/play';
  return '/';
}

{
  assert.equal(pathToRoute('/auth/callback?code=abc123'), '/auth/callback');
  assert.equal(pathToRoute('/onboarding/username'), '/onboarding/username');
  assert.equal(pathToRoute('/auth'), '/auth');
  assert.equal(pathToRoute('/character'), '/character');
  assert.equal(pathToRoute('/play'), '/play');
  assert.equal(pathToRoute('/'), '/');
  assert.equal(pathToRoute('/wallet'), '/', 'no active route classification for /wallet -- it only exists as a redirect-to-/auth Route');
}

// ── Mirror: the onboarding-redirect condition inside finishHydration ──
// (next === 'authenticated' && !profileOnboardingComplete
//    && urlRoute !== '/onboarding/username' && urlRoute !== '/wallet')
function shouldRedirectToOnboarding(next, profileOnboardingComplete, urlRoute) {
  return next === 'authenticated' && !profileOnboardingComplete && urlRoute !== '/onboarding/username' && urlRoute !== '/wallet';
}

{
  // Refresh mid-onboarding: browser reload while sitting on the onboarding
  // page itself must NOT bounce the user away from it.
  assert.equal(shouldRedirectToOnboarding('authenticated', false, '/onboarding/username'), false, 'must not redirect away from the onboarding page itself');
}
{
  // Returning user deep-links to /play with an incomplete profile -- must be
  // caught and redirected to onboarding (this was Kiro's originally-reported
  // scenario, confirmed fixed in Phase 0's audit and re-verified here).
  assert.equal(shouldRedirectToOnboarding('authenticated', false, '/play'), true, 'an incomplete profile deep-linking to /play must redirect to onboarding');
}
{
  // Completed profile must never be redirected to onboarding regardless of route.
  assert.equal(shouldRedirectToOnboarding('authenticated', true, '/play'), false, 'a completed profile must never be sent to onboarding');
  assert.equal(shouldRedirectToOnboarding('authenticated', true, '/character'), false);
}
{
  // Guest hydration must never trigger an onboarding redirect.
  assert.equal(shouldRedirectToOnboarding('guest', false, '/play'), false, 'guest hydration must not trigger onboarding redirect');
}

console.log('test-phase1-google-auth-onboarding: all assertions passed');
console.log('NOTE: the OAuth round-trip itself, handle_new_user under a real auth.users insert, concurrent-username-claim atomicity, and RLS/grants were NOT tested here -- see the Phase 1 report for the required live-Supabase verification matrix.');

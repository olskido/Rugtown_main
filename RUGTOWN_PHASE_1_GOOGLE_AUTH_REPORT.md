# RugTown Phase 1 — Google Auth + Persistent User Identity Report

Scope: authentication + persistent username only. No progression, missions, leaderboards, building conversions, or wallet-code deletion were touched, per instruction.

---

## Phase 1 implemented

**Root cause found and fixed:** a new Google sign-in's first return from the OAuth redirect is a fresh SPA mount. At that instant `supabase.auth.getSession()` resolves with no session yet (the PKCE code hasn't been exchanged), so `App.tsx`'s one-shot post-hydration onboarding check fired immediately as `'guest'` and was never re-armed once the real session landed via `SIGNED_IN` — the `SIGNED_IN` listener never checked onboarding status at all, only whether an email/password sign-in was in flight. Net effect: new Google players skipped `/onboarding/username` entirely and silently played under the `handle_new_user` trigger's auto-generated username.

**Fix:** `AuthCallbackPage` — which runs after the OAuth (and email-confirmation-link) exchange actually succeeds — now makes its own fresh, direct `getRugtownProfileState()` call at that moment and decides the destination itself (`/onboarding/username` vs `/character`), instead of deferring to `App.tsx`'s separate, race-prone hydration pass. This sidesteps the race entirely rather than trying to re-time the existing guard.

**Second bug found and fixed:** `handle_new_user()` always defaulted every new profile's `onboarding_completed` to `false` (the column default), including for this app's own email/password signups — which already send a real chosen username in signup metadata. Only Google OAuth identities never populate a `username` field. The trigger now seeds `onboarding_completed = true` when a real username was already supplied at signup (email path) and `false` when it wasn't (Google path) — so Google users correctly still see onboarding, and email signups correctly don't see it a second time.

**Third bug found and fixed:** `/character`'s name field re-submitted a rename RPC call on every single login (even when unchanged, since the field is pre-filled with the current username), and `saveUsername()` only checked the RPC's transport-level error — `update_player_username` returns a normal `{ok:false, reason:'cooldown'}` response (not a thrown exception) for a rejected rename, which was silently swallowed. Fixed both: renames are now only attempted when the name actually changed, and the result is properly inspected.

**Minor hardening:** `create_rugtown_profile`'s INSERT is now wrapped to catch a genuine concurrent-claim race (two different users claiming the same normalized username at the same instant) and return the same clean `'username taken'` message the pre-check gives, instead of a raw Postgres constraint-violation string. The underlying atomicity guarantee (a real `UNIQUE INDEX` on the normalized username) was already correct and unchanged — this only improves the losing caller's error message.

## Files changed

- `src/App.tsx` — `handleAuthCallbackSuccess` now routes based on the callback's fresh onboarding check; `handleAuthContinue` now checks `onboardingCompleted` before routing (defense in depth for a signed-in user reaching `/auth` outside the OAuth flow); `handleNameSelect` only attempts a rename when the name changed, and reverts the locally-displayed name if the server rejects it.
- `src/components/AuthCallbackPage.tsx` — `onSuccess` now carries `{ needsOnboarding: boolean }`, computed from a direct `getRugtownProfileState()` call made right after the session is established.
- `src/lib/profile.ts` — `saveUsername()` now returns `{ ok, reason? }` instead of `void`, and inspects the RPC's own response body, not just transport errors.
- `package.json` — registered the two new test scripts (`test:phase0-5-security-hardening` was added in the prior phase's followup; `test:phase1-google-auth-onboarding` added here).

## Files created

- `database/migrations/20260820_phase1_google_auth_onboarding.sql`
- `scripts/test-phase1-google-auth-onboarding.mjs`
- This report.

## Database changes

One new migration, forward-only, additive/behavioral-fix only:

1. `handle_new_user()` — `CREATE OR REPLACE`, adds the `chose_username` seeding logic described above. Only affects `auth.users` rows created *after* this migration is applied (it's a trigger function, not a backfill) — no existing profile is touched, no data migrated.
2. `create_rugtown_profile()` — `CREATE OR REPLACE`, wraps the existing INSERT in an exception handler for the concurrent-claim case. Signature, grants (`REVOKE ALL FROM PUBLIC` + `GRANT authenticated`, unchanged from Phase 15), and all other logic are identical.

No new table, no new column, no dropped anything. **Not yet applied to any live Supabase project** — see "Manual Supabase configuration" below; this migration must be applied (after Phase 0.5's) before the fix is live.

## Authentication flow

Uses the existing Supabase client (`src/lib/supabase.ts`, unchanged — still the single client, PKCE flow, `detectSessionInUrl: false`, `persistSession: true`, `autoRefreshToken: true`) and the existing single `onAuthStateChange` listener in `App.tsx` (unchanged — no second listener added). `SIGNED_IN` and `SIGNED_OUT` are handled as before (email/password path untouched). `TOKEN_REFRESHED` requires no explicit handling: neither the player's identity nor onboarding status changes on a token refresh, and the Supabase client already updates its internal session transparently (auto-refresh was already correctly configured). An expired/revoked session is already handled correctly today: when Supabase's client fails to refresh a session, it emits `SIGNED_OUT`, which the existing handler already resets cleanly to guest state.

## New-user flow

1. Landing → "Enter RugTown" → `/auth` → "Continue with Google".
2. Google OAuth (Supabase-managed, PKCE) → full-page redirect back to `/auth/callback`.
3. `AuthCallbackPage` exchanges the code, then calls `getRugtownProfileState()` directly.
4. `handle_new_user` has already synchronously created a `profiles` row (Google never supplies a username, so `onboarding_completed = false`) — `needsOnboarding` evaluates `true`.
5. Routed to `/onboarding/username`. Username is validated client-side for instant feedback (`checkUsernameAvailable`) and claimed atomically server-side via `create_rugtown_profile`, which sets `onboarding_completed = true`.
6. `/character` → `/play`.

## Returning-user flow

Same steps 1–3. `getRugtownProfileState()` returns the existing profile with `onboardingCompleted: true` → `needsOnboarding` evaluates `false` → routed straight to `/character` (pre-filled with their persisted username and appearance, matching the existing UX pattern already used for every other sign-in path in this app) → `/play`. The username picker is never shown.

**Browser refresh mid-onboarding** and **deep-linking to `/play` with an incomplete profile** were already handled correctly by the existing `finishHydration` guard (verified in Phase 0 and re-verified with the new offline test) — those did not need a code change; only the OAuth-callback-specific race did.

**OAuth cancelled/failed:** `handleAuthCallback()` already checks for `error`/`error_description` query params before attempting any token exchange and returns a clean failure with no session ever established (unchanged, already correct) — `AuthCallbackPage` routes this to `onFailure`, which sends the user back to `/auth` with the error message shown. No `auth.users` row is ever created for a cancelled/failed attempt (that only happens after a successful exchange), so no partial identity can exist.

## Username persistence

Stored in `profiles.username` (+ `username_normalized` for case-insensitive lookups), set once via `create_rugtown_profile` during onboarding and never re-prompted afterward. Verified this is real, server-side, cross-session persistence (not localStorage) by tracing the actual read path: `getRugtownProfileState()` → `get_rugtown_profile_state` RPC → reads `profiles.username` directly from the database on every login.

## Username security

- Server-side validation: length 3–16, `^[a-z0-9_]+$` after normalization, reserved-word check — all inside `create_rugtown_profile`, not just the client.
- Case-insensitive uniqueness: enforced by a real `UNIQUE INDEX` on the normalized username (two separate indexes exist — `uq_profiles_username_normalized` on `lower(trim(username))` and `uq_profiles_username_normalized_col` on the `username_normalized` column — both predate this phase and were verified, not assumed).
- Atomic concurrent claims: guaranteed by that same unique index, not by the application-level pre-check (which has an inherent race window on its own — this phase's migration wraps the INSERT so the loser of a genuine race gets a clean message instead of a raw constraint-violation string, but the atomicity itself was already real).
- Client-side `checkUsernameAvailable` is preview-only, as required — the actual claim always goes through the server-authoritative RPC.
- Identity is `auth.uid()` throughout — no code path uses email, wallet address, username, or a client-generated ID as the player's identity key.

## Wallet code removed from active path

**Nothing needed to be removed** — verified, not assumed. The active auth path (`App.tsx`, `AuthPage.tsx`, `AuthCallbackPage.tsx`, `UsernameOnboardingPage.tsx`) has zero imports of any wallet-related file, confirmed by grepping every one of them for `Wallet`/`Phantom`/`Solflare`/`Backpack`/`signInWithWeb3`. `/wallet` already redirects to `/auth`. `AuthPage.tsx` shows only "Continue with Google" and email/password — no "Connect Wallet" / Phantom / Solflare / Backpack ever appears in the signup UI. This was already true before Phase 1 (prior work had already achieved it); Phase 1 did not need to change any of this.

## Deferred Solana code preserved

Full classification, from a direct import trace (not the Phase 0 report's memory of it):

| File | Classification | Evidence |
|---|---|---|
| `src/components/WalletAuthPage.tsx` | **DEFERRED** | Imported by nothing outside itself. `/wallet` route only renders a redirect, never this component. |
| `src/lib/wallet/SolanaWalletAuth.ts` (`signInWithWeb3` wrapper) | **DEFERRED** | Only consumer is `WalletAuthPage.tsx`. |
| `src/lib/wallet/SolanaWalletProviders.ts` | **SPLIT** | `discoverSolanaWallets()`/`connectWalletProvider()` are DEFERRED (only used by `WalletAuthPage.tsx`); `shortenWalletAddress()` is **ACTIVE** — used by `RugTownVaultPanel.tsx` and `GamePage.tsx` for display formatting in the in-game Vault panel (not auth). |
| `src/components/vault/RugTownVaultPanel.tsx`, `src/components/rewards/WalletVerificationSection.tsx` (new since Phase 0 — found this pass) | **ACTIVE, but in-game economy, not auth** | Reachable via `GamePage.tsx`/`RewardCentrePanel.tsx`, shows holder tier / token-claim UI. Not part of the authentication path. This is the same Solana-vault-still-live-in-game finding from the Phase 0 report (§5/§22) — unchanged by Phase 1, which was scoped to auth only. |
| The 8 Solana Edge Functions (`claim-rugtown-reward`, etc.) | **DEFERRED, unchanged** | Not touched this phase. |

Nothing was deleted. No Solana file was modified.

## Tests

**LOCAL (performed):**
- `npx tsc --noEmit` — 0 errors.
- `npm run build` — clean.
- All 6 pre-existing offline tests — pass, no regressions.
- `scripts/test-phase1-google-auth-onboarding.mjs` (**new**) — pass. Covers, by mirroring the actual extracted decision logic (not a mock of Supabase):
  1. new Google-authenticated user with no profile → needs onboarding
  2. existing authenticated user with completed profile → skips onboarding
  3. malformed/partial server response → fails safe to "needs onboarding"
  4. `handle_new_user`'s chose-username predicate: Google (no username) → false; email signup (real username) → true
  5. rename-guard: unchanged name → no RPC call; changed name → RPC call attempted
  6. `saveUsername` response parsing: a 200 response with `ok:false` (cooldown/taken) is correctly treated as a failure, not silently swallowed
  7. route classification (`pathToRoute`) for every canonical route including `/wallet`
  8. the onboarding-redirect guard: does not bounce a user off the onboarding page itself; does redirect an incomplete profile deep-linking to `/play`; never redirects a completed profile; never fires during guest hydration

**NOT covered locally (genuinely requires live Supabase or a real browser — see the manual verification matrix below):** the actual OAuth redirect round-trip, `handle_new_user` executing against a real `auth.users` insert, simultaneous-username-claim atomicity under real concurrent connections, and RLS/grants on the three RPCs involved.

## TypeScript

Clean. `npx tsc --noEmit` exits 0.

## Build

Clean. `npm run build` succeeds; only the same pre-existing, unrelated chunk-size warnings (phaser + main bundle) as every prior phase.

## Manual Supabase configuration

None of the following were or could be performed by this session.

| # | Where | What | Value / setting | How to verify |
|---|---|---|---|---|
| 1 | Supabase Dashboard → Authentication → Providers → Google | Enable the Google provider | Client ID + Client Secret from Google Cloud Console | Toggle shows "Enabled"; a test sign-in from `/auth` reaches Google's consent screen instead of erroring |
| 2 | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client | Create/confirm the OAuth client and its authorized redirect URI | `https://<your-project-ref>.supabase.co/auth/v1/callback` | Google's consent screen loads without a `redirect_uri_mismatch` error |
| 3 | Supabase Dashboard → Authentication → URL Configuration | Site URL | Your production origin (e.g. `https://your-production-domain`) | — |
| 4 | Supabase Dashboard → Authentication → URL Configuration → Redirect URLs | Allow-list both | `http://localhost:3000/auth/callback` (dev) and `https://your-production-domain/auth/callback` (prod) — the app always builds this from `window.location.origin`, never hardcoded | Completing Google sign-in redirects back into the app instead of Supabase rejecting the redirect |
| 5 | Google Cloud Console → OAuth consent screen | Take the app out of "Testing" mode, or add real testers | — | A Google account NOT on the test-user allow-list can complete sign-in |
| 6 | Environment variables (already required, unchanged by Phase 1) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Set for both Production and Preview if deploying on Vercel | `npm run build` + a deployed preview loads without a "Supabase not configured" state |
| 7 | Supabase SQL Editor | Apply `database/migrations/20260820_phase1_google_auth_onboarding.sql` (after confirming `20260820_phase0_5_security_hardening.sql` is applied) | — | Run this session's live-verification queries below |
| — | — | Verify: sign in with a **brand-new** Google account → should land on `/onboarding/username`, never `/character` directly | — | This is the single most important manual check for this phase |
| — | — | Verify: sign in again with that **same** Google account → should land directly on `/character` with the chosen username pre-filled, no onboarding screen | — | — |
| — | — | Verify: sign up via **email/password** with a chosen username, confirm the email, click the confirmation link → should land on `/character` (NOT `/onboarding/username` — this is the case the `handle_new_user` fix specifically protects) | — | — |
| — | — | Verify: cancel the Google consent screen mid-flow → should land back on `/auth` with a visible error, and no new row in `auth.users`/`profiles` | Supabase Dashboard → Authentication → Users, confirm no new user was created | — |

## Remaining blockers

- **This migration and the Phase 0.5 migration are both unapplied to any live Supabase project** — the fix is correct in the repository but inert until both are run in the SQL Editor, in that order.
- **Live end-to-end verification has not been performed** (no Supabase credentials with schema/auth access available in this environment) — the manual matrix above must be run by a human against a real project before this is considered production-verified.
- **Existing pre-Phase-1 accounts**: no migration risk was found — the Phase 15 backfill already grandfathered every pre-Phase-15 profile to `onboarding_completed = true`, and this phase's trigger change only affects rows created after it's applied. No REP/XP/level/Points/missions/achievements were touched by anything in this phase.
- **The in-game Solana Vault surface** (`RugTownVaultPanel.tsx`/`WalletVerificationSection.tsx`) remains live and reachable in-game, per the Phase 0 report's flagged product decision — Phase 1 was scoped to auth/login only and intentionally did not touch it; it's still an open decision for whoever owns the "no blockchain in current launch" call.

Stopping here per instruction — not proceeding to Phase 2 (100-level progression, Points, leaderboards, missions, hidden quests, building conversions, weekly rewards).

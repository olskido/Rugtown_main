# RugTown Phase 0.5 — Security Hardening Report

**Scope:** database/RPC security hardening only, per the approved Phase 0.5 instruction. No auth flow, progression design, missions, leaderboards, Phaser world, or frontend changes were made. The deferred Solana architecture was not deleted — only its privileged internal functions were locked down.

**Method:** every function this migration touches was read in full from the actual migration files before being changed, and every legitimate caller (client `src/`, Edge Functions under `supabase/functions/`, and other RPCs) was traced with `grep` before its authorization was altered. One correction to the original takeover report came out of this process — see "rt_finalize_reward_epoch status" and "rt_resolve_auth_wallet status" below.

---

## Security fixes implemented

1. **`rt_finalize_reward_epoch`** — added an internal `rt_is_service_role()` guard (defense-in-depth; see status note below on why this was already unreachable by clients).
2. **`rt_resolve_auth_wallet`** — added a self-or-service-role guard (`p_user_id = auth.uid() OR rt_is_service_role()`), matching every real call site.
3. **`rt_grant_title`** — `REVOKE ALL FROM PUBLIC` (previously had no revoke at all; genuinely open).
4. **`push_progression_snapshot`** — added a per-call delta cap (5000 XP / 500 REP / 2000 Points) and a 5-second minimum interval between accepted syncs, closing the "set my stats to 999999999 in one call" exploit while preserving legitimate accumulated-gain syncing.
5. **Five NULL-bypass authorization bugs fixed** (see dedicated section below).
6. **Three maintenance/batch RPCs gated** to `rt_is_service_role() OR rt_is_operator('operator')`: `process_achievement_evaluation_queue`, `generate_economy_daily_snapshot`, `run_progression_maintenance` — all three were previously `GRANT ... TO authenticated` with no internal role check at all.
7. **Twelve ungated internal helper functions** locked down with `REVOKE ALL FROM PUBLIC`: `rt_analytics_event`, `rt_prog_history`, `rt_rule_value`, `rt_seed_achievement`, `rt_raise_alert`, `rt_social_restricted`, `rt_social_audit`, `rt_social_analytics`, `rt_check_rate_limit`, `rt_ensure_profile_settings`, `rt_is_blocked`, `rt_are_friends`.
8. **`migrate_local_progression`** — fixed to route through the current `rt_recompute_level(xp, 4)` dispatcher instead of a hardcoded `rt_recompute_level_v2` call (a live curve-version-drift bug, not a security hole, but corrected in the same pass since it touches the same reward-integrity surface).
9. **Table-level RLS hardening**: `profiles.holder_tier`, `profiles.social_restricted_until`, and `profiles.username_changed_at` added to the existing `profiles_protect_reward_columns` trigger's protected-column list; the three legitimate writers of the latter two (`update_player_username`, `apply_moderation_action`, `run_social_maintenance`) were updated to call `rt_set_mutation_flag()` first so they keep working. `player_daily_streaks`'s dangling owner-UPDATE RLS policy was dropped (verified zero writers anywhere in the codebase — dead policy on an otherwise-unused table).

## RPCs modified

`rt_finalize_reward_epoch`, `rt_resolve_auth_wallet`, `push_progression_snapshot`, `enqueue_achievement_evaluation`, `evaluate_player_achievements`, `evaluate_season_pass_progress`, `grant_season_pass_points`, `evaluate_party_shared_mission`, `process_achievement_evaluation_queue`, `generate_economy_daily_snapshot`, `run_progression_maintenance`, `migrate_local_progression`, `profiles_protect_reward_columns` (trigger function), `update_player_username`, `apply_moderation_action`, `run_social_maintenance` — 16 functions, all via `CREATE OR REPLACE` with bodies otherwise unchanged except the specific security addition described per-function in the migration's comments.

## RPCs whose execution privileges changed

`rt_grant_title`, `rt_analytics_event`, `rt_prog_history`, `rt_rule_value`, `rt_seed_achievement`, `rt_raise_alert`, `rt_social_restricted`, `rt_social_audit`, `rt_social_analytics`, `rt_check_rate_limit`, `rt_ensure_profile_settings`, `rt_is_blocked`, `rt_are_friends` — all newly `REVOKE ALL FROM PUBLIC` (13 functions). `rt_finalize_reward_epoch` and `rt_resolve_auth_wallet` had their existing `REVOKE ALL FROM PUBLIC` idempotently re-stated (no actual change — see status notes). `process_achievement_evaluation_queue`, `generate_economy_daily_snapshot`, `run_progression_maintenance` keep their existing `GRANT ... TO authenticated` (needed for the legitimate `RewardOperationsPanel.tsx` human-operator path) but gained an internal role check.

## RPCs intentionally left unchanged

Every RPC not listed above and not flagged in report §17 — this includes all correctly-gated reward/mission/party/guild/tournament RPCs (`award_gameplay_reward`, `claim_mission_reward`, `complete_chapter_mission`, `claim_guild_contract`, the entire party/guild/tournament families, etc.), which were already `SECURITY DEFINER` + `SET search_path` + a correct `auth.uid()` check + idempotency, per the exhaustive §17 sweep. No speculative changes were made to anything the audit did not identify as vulnerable, per instruction.

## NULL authorization issues fixed

All five used the buggy shape `IF auth.uid() IS NOT NULL AND auth.uid() <> target AND NOT operator THEN RAISE EXCEPTION` — silently skipping the check when `auth.uid()` is NULL instead of rejecting:

1. `enqueue_achievement_evaluation` — fixed to reject NULL explicitly.
2. `evaluate_player_achievements` — fixed (this one mints real XP/REP/title rewards, the highest-impact of the five).
3. `grant_season_pass_points` — fixed.
4. `evaluate_party_shared_mission` — fixed (slightly different shape: party-membership check rather than self-or-operator, same NULL-skip bug).
5. `evaluate_season_pass_progress` — this one had **no ownership/operator check at all**, not just a NULL-bypass; a full check was added (any authenticated user could previously force recomputation/notification-spam against any other player's season pass).

All five remain `GRANT ... TO authenticated` (unchanged) — the fix is to the internal logic, not the grant, since `authenticated`-scoped PostgREST calls never actually have a NULL `auth.uid()` today. The fix closes the gap for any future context where that could change (a service-role or anon grant, or an Edge Function calling these directly).

## SECURITY DEFINER issues fixed

No `SET search_path` issues were found anywhere in the 214-function sweep (confirmed clean in the original audit and not touched here). The SECURITY DEFINER issues fixed in this phase are exclusively the missing-authorization-check and missing-REVOKE issues listed above — every function modified retains its existing `SET search_path = public` unchanged, and no function had its DEFINER/INVOKER mode changed.

## Progression snapshot trust issue

**Closed, with an explicitly documented scope limit.** `push_progression_snapshot` no longer accepts an unbounded client-declared value for XP, REP, or Points — each field's per-call increase is now capped (5000 XP / 500 REP / 2000 Points), and a 5-second minimum-interval check (using `player_progression.updated_at` as the anchor, no new table needed) bounds how fast an attacker could stack even capped calls. This is the **minimum safe change** as instructed, not a redesign: a full receipt-correlated/event-sourced verification (checking each claimed gain against an actual server-recorded gameplay event) is out of scope for Phase 0.5 and is explicitly called out in the migration's comments and in the takeover report's §26 as Phase 1/3 progression work.

## rt_finalize_reward_epoch status

**Correction to the original takeover report.** Direct inspection during this phase found that `rt_finalize_reward_epoch(uuid)` already has `REVOKE ALL ... FROM PUBLIC` in `20260813_phase15_prelaunch_wallet_guild_vault.sql:1387`, explicitly commented "Internal helpers: no client execute." `CREATE OR REPLACE FUNCTION` does not reset privileges in PostgreSQL, and `phase15_1_production_hardening.sql`'s later redefinition of this function does not add any new grant — so as written in the repository, assuming both Phase 15 files get applied (in either order — see the ordering analysis below), **this function is not actually callable by `anon` or `authenticated` today.** The original audit's characterization of it as "the most severe finding — anyone can call it" does not hold once the grants block at the bottom of the file is accounted for; the earlier sub-agent sweep appears to have missed that block (it's ~1,300 lines into a large file, separate from the `CREATE OR REPLACE` it's easy to grep past). This migration still adds an internal `rt_is_service_role()` check as defense-in-depth, since relying purely on an easily-overlooked `REVOKE` statement in a different file is fragile — this codebase has already demonstrated a "blanket grant" mistake once (Phase 13C's `GRANT ALL ON ALL TABLES`), so self-protecting the function body is worth the two lines it costs.

## rt_grant_title status

**Confirmed genuinely exploitable, now closed.** Unlike the two functions above, `rt_grant_title(uuid, text, text, text)` has **no** `REVOKE` statement anywhere in any of the 16 migration files — verified by grep. New PostgreSQL functions default to `PUBLIC EXECUTE`, and `anon`/`authenticated` have schema `USAGE` (granted in Phase 13C), so this was directly callable via `supabase.rpc('rt_grant_title', {...})` from any browser session, letting any player grant themselves (or anyone) any active title in the catalog for free. Fixed with `REVOKE ALL FROM PUBLIC` — all three legitimate callers (`evaluate_player_achievements`, `claim_season_pass_reward`, `operator_grant_title`) are themselves `SECURITY DEFINER` functions that already validate eligibility before calling it, and a `SECURITY DEFINER` function's internal calls run with the function owner's privileges regardless of the original caller's grants — so this fix has zero functional impact on any legitimate flow.

## rt_resolve_auth_wallet status

Same correction as `rt_finalize_reward_epoch`: already `REVOKE ALL FROM PUBLIC` in `phase15_prelaunch_wallet_guild_vault.sql:1388`, not actually callable by any client today. All three real call sites (`create_rugtown_profile`, and `refresh_holder_status` in both its versions) call it as `rt_resolve_auth_wallet(uid)` where `uid := auth.uid()` — always resolving the caller's own wallet, never an arbitrary one. Hardened with an explicit `p_user_id = auth.uid() OR rt_is_service_role()` check as defense-in-depth, matching every existing call site exactly (no functional change for any of them).

## Phase 15 / 15.1 migration-order analysis

Read both files' `REVOKE`/`GRANT` blocks directly. Findings:

- `phase15_1_production_hardening.sql`'s header states it must apply **after** `phase15_prelaunch_wallet_guild_vault.sql`, despite sorting first alphabetically.
- `phase15_prelaunch...sql`'s grants block (lines 1342-1388) is where `rt_finalize_reward_epoch` and `rt_resolve_auth_wallet` get their `REVOKE ALL FROM PUBLIC`.
- `phase15_1...sql` redefines both functions (`CREATE OR REPLACE`) but adds **no** new grant/revoke statement for either — confirmed by grepping every `REVOKE`/`GRANT` line in that file (only `apply_verified_holder_status`, `run_reward_epoch_maintenance`, `begin_epoch_reward_claim`, `complete_epoch_reward_claim`, `fail_epoch_reward_claim`, `store_epoch_reward_signature` appear).
- Because `CREATE OR REPLACE FUNCTION` preserves existing privileges in PostgreSQL, **the apply order between these two files does not matter for this specific risk** — whichever runs first creates the function (inheriting Postgres's default `PUBLIC EXECUTE`), and `phase15_prelaunch`'s unconditional `REVOKE ALL FROM PUBLIC` removes that access regardless of which file ran first, as long as both eventually get applied.
- **What does still matter**: if `phase15_1` is ever applied to a database where `phase15_prelaunch` was **never** applied at all (not just applied in the "wrong" order, but genuinely skipped), `phase15_1`'s `CREATE OR REPLACE FUNCTION rt_finalize_reward_epoch(...)` would `CREATE` it fresh with default `PUBLIC EXECUTE` and no `REVOKE` would ever follow, since `phase15_1` never states one. This migration's idempotent `REVOKE ALL FROM PUBLIC` re-statement in Section 1 closes exactly this scenario.
- This migration (Phase 0.5) is safe to apply regardless of what order the two Phase 15 files were applied in, or whether both were applied at all — every `REVOKE`/`GRANT`/`CREATE OR REPLACE` in it is self-contained and idempotent.

## refresh_holder_status analysis

- **Version A** (`phase15_prelaunch_wallet_guild_vault.sql:1101`): trusts the client-supplied `p_balance_base_units` parameter directly and writes it into `holder_status.token_balance_base_units`/`holder_tier`/`rp_multiplier` (only clamps negative values to 0). Its own comment admits: `"DEV ONLY: trusts client-reported balance"`. **Genuinely exploitable if this is the live version** — any player could self-assign the top "whale" reward-multiplier tier.
- **Version B** (`phase15_1_production_hardening.sql:120`, applies after Version A per the documented order): completely ignores the `p_balance_base_units` parameter and only returns the already-cached `holder_status` row, with a message pointing callers to the real `refresh-holder-status` Edge Function (which does actual on-chain verification server-side). **Safe.**
- Because `CREATE OR REPLACE` preserves grants but **does replace the function body**, Version B is what's live **as long as `phase15_1` is applied after `phase15_prelaunch`**, per the documented order. This migration does not touch `refresh_holder_status` further — Version B is already correct — but flags this as the one place in the two Phase 15 files where apply order **does** materially matter (unlike the `rt_finalize_reward_epoch`/`rt_resolve_auth_wallet` grants question above). See "Manual Supabase steps" below for how to verify which version is actually live.

## New migration filename

`database/migrations/20260820_phase0_5_security_hardening.sql`

## Tests run

**LOCAL VALIDATION (performed):**
- `npx tsc --noEmit` — 0 errors (unaffected by this phase; no TypeScript was changed).
- `npm run build` — succeeds, output unchanged from before this phase (same bundle hashes; only a new `.sql` file and a new offline `.mjs` test were added).
- `node scripts/test-session-store.mjs` — pass.
- `node scripts/test-phase15-1-hardening.mjs` — pass.
- `node scripts/test-prelaunch-wallet-guild.mjs` — pass.
- `node scripts/test-staging-supabase-rls.mjs` — gracefully skipped (no `STAGING_*` credentials — by design).
- `npx tsx scripts/test-gameplay-completion.ts` — pass.
- `node scripts/test-phase0-5-security-hardening.mjs` (**new**) — pass. Mirrors the delta-cap arithmetic, rate-limit windowing, and the corrected NULL-bypass boolean logic in plain JS, the same way `test-phase15-1-hardening.mjs` mirrors SQL tier logic offline.

**LIVE SUPABASE VALIDATION: NOT performed.** No Supabase credentials with schema-modification rights are available in this environment, and Phase 0 rules forbid touching Supabase without explicit instruction. The offline test above can only exercise pure arithmetic/boolean logic extracted from the SQL — it **cannot** verify that the actual `REVOKE`/`GRANT` statements take effect, that RLS policies behave as written, or that `auth.uid()`/`rt_is_service_role()` resolve correctly inside a real Postgres engine. That requires applying this migration to a real (ideally staging, not production) Supabase project and running the verification queries in the migration's own Section 10, plus the manual test matrix below.

## Build result

Clean. `npm run build` succeeds with only pre-existing, unrelated chunk-size warnings (phaser + main bundle >500kB, unrelated to this phase).

## TypeScript result

Clean. `npx tsc --noEmit` exits 0. This phase made no TypeScript changes at all — it is a pure SQL migration.

## Remaining security findings

Everything identified in the original takeover report's §17 has been addressed **except**:

- **The full receipt-correlated anti-cheat redesign for `push_progression_snapshot`** — explicitly deferred to Phase 1/3 per instruction; only the minimum-safe delta cap was applied here.
- **`player_badges`, `player_inventory`, `district_unlocks`'s legacy `FOR ALL` owner policies** (report §16) — these predate the Phase 10G+ RPC-gated architecture and let a player self-grant badges/inventory/district-unlocks by direct table write. Not touched in this phase because the report could not confirm whether anything still reads/depends on client-writability here, and the Phase 0.5 brief scoped this phase to the §17 RPC inventory specifically. Flagged for the Phase 11 anti-abuse pass already recommended in the takeover report.
- **Live verification that the Phase 15 files were actually applied to the production Supabase project, and in what state** — cannot be determined from static analysis; see manual steps below.

No new vulnerabilities were introduced by this migration — every change was either a privilege reduction, a fail-closed logic correction, or a bounded-delta rewrite of an already-open trust gap.

## Manual Supabase steps

| Where | What | Why | How to verify |
|---|---|---|---|
| Supabase SQL Editor | Apply `database/migrations/20260820_phase0_5_security_hardening.sql` (after confirming Phase 16 is applied — this migration assumes it) | Activates every fix in this report | Run the verification queries in the migration's own Section 10 |
| Supabase SQL Editor | Run: `SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_ok FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('rt_finalize_reward_epoch','rt_resolve_auth_wallet','rt_grant_title','rt_analytics_event','rt_prog_history','rt_rule_value','rt_seed_achievement','rt_raise_alert','rt_social_restricted','rt_social_audit','rt_social_analytics','rt_check_rate_limit','rt_ensure_profile_settings','rt_is_blocked','rt_are_friends');` | Confirms the 15 hardened internal helpers are truly unreachable by anon/authenticated | Every row should show `anon_ok = false` and `auth_ok = false` |
| Supabase SQL Editor | Inspect the live body of `refresh_holder_status`: `SELECT prosrc FROM pg_proc WHERE proname='refresh_holder_status';` | Determines whether the safe (Phase 15.1) or vulnerable (Phase 15 prelaunch) version is actually live, per the analysis above | The body should ignore `p_balance_base_units` and only return the cached row — if it instead writes the parameter into `holder_status`, the vulnerable version is live and needs immediate re-application of Phase 15.1 |
| Supabase SQL Editor | As an authenticated non-service test account, attempt `UPDATE profiles SET holder_tier = 'Gold' WHERE id = auth.uid();` then `SELECT holder_tier FROM profiles WHERE id = auth.uid();` | Confirms the extended `profiles_protect_reward_columns` trigger actually blocks the direct-write path | `holder_tier` should be unchanged after the UPDATE |
| Supabase SQL Editor | As a test account, call `push_progression_snapshot` twice within 5 seconds with a large `p_lifetime_xp` | Confirms the rate limit and delta cap are both active | Second call should return `{"ok": false, "reason": "rate_limited"}`; a single call with an oversized value should only advance `lifetime_xp` by at most 5000 |
| Supabase SQL Editor or dashboard function inspector | Confirm `process_achievement_evaluation_queue` and `run_progression_maintenance` still work when invoked via the `process-achievement-queue` Edge Function (service-role) and via `RewardOperationsPanel.tsx` (a human operator account) | These are the two legitimate callers this migration must not break | Both should still succeed; a non-operator authenticated test account calling either directly should now get `forbidden: operator or service role required` |
| — | None of the above require any Google OAuth / dashboard provider configuration — this phase is database-only | — | — |

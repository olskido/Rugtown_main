# RugTown — Manual Deployment Checklist (Phase 0.5 → Phase 2)

Consolidated checklist covering everything that requires a human/ops action outside of the code itself, across Phase 0.5, Phase 1, and Phase 2. Individual phase reports (`RUGTOWN_PHASE_0_5_SECURITY_HARDENING_REPORT.md`, `RUGTOWN_PHASE_1_GOOGLE_AUTH_REPORT.md`, `RUGTOWN_MASTER_IMPLEMENTATION_REPORT.md`, `RUGTOWN_FINAL_IMPLEMENTATION_REPORT.md`) contain the reasoning behind each step; this file is the do-this-in-order reference.

**Phase 0.5 and Phase 1 are already applied to the real Supabase project — do not run them again.** Phase 2 failed on its first attempt and has been fixed in place. See §0 before doing anything else.

---

## 0. Phase 2 status — READ THIS FIRST

Your Phase 2 apply attempt failed with:

```
ERROR: 42P13: return type mismatch in function declared to return record
DETAIL: Final statement returns text instead of integer at column 1
CONTEXT: SQL function "rt_hidden_quest_reward"
```

**Root cause (confirmed by reading the function, not guessed):** `rt_hidden_quest_reward` is declared `RETURNS TABLE (xp_reward integer, rep_reward integer, points_reward integer)` — 3 columns. Its body selected from a `VALUES (...) AS t(quest_id, xp_reward, rep_reward, points_reward)` table — 4 columns, because `quest_id` was needed to filter by the input parameter — but used `SELECT *`, which returned all 4 columns. `quest_id` (text) landed in output position 1, where the declared signature expects `xp_reward` (integer). This is a bug in the **SELECT list**, not the return-type declaration: the declared 3-column signature is correct and matches every caller (`complete_hidden_quest` reads `.xp_reward`/`.rep_reward`/`.points_reward`; the TypeScript client in `src/lib/hiddenQuests.ts` reads the same 3 fields and nothing else). The fix changes `SELECT *` to `SELECT t.xp_reward, t.rep_reward, t.points_reward`, dropping `quest_id` from the output.

**Partial-application check:** `20260820_phase2_progression_leaderboards_quests.sql` has no `BEGIN`/`COMMIT` wrapper, so everything textually *before* the failing `CREATE FUNCTION rt_hidden_quest_reward` statement (line ~508) almost certainly committed already: the `mission_definitions` category column/seed rows, `ensure_period_missions`, `claim_daily_completion_bonus`, `record_daily_participation`, `get_my_streak`, the `player_activity_heartbeats` table, and `record_activity_heartbeat`. Everything from `rt_hidden_quest_reward` onward (`discover_hidden_quest`, `complete_hidden_quest`, `get_my_hidden_quests`, the leaderboard functions, `leaderboard_period_snapshots`, `settle_weekly_leaderboard`, `get_weekly_champions`) did **not** get created.

**This is safe.** The file was already written defensively for exactly this situation: every `CREATE TABLE` uses `IF NOT EXISTS`, every `CREATE FUNCTION` uses `OR REPLACE`, every `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS`, every `CREATE INDEX` uses `IF NOT EXISTS`, and the top-of-file `ALTER TABLE`/`UPDATE`/`INSERT` block is guarded (`ADD COLUMN IF NOT EXISTS`, `WHERE category IS NULL`, `ON CONFLICT ... DO UPDATE`, a `DO $$ ... EXCEPTION WHEN duplicate_object$$` around the CHECK constraint). Re-running the whole file top-to-bottom is a safe no-op for everything already committed and creates everything that didn't.

### A. What to run

**Run the corrected `20260820_phase2_progression_leaderboards_quests.sql` — the whole file, top to bottom, exactly once.** There is no separate repair migration and none is needed; the bug is fixed in place in the same file, and the file's own idempotency handles the partial-application state described above.

```
RUN THIS (and only this):
  20260820_phase2_progression_leaderboards_quests.sql   (now fixed — apply in full)
```

Do not paste only the `rt_hidden_quest_reward` snippet by itself — run the complete file so Postgres re-validates every statement in order (all the earlier ones are safe re-runs, as explained above).

### B. Verify the fix landed

```sql
select xp_reward, rep_reward, points_reward from rt_hidden_quest_reward('hq_empty_chair');
-- expect exactly one row: xp_reward=120, rep_reward=25, points_reward=100 (3 integer columns, no quest_id)
```

Then run all of §5's verification queries — they exercise `discover_hidden_quest`/`complete_hidden_quest`, which call this function internally.

---

## 1. Migration apply order

Apply against a **staging** Supabase project first, verify §5's queries, then apply to production.

```
-- Pre-existing chain (already applied in earlier phases, listed for completeness):
20260716_phase10g_rewards.sql
20260716_phase10h_reward_operations.sql
20260716_phase10i_achievements_season_pass_analytics.sql
20260716_phase10j_social_identity_moderation.sql
20260716_phase10k_parties_shared_missions_matchmaking.sql
20260716_phase10l_characters_events_tournaments_guilds.sql
20260717_phase10mnpqs_living_world_security.sql
20260717_phase11_bitmap_character_appearances.sql
20260720_phase12_outfit_layer.sql
20260722_phase13_chapter_one_missions_progression.sql
20260722_phase13b_mission_reward_fix.sql
20260723_phase13c_post_bootstrap_grants_and_party_rls.sql
20260730_phase14_gameplay_completion.sql
20260813_phase15_1_production_hardening.sql
20260813_phase15_prelaunch_wallet_guild_vault.sql
20260817_phase16_100level_progression.sql

-- ALREADY APPLIED — DO NOT RUN AGAIN:
20260820_phase0_5_security_hardening.sql
20260820_phase1_google_auth_onboarding.sql

-- REMAINING — run this one (now fixed, see §0):
20260820_phase2_progression_leaderboards_quests.sql
```

Each file is written against the schema state left by the one before it — do not skip or reorder. There is no `20260820_phase2_1_repair.sql` or similar — the fix lives inside the Phase 2 file itself.

---

## 2. Supabase Dashboard configuration

- **Google OAuth provider**: enabled under Authentication → Providers, with the Google Cloud OAuth client ID/secret configured, and `https://<your-project>.supabase.co/auth/v1/callback` registered as an authorized redirect URI in the Google Cloud Console. (Documented in full in `RUGTOWN_PHASE_1_GOOGLE_AUTH_REPORT.md`.)
- **Site URL / Redirect URLs**: confirm the app's production domain is in the allow-list for OAuth redirects (Authentication → URL Configuration).
- **RLS**: confirm RLS is enabled (not just policies present) on every table touched by Phase 0.5/1/2 — the migrations enable it, but it's worth a dashboard spot-check on a fresh environment.

---

## 3. Environment variables

No new environment variables were introduced in Phase 0.5, Phase 1, or Phase 2. Existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are unchanged in shape and requirement.

---

## 4. Edge Functions / Cron jobs

- **`settle_weekly_leaderboard()`** (Phase 2) has no automatic trigger and must be scheduled. Two options:
  - **Supabase pg_cron** (simplest, no separate infra): 
    ```sql
    select cron.schedule(
      'rugtown-weekly-settlement',
      '5 0 * * 1',  -- 00:05 UTC every Monday, just after the ISO-week boundary
      $$select settle_weekly_leaderboard();$$
    );
    ```
  - **External scheduler** (GitHub Actions cron, etc.) calling the RPC with the service-role key via `supabase-js` or a direct REST call, on the same weekly cadence.
  - Either way: verify the cadence matches `rt_utc_weekly_key()`'s ISO-week boundary (Monday 00:00 UTC) so settlement always targets the week that just closed, not the one in progress.
- No other Edge Functions were introduced this phase — everything is a plain Postgres RPC.

---

## 5. Production verification queries (run on staging before production)

```sql
-- As an authenticated test user:
select ensure_period_missions('daily');   -- expect exactly 5 assignments: 1 each of exploration/social/mission/activity + 1 wildcard
select ensure_period_missions('weekly');  -- expect exactly 3 assignments
select get_points_leaderboard('weekly', 20, 0);
select get_my_leaderboard_rank('weekly');
select get_my_streak();
select record_daily_participation();      -- run twice in the same UTC day; second call must return duplicate:true
select record_activity_heartbeat();       -- run repeatedly; 6th succeeds, 7th must return reason:'daily_cap_reached'
select get_my_hidden_quests();
select discover_hidden_quest('hq_empty_chair');
select complete_hidden_quest('hq_empty_chair'); -- run twice; second call must return duplicate:true

-- As service_role only (must fail as a normal authenticated user):
select settle_weekly_leaderboard();
```

Also spot-check that `rt_grant_title`, the internal helper RPCs, and the maintenance RPCs gated in Phase 0.5 are still correctly restricted (not re-opened by any later migration) — `test-phase0-5-security-hardening.mjs` covers the logic, but REVOKE/GRANT enforcement itself can only be verified live.

---

## 6. Recommended launch QA sequence

1. Fresh Google sign-in on a clean account → confirm onboarding triggers (Phase 1 regression check — must not skip straight into the game).
2. Open Mission HQ (🏛️ action bar button) → confirm exactly 5 daily / 3 weekly missions, one per required category on daily.
3. Claim a daily mission → confirm XP/REP/points increase once; refresh the page; confirm the claim persists (not reset).
4. Visit Government Quarter, then the Quest Archive (formerly Holder Cashback Vault — its building interaction now opens a real `QuestArchivePanel` showing discovered/completed hidden quests; the old $RUGTOWN-token-gated vault UI is no longer reachable from it, see the final report) → confirm `hq_forgotten_door` discovers and completes in a single interaction.
5. Meet 3 different players (or NPC fallback if testing alone) → confirm `hq_market_watcher` shows an IN_PROGRESS state after 1–2, COMPLETED after the 3rd.
6. Touch Notice Board → Whale Tower → Spring Water in that exact order → confirm `hq_three_signs` completes immediately on the third touch, not one action later.
7. Open the Leaderboard panel signed in → confirm real ranked data appears (not NPC placeholder names) unless the "could not be reached" fallback banner is showing.
8. On staging, as service_role, call `settle_weekly_leaderboard()` → confirm top-3 players are rewarded once; call it again → confirm it reports `duplicate: true` and grants nothing further.
9. Mobile check: open Mission HQ and Leaderboard panels on a narrow viewport → confirm both remain usable (panels cap at 96vw under 600px per the CSS added this phase).
10. Full regression: `npx tsc --noEmit && npm run build`, then every suite in `package.json`'s `test:*` scripts.

---

## 7. Rollback note

All Phase 2 RPCs are `CREATE OR REPLACE FUNCTION` and all new tables are additive — there is no destructive schema change in this migration. If a rollback is needed, the safest path is to revoke/disable the new RPCs' grants (rather than dropping tables that may already hold player reward data) and revert the client build to the pre-Phase-2 commit.

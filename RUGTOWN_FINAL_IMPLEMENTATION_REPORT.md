# RugTown — Final Implementation Report (Phase 2 Repair + Launch Audit)

Scope: fix the blocking `rt_hidden_quest_reward` migration failure, verify Phase 2 in full, audit the repo for signup caps and active wallet requirements, repair what was found, and leave the repository/migrations in a state where remaining work is manual Supabase config + live QA.

---

## 1. The blocker — root cause and fix

**Error:** `42P13: return type mismatch in function declared to return record` / `Final statement returns text instead of integer at column 1` in `rt_hidden_quest_reward`.

**Investigation performed** (not guessed): read the function's full definition, its `RETURNS TABLE` declaration, every `SELECT`/`VALUES` expression inside it, both callers (`discover_hidden_quest`, `complete_hidden_quest`), the TypeScript consumer (`src/lib/hiddenQuests.ts`), and cross-checked the quest-id catalog against the client's `CANONICAL_HIDDEN_QUESTS` (`src/game/missions/HiddenQuestDirector.ts`).

**Root cause — case B (the SELECT expression), not the RETURNS declaration:**
```sql
-- was:
RETURNS TABLE (xp_reward integer, rep_reward integer, points_reward integer)  -- 3 columns, correct
...
SELECT * FROM (VALUES (...)) AS t(quest_id, xp_reward, rep_reward, points_reward)  -- 4 columns
WHERE t.quest_id = p_quest_id;
```
`quest_id` was only ever needed as a filter key, but `SELECT *` returned it as output column 1 (text), where the declared signature expects `xp_reward` (integer) — hence "text instead of integer at column 1". The 3-column `RETURNS TABLE` signature is correct: it already matches both callers exactly (`complete_hidden_quest` reads `reward.xp_reward`/`.rep_reward`/`.points_reward`; `src/lib/hiddenQuests.ts` reads `reward.xp_reward`/`.rep_reward`/`.points_reward` and nothing else — verified by reading the file, not assumed).

**Fix applied** in `database/migrations/20260820_phase2_progression_leaderboards_quests.sql`: changed `SELECT *` to `SELECT t.xp_reward, t.rep_reward, t.points_reward`. No type casting, no RETURNS-clause change, no TypeScript change needed — the frontend already expected the correct 3-field shape.

**Partial-application safety:** the migration has no top-level `BEGIN`/`COMMIT`. Statements before the failing `CREATE FUNCTION` (mission category seed, `ensure_period_missions`, `claim_daily_completion_bonus`, `record_daily_participation`, `get_my_streak`, activity heartbeats) very likely already committed to your database. The entire file was already written idempotently (`CREATE OR REPLACE FUNCTION`, `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before every `CREATE POLICY`, guarded `ALTER`/`UPDATE`/`INSERT ... ON CONFLICT`) — confirmed by reading every statement, not assumed. **No separate repair migration was created or is needed.** Re-run the same corrected file in full. See `RUGTOWN_MANUAL_DEPLOYMENT_CHECKLIST.md` §0 for the exact instruction.

**Test added:** `scripts/test-phase2-progression-leaderboards-quests.ts` §9 mirrors the fixed SQL catalog in TS, asserts the output shape is exactly `{xp_reward, rep_reward, points_reward}` (no leaked `quest_id`), and cross-checks catalog completeness against the real imported `CANONICAL_HIDDEN_QUESTS` (14 quest ids match exactly on both sides). Ran and passing.

---

## 2. Phase 2 migration — full review result

Read the entire 981-line file section by section (mission categories/seed, `ensure_period_missions`, `claim_daily_completion_bonus`, `record_daily_participation`/streaks, `record_activity_heartbeat`, hidden quests, points leaderboard, leaderboard history/snapshots, `settle_weekly_leaderboard`). Aside from the one bug above, this was already correctly built:

- 5 daily missions (1 each exploration/social/mission/activity + 1 wildcard) / 3 weekly, deterministic per `(player, period_key)` via `md5(id||uid||key)` ordering — refresh never reassigns.
- Every reward path is `SECURITY DEFINER` + `REVOKE ALL FROM PUBLIC` + explicit `GRANT ... TO authenticated`, with `auth.uid()` ownership checks and idempotency via `claimed_reward_keys` jsonb membership + `reward_ledger` `ON CONFLICT (player_id, idempotency_key) DO NOTHING`.
- Activity heartbeat: 5-minute cooldown, 6/day cap, small reward relative to missions — cannot be farmed by staying AFK.
- `get_points_leaderboard`/`get_my_leaderboard_rank`: dynamic column selection via `format(%I)` (SQL-injection-safe identifier quoting), indexed, `LIMIT`/`OFFSET` clamped server-side.
- `settle_weekly_leaderboard`: gated by `rt_is_service_role() OR rt_is_operator('operator')`; triple-redundant idempotency (`weekly_leaderboard_settlements` early-exit check, per-winner `claimed_reward_keys` guard, `ON CONFLICT DO NOTHING` on both the ledger and settlement inserts). Verified the week-key math: `rt_utc_weekly_key` uses `date_trunc('week', ...)` (Postgres ISO week, Monday 00:00 UTC start); `settle_weekly_leaderboard`'s default `p_period_key` is computed from `now() - interval '1 day'`, so a Monday-00:05-UTC cron run correctly targets the week that just ended — confirmed by reading both functions, not assumed. The existing cron recommendation (`5 0 * * 1`) is correct.
- `rt_capture_leaderboard_snapshot`: `REVOKE ALL FROM PUBLIC` with no further grant is intentional, not a bug — it's called only from inside other `SECURITY DEFINER` functions (internal-helper pattern already used elsewhere in this codebase).

No rework was needed here. Per your instruction not to rebuild working systems, I left all of this as-is.

---

## 3. Repo-wide audit findings

### Signup cap — clean
Searched for max-users/signup-cap/invite-gate/waitlist patterns across `src/` and `database/`. The only "invite-only"/"max members" hits are **parties** (max 4) and **guilds** (max 20) — legitimate small-group feature limits, unrelated to account registration. No application-level cap on registered players exists anywhere.

### Wallet auth in the active path — clean, with one real bug found and fixed
- `App.tsx`'s active routes are `/`, `/auth`, `/auth/callback`, `/onboarding/username`, `/character`, `/play` — Google OAuth only. The `/wallet` route redirects to `/auth`.
- `WalletAuthPage.tsx` / `SolanaWalletAuth.ts` exist but are imported by nothing (confirmed via repo-wide grep) — dead, unreachable code. Left in place per your explicit instruction ("legacy Solana code may remain in inactive/deferred infrastructure").
- `walletAddress` in `App.tsx`/`GamePage.tsx` is read-only display (shows a legacy wallet address in the settings panel *if* a profile already has one on file, else falls back to email) — it does not gate anything.
- **Real bug found:** the Cashback Vault building's interaction (`zone.id === 'cashback'` in `GamePage.tsx`) opened `RugTownVaultPanel` — a fully wallet/token panel ("Wallet", "Holder Tier", "Claimable $RUGTOWN", a claim-reward flow calling `VaultService`/`HolderService`). A second, separate code path (the modal-content switch's `case 'cashback':`) showed "Holder Cashback Vault — locked until $RUGTOWN activation... will open when the token launches and holder verification is live." Both are genuine token-gated language on a core building, contradicting the product direction. **Fixed:**
  - Created `src/components/QuestArchivePanel.tsx` — a real panel using the already-correct `getMyHiddenQuests()` (`src/lib/hiddenQuests.ts`) cross-referenced against `CANONICAL_HIDDEN_QUESTS` for title/lore/reward display, no wallet/token content.
  - `GamePage.tsx`: the cashback-zone interaction now opens `QuestArchivePanel` instead of `RugTownVaultPanel`; the stale locked-vault modal text was replaced with a one-line Quest Archive description.
  - `RugTownVaultPanel.tsx` is now unreferenced (confirmed via grep) — left in place, same reasoning as `WalletAuthPage.tsx`.
- **Found, left as-is, flagged for your awareness:** a "Holder Status" panel reachable from the action bar is explicitly labeled `MOCK · DEVNET PREVIEW — no wallet connected` / "This is a local toggle only — no wallet, no real Solana data." It doesn't gate signup, gameplay, missions, or the leaderboard, and makes no real wallet/Solana calls — so it doesn't violate any of your hard rules — but it does keep a "holder tier" concept visible in the core UI. I left it alone (ripping out an action-bar feature wasn't asked for and risks scope creep into "redesign the entire game"), but wanted you aware of it.

### 100-level progression — clean, no ceiling
`RankLadder.ts`'s `RANK_LADDER` has all 11 tiers through level 100 (Citizen 1–10 ... RugTown Legend 100), and `rankTierFromLevel` clamps to `[1, 100]`, not `[1, 50]`. The one `level >= 50` hit in `PlayerProfilePanel.tsx` and the `ach_level_50` achievement are legitimate mid-ladder references (Investigator tier is 41–50 in your own spec), not a ceiling.

### Username atomicity — clean
`update_player_username` is backed by `uq_profiles_username_normalized` — a `UNIQUE INDEX` on `lower(trim(username))` at the database level. Two concurrent claims of the same name: one commits, one gets a unique-violation from Postgres itself, not a client-side race. The client fallback path (used only if the RPC is missing entirely) relies on the same DB constraint.

### Cashback/vault references elsewhere — left alone, on purpose
`LandmarkCatalog.ts`'s minimap label map still says `cashback: 'Cashback Vault'` — but so does `government: 'Government'` (not "Mission HQ") and `alpha: 'Alpha Lounge'` (not "Alpha Club") in the same map: this is consistently the building's *architectural* name for map labels, distinct from its *functional* panel identity, which I did fix. Hidden-quest lore text (`hq_forgotten_door`'s description already says "behind the Quest Archive") and story-mission/achievement flavor text referencing the old name were left alone as narrative content, not functional gates.

---

## 4. Files changed

**SQL:**
- `database/migrations/20260820_phase2_progression_leaderboards_quests.sql` — fixed `rt_hidden_quest_reward`'s `SELECT` list (in place; no new migration file).

**New:**
- `src/components/QuestArchivePanel.tsx`

**Modified:**
- `src/components/GamePage.tsx` — import swap (`RugTownVaultPanel` → `QuestArchivePanel`), cashback-zone interaction now opens the new panel, stale locked-vault modal text replaced.
- `scripts/test-phase2-progression-leaderboards-quests.ts` — added §9, the `rt_hidden_quest_reward` shape/completeness regression test.
- `RUGTOWN_MANUAL_DEPLOYMENT_CHECKLIST.md` — added §0 (the fix, why it's safe to re-run, exact run instruction), updated §1's migration table and §6's QA step 4.

**Unchanged, verified correct:** everything else in the Phase 2 migration; `RankLadder.ts`; `update_player_username`/`uq_profiles_username_normalized`; the active Google-auth routing in `App.tsx`.

---

## 5. Tests / build

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass |
| `npm run build` | Pass |
| `test:phase0-5-security-hardening` | Pass (unchanged, re-run to confirm no regression) |
| `test:phase1-google-auth-onboarding` | Pass (unchanged, re-run to confirm no regression) |
| `test:phase2-progression-leaderboards-quests` | Pass, including the new `rt_hidden_quest_reward` regression test |

**REQUIRES MANUAL LIVE TEST (cannot be verified without a live Supabase project — not claimed as passing):**
- Applying the corrected Phase 2 migration itself and confirming it completes without error.
- All of `RUGTOWN_MANUAL_DEPLOYMENT_CHECKLIST.md` §5's verification queries (RPC execution, RLS/GRANT enforcement, actual duplicate-call idempotency against real rows).
- Concurrent-username-claim behavior under real simultaneous requests.
- `settle_weekly_leaderboard()` cron-triggered execution and the top-3 reward grant.
- The full §6 QA sequence, including the new Quest Archive panel end-to-end in the running game.

---

## 6. Remaining manual actions

Everything is now in `RUGTOWN_MANUAL_DEPLOYMENT_CHECKLIST.md`. Summary:

1. Run the corrected `20260820_phase2_progression_leaderboards_quests.sql` on staging (§0/§1).
2. Run §5's verification queries on staging.
3. Confirm Google OAuth provider + redirect URLs + Site URL in the Supabase dashboard (§2) — should already be set from Phase 1, worth a spot-check.
4. Schedule `settle_weekly_leaderboard()` via pg_cron or an external scheduler, Monday 00:05 UTC (§4) — confirmed correct against the actual week-key implementation.
5. Apply to production once staging is clean.
6. Run the full §6 QA sequence, including the new Quest Archive panel.

No data-loss risk: every Phase 2 object is additive (`IF NOT EXISTS`/`OR REPLACE`), and this repair changes only the previously-uncreated `rt_hidden_quest_reward` function's body.

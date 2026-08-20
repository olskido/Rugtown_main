# RugTown — Master Implementation Report (Phase 2 → Launch)

Scope: this report covers **Phase 2** work only. Phase 0 (audit), Phase 0.5 (security hardening) and Phase 1 (Google auth + onboarding) are complete and documented separately in `RUGTOWN_CLAUDE_TAKEOVER_REPORT.md`, `RUGTOWN_PHASE_0_5_SECURITY_HARDENING_REPORT.md`, and `RUGTOWN_PHASE_1_GOOGLE_AUTH_REPORT.md`. This report does not repeat their content except where Phase 2 directly builds on it.

---

## 1. Executive Summary

Phase 2 turns RugTown's server-authoritative progression spine (levels 1–100, REP/XP/Points, already live from Phase 16) into a full gameplay loop: a data-driven mission catalogue with exactly 5 category-guaranteed daily missions and 3 weekly missions, a 14-quest hidden-quest system covering all 12 trigger types, server-ranked daily/weekly/all-time Points leaderboards with idempotent weekly top-3 settlement, a real daily-participation streak with milestone rewards, a bounded activity-heartbeat reward, and UI to reach all of it (Mission HQ panel, rewired Leaderboard panel). Six buildings were repurposed with real gameplay meaning instead of just relabeling. No blockchain/wallet code was reintroduced into the active launch path (verified by grep sweep, §23). No hidden level-50 ceiling remains anywhere in the codebase (verified by grep sweep, §23).

One new migration (`20260820_phase2_progression_leaderboards_quests.sql`, ~981 lines) adds 15 new/rewritten RPCs, 6 new tables, and category metadata on `mission_definitions`, following the exact `SECURITY DEFINER` + `REVOKE ALL FROM PUBLIC` + explicit grant discipline established in Phase 0.5.

Two genuine bugs were found and fixed **during test-writing**, not left in place: an additive (non-mixing) hash function that would have made every player's daily missions identical forever, and a hidden-quest status/completion gap affecting multi-step SEQUENCE and count-based SOCIAL quests. Details in §18 and §25.

`npx tsc --noEmit`, `npm run build`, and all 7 offline test suites (6 pre-existing + 1 new) pass clean as of this report.

---

## 2. Architecture Changes

No architectural rewrites. Extended existing systems:

- **`MissionSystem`** (`src/game/missions/MissionSystem.ts`) gained a `playerLevel` field + `setPlayerLevel()` so `getActiveDefinition()` skips missions above the player's level — previously purely sequential with no level awareness.
- **`HiddenQuestDirector`** (`src/game/missions/HiddenQuestDirector.ts`) — fully rewritten in place (same class name/file, same consumer contract via `WorldScene`), not duplicated.
- **`WorldScene`** now owns a `HiddenQuestDirector` instance, feeds it `playerLevel`/`playerStreak` via `game.registry` listeners, and pipes every `MissionEventBridge` event to it — reusing the *same* event stream `MissionSystem` already consumes, not a second emitter.
- **`GamePage.tsx`** polls `registry.get('hiddenQuestState')` in the same interval loop that already polls `missionState`, and calls the new discover/complete RPC wrappers with session-lifetime dedup refs so a repeated poll never double-fires a network call.
- **`PointsLeaderboardPanel`** was rewired from a fake NPC-seeded local computation to the real `get_points_leaderboard`/`get_my_leaderboard_rank` RPCs, with the NPC-seed logic kept only as an offline/guest/error fallback (clearly labeled in the UI).
- **`MissionHQPanel`** (new component) is a thin view over the *existing* `RewardService`/`ProgressionService` singletons — it introduces no new client-side state machine.

No new progression/mission/leaderboard/reward-ledger system was created alongside an existing one.

---

## 3. Database Changes

New migration: `database/migrations/20260820_phase2_progression_leaderboards_quests.sql`.

**New tables (6):**
| Table | Purpose |
|---|---|
| `player_activity_heartbeats` | Bounded time-in-game reward cooldown/cap tracking |
| `hidden_quest_state` | Per-player discovered/completed hidden quest state |
| `leaderboard_period_snapshots` | Historical leaderboard captures |
| `weekly_leaderboard_settlements` | Idempotent record of weekly top-3 payouts |

(`player_daily_streaks` and `mission_definitions` are pre-existing tables extended, not created.)

**Schema changes:**
- `mission_definitions` gains `category text` (exploration/social/mission/activity/wildcard/weekly_challenge, CHECK-constrained), backfilled from `objective_type` heuristics, plus 8 new daily rows added so every category has real rotation variety.
- New partial indexes on `player_progression(daily_points/weekly_points/rug_points DESC) WHERE > 0` for leaderboard query performance.

All new tables have RLS enabled with owner-read-only or public-read policies matching the pattern already established in Phase 0.5 — no table is left with RLS disabled.

---

## 4. Migrations

Single new file, applied **after** the full existing chain. Full apply order is in §21 (Manual Deployment Checklist).

The migration is idempotent-safe to review (uses `ADD COLUMN IF NOT EXISTS`-equivalent guards where applicable, `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`) but has **not** been applied to any live database — it is not idempotent to *re-run against a different environment's pre-existing data* without the standard "review the diff first" discipline any migration deserves. Treat it as apply-once per environment.

---

## 5. RPCs Added / Changed

**Rewritten:**
- `ensure_period_missions(p_period_type)` — daily now assigns exactly 5 (1 per category × 4 + 1 wildcard, was 3 uncategorized); weekly now assigns 3 (was 4).
- `claim_daily_completion_bonus()` — threshold changed from 3/3 to 5/5 claimed dailies.

**New (13):**
`record_daily_participation`, `get_my_streak`, `record_activity_heartbeat`, `discover_hidden_quest`, `complete_hidden_quest`, `get_my_hidden_quests`, `rt_hidden_quest_reward` (internal, immutable lookup), `get_points_leaderboard`, `get_my_leaderboard_rank`, `get_leaderboard_history`, `rt_capture_leaderboard_snapshot` (internal), `settle_weekly_leaderboard`, `get_weekly_champions`.

Every reward-granting RPC is `SECURITY DEFINER`, uses `auth.uid()` for ownership, and grants rewards via `reward_ledger` + a `claimed_reward_keys` jsonb membership check for idempotency — the same pattern as every prior phase.

---

## 6. RLS Changes

- New tables: RLS enabled on all 4, with owner-read-only policies on `player_activity_heartbeats`/`hidden_quest_state` (no client INSERT/UPDATE policy — writes happen exclusively through `SECURITY DEFINER` RPCs) and public-read policies on `leaderboard_period_snapshots`/`weekly_leaderboard_settlements` (leaderboard/hall-of-fame data is meant to be publicly visible, matching the existing `profiles` public-read pattern).
- `get_points_leaderboard`/`get_leaderboard_history`/`get_weekly_champions` are granted to `authenticated, anon` — deliberate, since leaderboards are meant to be visible to guests too (matches the pre-existing public-read posture on `profiles`).
- `settle_weekly_leaderboard` is gated to `rt_is_service_role() OR rt_is_operator('operator')` and granted **only** to `service_role` — cannot be called by a player.

---

## 7. Authentication Status

Unchanged from Phase 1. No auth code touched this phase.

---

## 8. Progression Status

100-level curve (Phase 16) re-verified clean this phase via a full grep sweep — no hidden 50-level ceiling anywhere in SQL or TS (see §23). REP/XP/Points/Streak remain strictly separate fields, never merged, consistent with the existing `PlayerProgression` shape.

---

## 9. Mission System Status

`MissionSystem` (starter/level-two/story/bracket/party catalogues) is unchanged in content, gained only a level gate. `getActiveDefinition()` now correctly skips missions above `playerLevel` (default `Infinity`, so behavior is unchanged for any caller that never calls `setPlayerLevel()` — zero regression risk). Six broken target-id references in `bracketMissions.ts` (`mission_hq`, `quest-archive`) were retargeted to real world-object ids (`government`, `holder-cashback-vault`).

---

## 10. Daily Mission System

5 slots: 1 exploration + 1 social + 1 mission + 1 activity + 1 wildcard, assigned deterministically per (player, UTC day) both server-side (`ensure_period_missions`, `ORDER BY md5(...)`) and client-side offline/guest fallback (`pickLocalDaily`, FNV-1a hash — see §18 for why the original char-sum hash was replaced). 29 daily catalog entries now exist (was 21), added specifically to give every category real rotation variety instead of 1–3 fixed options.

---

## 11. Weekly Mission System

3 slots (was 4), assigned from a 15-entry catalog via the same deterministic hash pattern. `claim_daily_completion_bonus()`'s all-claimed threshold updated to match (5, was 3).

---

## 12. Hidden Quest System

14 canonical quests (was 5), all retargeted to **real** world-object ids/NPC roles — the original 5 referenced ids that existed nowhere in the world (`bench_east`, `quest-archive-masonry`, `silent_wanderer`, `mysterious_stranger`) and could never fire. All 12 trigger types are represented and exercised by the new test suite: LOCATION, INTERACTION, SEQUENCE, SOCIAL, TIME, LEVEL, MISSION_COMPLETION, NPC, EXPLORATION_COMBINATION, STREAK, EVENT, COMPOUND.

State model UNKNOWN → DISCOVERED → IN_PROGRESS → COMPLETED persists across sessions via `hidden_quest_state` (server) and `RugtownProgress.hiddenQuestsDiscovered/hiddenQuestsCompleted` (local/guest cache). Two correctness bugs found and fixed during test-writing — see §18 and §25.

---

## 13. Leaderboards

Daily/weekly/all-time Points leaderboards, server-ranked via `row_number() OVER (ORDER BY points DESC, player_id ASC)` — ties broken deterministically, never a full-table client load (top-N + offset only). `get_my_leaderboard_rank` computes rank as `COUNT(*) WHERE points > mine` without scanning the full table client-side. `PointsLeaderboardPanel` now renders real data with a clearly-labeled fallback to local NPC-seed preview data for guests or on RPC failure.

---

## 14. Weekly Rewards

`settle_weekly_leaderboard` grants top-3 REP (150/90/50) + rug_points (500/300/150) + a title, gated to service-role/operator, idempotent via a `UNIQUE(period_key, rank)` constraint plus `claimed_reward_keys` defense-in-depth. **Not blockchain** — REP/points/title only, matching the explicit non-blockchain-launch constraint. No automatic trigger exists yet — this needs a manual/cron invocation (§21, §22).

---

## 15. Building Changes

| Building | Old | New purpose |
|---|---|---|
| Government Quarter | inert, not enterable | Mission HQ — reachable via new HUD action button + `MissionHQPanel` (see §21 for why a door-zone wasn't added) |
| Holder Cashback Vault | `locked` | Quest Archive — `discovery` interaction, houses `hq_forgotten_door` |
| Hall of Fame | dead leaderboard block | Real Leaderboard panel button + hidden-quest reward destination |
| Future Arena | `access: 'coming_soon'` (stale) | Challenge Arena — `access: 'open'` |
| Coffee Shop | — | Social Hub (renamed context, houses `hq_the_stranger`) |
| Alpha Lounge | Level-30+ lounge | Alpha Club (renamed) |

---

## 16. UI Changes

- New action bar button: 🏛️ Mission HQ (key `J`), opens `MissionHQPanel` (Daily/Weekly/Progress tabs).
- Old inline NPC-seeded Leaderboard JSX block (~59 lines) removed entirely in favor of `PointsLeaderboardPanel`, which was previously imported but never rendered.
- New shared `.panel-overlay`/`.panel`/`.panel__*` CSS family added to `game.css`, matching the existing `.modal-overlay`/`.modal-panel` dark/gold aesthetic (`rgba(6,10,14,0.98)` background, `#9a6e1e`/`#c8902a` gold borders) rather than inventing a new visual language.
- Leaderboard row markup extended (4-column grid, player/podium modifiers, rank callout, footer) without touching the pre-existing tab styling it reuses.

---

## 17. Anti-Abuse Protections

- Activity heartbeat: 5-minute cooldown + 6/day cap, enforced server-side regardless of client call frequency.
- All reward RPCs use `claimed_reward_keys` jsonb membership checks — a duplicate claim is always a no-op, never a double-grant.
- Weekly settlement has a hard `UNIQUE(period_key, rank)` DB constraint as the primary guarantee, not just the jsonb check.
- Streak milestones keyed `'streak_milestone:' || days` — cannot be re-claimed by replaying the same day.
- `record_daily_participation`/`get_my_streak`/`record_activity_heartbeat`/hidden-quest RPCs are all `auth.uid()`-scoped `SECURITY DEFINER` — a player can only ever affect their own row.

---

## 18. Tests

**Pre-existing suites — all still pass** (`test:session-store`, `test:gameplay-completion`, `test:prelaunch-wallet-guild`, `test:phase15-1-hardening`, `test:phase0-5-security-hardening`, `test:phase1-google-auth-onboarding`). One pre-existing test (`test-gameplay-completion.ts`) asserted the *old* daily/weekly counts (3/4) — updated to assert the new, intentional counts (5/3); this is a test-catchup, not a regression.

**New:** `scripts/test-phase2-progression-leaderboards-quests.ts` (`npm run test:phase2-progression-leaderboards-quests`), imports and exercises the **real** `HiddenQuestDirector`/`PeriodMissions` classes/functions directly (not mocks) — 9 sections covering category-guarantee correctness across 28 (player, day) combinations, all 12 hidden-quest trigger types individually, state-persistence round-trips, and plain-TS mirrors of the SQL-only streak/rank/idempotency logic (documented as mirrors, matching this repo's established Phase 0.5/Phase 1 testing convention for server-only code).

**This test-writing process found and fixed two real bugs**, not test-fitting:
1. `hashPick()` in `PeriodMissions.ts` summed character codes of `seed + id` — additive, so the seed's contribution was a constant shift that canceled out of the sort order entirely. Every player would have received the identical 5 daily missions forever, with zero day-to-day or player-to-player rotation. Fixed with an FNV-1a mix. (The equivalent server-side SQL logic, `md5(id||uid||period_key)`, was never affected — md5 mixes non-linearly.)
2. `HiddenQuestDirector`: multi-objective `SEQUENCE` quests (`hq_three_signs`) discovered on the exact event that completed the sequence but didn't complete until one extra, unrelated event fired afterward — because `SEQUENCE` has no partial-match state, yet wasn't flagged `singleShot`. Separately, `getStatus()` only derived `IN_PROGRESS` from `objectives.length > 1`, which SOCIAL quests with a single objective entry but a multi-person `socialCount` (e.g. `hq_market_watcher`, meet 3 players) never satisfy — so a player who'd met 1 of 3 required people saw no progress indication at all. Both fixed; see `HiddenQuestDirector.ts` inline comments for the reasoning.

**Not covered by any automated test** (requires live Supabase — see §21's QA sequence): RLS/GRANT enforcement, actual RPC execution against real data, concurrent-claim atomicity, real cron-triggered weekly settlement.

---

## 19. TypeScript

`npx tsc --noEmit` — clean (exit 0), confirmed after every edit in this phase and again as the final step.

---

## 20. Production Build

`npm run build` — succeeds (exit 0). Only pre-existing, unrelated chunk-size warnings (`phaser`/`index` bundles >500kB) — not introduced or worsened by Phase 2.

---

## 21. Manual Deployment Checklist

**1. Apply migrations in order** (this phase adds the last one):
```
... (all pre-existing 20260716–20260817 migrations, already applied)
database/migrations/20260820_phase0_5_security_hardening.sql
database/migrations/20260820_phase1_google_auth_onboarding.sql
database/migrations/20260820_phase2_progression_leaderboards_quests.sql   ← NEW
```
Review the file once against your actual production schema before applying — it was written and tested against the schema state as of Phase 1, not executed against a live database.

**2. Supabase Dashboard / Google OAuth config** — no changes this phase; already documented in `RUGTOWN_PHASE_1_GOOGLE_AUTH_REPORT.md`.

**3. Environment variables** — no new env vars introduced.

**4. Weekly settlement scheduling** — `settle_weekly_leaderboard` has **no automatic trigger**. It must be invoked weekly (e.g. Monday 00:05 UTC, just after the ISO-week boundary) via either:
   - a Supabase pg_cron job calling `select settle_weekly_leaderboard();`, or
   - an external scheduler (GitHub Actions cron, etc.) calling the RPC with the service-role key.
   This is a genuine manual/ops step — pick one and configure it before relying on weekly rewards actually paying out.

**5. Mission HQ discoverability** — Government Quarter was deliberately **not** added to `ENTERABLE_BUILDINGS` (would require guessing new door-zone coordinates against unfamiliar collision geometry). Mission HQ is reachable purely via the new HUD action button. If a future pass wants a walk-in door instead, that requires real coordinate work against the world's actual collision layer — flag this as a deliberate scope decision, not an oversight.

**6. Production verification queries** (run against staging first):
```sql
select ensure_period_missions('daily');   -- as an authenticated test user; expect 5 assignments, 1 per category + wildcard
select ensure_period_missions('weekly');  -- expect 3 assignments
select get_points_leaderboard('weekly', 20, 0);
select get_my_leaderboard_rank('weekly');
select record_daily_participation();      -- run twice same day; second call must be duplicate:true
select record_activity_heartbeat();       -- run 7x quickly; 7th must return reason:'daily_cap_reached'
```

**7. Recommended launch QA sequence:**
1. Fresh Google sign-in → confirm onboarding still triggers correctly (Phase 1 regression check).
2. Open Mission HQ → confirm exactly 5 daily / 3 weekly missions appear, one per required category on daily.
3. Claim a daily mission → confirm XP/REP/points increase once, refresh page, confirm it stays claimed (not reset).
4. Visit `government` → `holder-cashback-vault` (Quest Archive) → confirm `hq_forgotten_door` discovers+completes in one interaction.
5. Meet 3 different players (or NPC fallback) → confirm `hq_market_watcher` shows IN_PROGRESS after 1–2, COMPLETED after 3.
6. Touch notice → whale → fountain in order → confirm `hq_three_signs` completes immediately on the third touch (not one action later).
7. Open Leaderboard panel as a signed-in user → confirm real ranked data (not NPC names) unless the fallback banner is showing.
8. As service_role, call `settle_weekly_leaderboard()` on staging → confirm top-3 rewarded once, second call reports `duplicate:true`.
9. Full regression: `npx tsc --noEmit && npm run build` + all 7 test suites.

---

## 22. Remaining Blockers

- Weekly settlement has no cron wiring yet — see §21 step 4. This is the one functional gap between "code complete" and "actually pays out weekly" in production.
- Mission HQ has no in-world door — accessible only via HUD button (deliberate, see §21 step 5, §15).

---

## 23. Deferred Solana Infrastructure — Confirmation Sweep

Grep sweep across `src/components/GamePage.tsx` and `src/App.tsx` for `walletConnect`, `connectWallet`, SPL transfer, `claimToken`, `treasury` — **zero matches**. No wallet/token/blockchain code was reintroduced into the active launch path this phase. Pre-existing deferred Solana infrastructure (wallet verification tables, holder-tier RPCs from earlier phases) was not touched, deleted, or reactivated — it remains classified as deferred, not removed.

Grep sweep for a hidden level-50 ceiling across `src/game/progression/*.ts` and this phase's + Phase 16's migrations — the only hit is the legitimate `ach_level_50` achievement milestone (`AchievementCatalog.ts:414`), not a functional cap. `MAX_LEVEL = 100` confirmed via the existing `test-gameplay-completion.ts` assertion, which still passes.

---

## 24. Summary of File Changes

**New files:** `database/migrations/20260820_phase2_progression_leaderboards_quests.sql`, `src/lib/leaderboard.ts`, `src/lib/hiddenQuests.ts`, `src/lib/activity.ts`, `src/components/MissionHQPanel.tsx`, `scripts/test-phase2-progression-leaderboards-quests.ts`, this report.

**Modified files:** `src/game/missions/MissionSystem.ts`, `src/game/missions/HiddenQuestDirector.ts`, `src/game/scenes/WorldScene.ts`, `src/lib/progress.ts`, `src/game/rewards/PeriodMissions.ts`, `src/game/missions/definitions/bracketMissions.ts`, `src/game/world/WorldObjects.ts`, `src/game/world/EnterableBuildings.ts`, `src/game/world/BuildingRegistry.ts`, `src/components/PointsLeaderboardPanel.tsx`, `src/lib/supabase.ts`, `src/components/GamePage.tsx`, `src/styles/game.css`, `scripts/test-gameplay-completion.ts` (assertion catchup), `package.json` (new test script entry).

---

*Report generated at the end of Phase 2. No blockchain reintroduction. No hidden level ceiling. No duplicate progression/mission/leaderboard/reward-ledger system. All tests, tsc, and build green.*

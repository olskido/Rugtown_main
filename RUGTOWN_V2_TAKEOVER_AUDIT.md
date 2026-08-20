# RugTown V2 Takeover Audit

**Audit Date:** August 17, 2026
**Audited By:** Kiro (takeover agent)
**Previous Agent:** Antigravity
**Repository:** `c:\Users\Surface\Desktop\Rugtown\Rugtown`
**Package Version:** 2.0.0

---

## 1. Executive Summary

RugTown is a substantially built, functional 2D social city game. The previous
agent (Antigravity) has completed a large and coherent transformation from a
Solana-wallet-first architecture toward a social-progression-first architecture.
The core game loop — explore, interact, complete missions, earn REP/XP/Points,
level up — is **architecturally complete at the client layer** and **partially
wired at the database layer**.

The most important gaps are:

1. **The database level cap is 50, but the client supports 100.** Every server
   RPC that awards XP uses a CHECK constraint `level <= 50`. The client
   `XpCurve.ts` and all mission definitions go to level 100. This is a hard
   mismatch that will break server-side level computation for players who reach
   level 50+.
2. **The Points leaderboard has no database backend.** `PointsLeaderboardPanel`
   shows NPC seed data only. There is no `get_points_leaderboard` RPC and no
   `points_leaderboard` table in any migration.
3. **Daily missions assign 3, not 5.** The spec calls for 5 daily missions
   (1 per category). The current system assigns 3.
4. **Hidden quests are client-only.** `HiddenQuestDirector` is fully built, but
   there is no database table or RPC backing hidden quest state.
5. **8 Solana/wallet Edge Functions remain deployed and active.** The wallet
   route is disabled in the UI but the backend infrastructure is still live.
6. **`send-direct-message` Edge Function is missing its `index.ts`.**
7. **`government` building (Mission HQ) is NOT enterable** — it is
   `exterior_only` in `BuildingRegistry` and absent from `ENTERABLE_BUILDINGS`.
8. **Client XP curve is version 4; the test script still asserts version 3.**
   Possible stale test assertion.

Overall the codebase is in good shape. The transformation is ~75% complete.

---

## 2. Repository State

| Item | Value |
|---|---|
| Package name | rugtown |
| Version | 2.0.0 |
| Framework | React 18 + Phaser 3.60 + TypeScript 5.3 |
| Bundler | Vite 5 |
| Auth/DB | @supabase/supabase-js 2.110 |
| Routing | react-router-dom 6.30 |
| Wallet packages | **None installed** — no @solana/web3.js, no wallet-adapter |
| Solana code | Present in `src/lib/wallet/` — pure JS, no npm wallet deps |
| Database migrations | Phases 10G → 10H → 10I → 10J → 10K → 10L → 10M/N/P/Q/S → 11 → 12 → 13 → 13b → 13c → 14 → 15 → 15.1 |
| Edge Functions | 16 deployed (8 Solana-related, 8 general) |
| Test scripts | 6 in `scripts/` — mix of offline unit tests and live RLS harness |
| No `.kiro/` directory found in repo | No Kiro spec files, hooks, or steering |

The repository is a **mono-package** (no workspaces). All source is in `src/`.
Supabase Edge Functions are in `supabase/functions/`. Database migrations are
in `database/migrations/` and are applied **manually** (not via Supabase CLI
migrations).

---

## 3. Antigravity Work Detected

No `implementation_plan.md`, `ANTIGRAVITY.*`, or comment markers were found.
Antigravity's work is **embedded throughout the codebase with no file-level
separation**. It is identifiable by the coherent new systems that go well beyond
the original Solana-wallet game:

**Newly created by Antigravity (high confidence):**

- `src/game/progression/` — entire directory: `ProgressionService.ts`,
  `ProgressionRepository.ts`, `RankLadder.ts`, `XpCurve.ts`, `RewardTables.ts`,
  `AchievementCatalog.ts`, `TitleCatalog.ts`, `UnlockCatalog.ts`,
  `SeasonFoundation.ts`, `ProgressionEvents.ts`, `types.ts`
- `src/game/missions/` — entire directory: `MissionSystem.ts`,
  `MissionEventBridge.ts`, `MissionTypes.ts`, `HiddenQuestDirector.ts`,
  and all definitions under `definitions/`
- `src/game/rewards/PeriodMissions.ts` — daily/weekly catalog (21 daily,
  15 weekly)
- `src/components/PointsLeaderboardPanel.tsx` — leaderboard UI (NPC seed only)
- `src/components/UsernameOnboardingPage.tsx` — username onboarding flow
- `src/components/AuthCallbackPage.tsx` — PKCE OAuth callback page
- `src/components/LevelUpToast.tsx` — level-up notification component
- `database/migrations/20260722_phase13*` through `20260813_phase15_1*` —
  all chapter mission, period mission, guild, vault, and hardening migrations
- The 100-level `BRACKET_MISSIONS` and `STORY_MISSIONS` catalogs
- `HiddenQuestDirector` with all 5 canonical hidden quests

**Modified by Antigravity (high confidence):**

- `src/App.tsx` — added Google OAuth route, /onboarding/username, session restore
- `src/components/AuthPage.tsx` — rebuilt to Google OAuth + email/password
- `src/components/GamePage.tsx` — wired ProgressionService, RewardService,
  MissionSystem, leaderboard, guild panels
- `src/game/world/EnterableBuildings.ts` — renamed buildings (Quest Archive,
  Challenge Arena, Hall of Fame & Leaderboards)
- `src/game/world/BuildingRegistry.ts` — updated display names/summaries
- `src/lib/profile.ts` — added `getRugtownProfileState`, `createRugtownProfile`,
  `checkUsernameAvailable`

**Leftover / not yet cleaned up:**

- `src/components/WalletAuthPage.tsx` — exists but not routed
- `src/lib/wallet/` — SolanaWalletProviders, SolanaWalletAuth — not removed
- All 8 Solana Edge Functions — still deployed

---

## 4. Authentication

**Status: [PARTIAL]**

### What is implemented

- `AuthPage.tsx`: Google OAuth (`signInWithOAuth` with `provider: 'google'`),
  email/password sign-up and sign-in, guest mode. All three paths are live.
- `AuthCallbackPage.tsx`: Handles both PKCE (`?code=`) and legacy hash tokens.
  Calls `exchangeCodeForSession`. Clears sensitive params from address bar.
- `supabase.ts`: Client configured with `flowType: 'pkce'`,
  `detectSessionInUrl: false`, `persistSession: true`, `autoRefreshToken: true`.
  PKCE is correctly set up.
- `App.tsx`: `onAuthStateChange` listener. Session restored via `getSession()`
  on mount. `SIGNED_IN` / `SIGNED_OUT` events handled.
- `/wallet` route redirects to `/auth` — the wallet auth page is disabled.
- Returning authenticated users with `onboarding_completed = true` skip
  `/onboarding/username` and go directly to `/character` or `/play`.

### What is missing / partial

- **Google OAuth requires Supabase dashboard configuration** (redirect URL
  `<origin>/auth/callback` must be allow-listed). This is a manual step, not
  code — but it must be done before Google login works in production.
- **`/onboarding/username` routing gap**: App redirects to `/onboarding/username`
  when `onboardingCompleted = false`, but only checks on the initial `SIGNED_IN`
  event path. If a returning user has no username and navigates directly to `/play`,
  the guard may not fire correctly because `didRestoreRouteRef` is already `true`.
- **No email verification enforcement**: `signUp` sends a confirmation email but
  the game can still be entered as a guest before verifying. There is no hard
  gate on email-verified status.
- **`WalletAuthPage.tsx` is orphaned** — fully functional Solana wallet auth
  component, not mounted anywhere in `App.tsx`.

### Route map (actual)

| Route | Component | Status |
|---|---|---|
| `/` | LandingPage | Live |
| `/auth` | AuthPage (Google + email + guest) | Live |
| `/auth/callback` | AuthCallbackPage (PKCE) | Live |
| `/onboarding/username` | UsernameOnboardingPage | Live |
| `/character` | OutfitSelectPage | Live |
| `/play` | GamePage | Live |
| `/wallet` | → redirect to `/auth` | Disabled |
| `*` | → redirect to `/` | Catch-all |

---

## 5. Username / Profile System

**Status: [PARTIAL]**

### What is implemented

- `profiles` table: `id`, `username`, `display_name`, `avatar_url`, `rep`,
  `holder_tier`, `wallet_address`, `wallet_chain`, `username_normalized`,
  `onboarding_completed`, `authenticated_at` (Phase 15 extensions applied).
- `fetchOrCreateProfile()`: Creates a profile row if missing, using
  `user_metadata.username` from Google OAuth or a sanitized email prefix.
  Handles race conditions (trigger vs. client insert).
- `getRugtownProfileState()`: Server RPC `get_rugtown_profile_state` returns
  profile + onboarding status. Falls back to direct `profiles` select if RPC
  is missing.
- `createRugtownProfile(username)`: Calls `create_rugtown_profile` RPC which
  handles uniqueness atomically.
- `checkUsernameAvailable(username)`: Calls `check_username_available` RPC.
  Falls back to `ilike` query for pre-migration databases.
- `saveUsername()`: Calls `update_player_username` RPC; falls back to direct
  `profiles.update` if RPC missing.
- `UsernameOnboardingPage.tsx`: 3–16 char validation, reserved word check,
  real-time availability check on blur, `create_rugtown_profile` on submit.

### What is missing

- **Returning Google user skips onboarding correctly, but only when the app
  detects `onboardingCompleted = false`.** If the `get_rugtown_profile_state`
  RPC is not applied yet (pre-Phase 15 DB), the fallback returns
  `onboarding_completed ?? true`, meaning new Google users may bypass the
  username page with no username set.
- **No username uniqueness enforcement at signup via Google** — a Google user
  whose email prefix collides with an existing username gets a random suffix
  silently. The player is never shown this. Their chosen "username" in the
  game is then the auto-generated handle, not something they picked.
- **`handle_new_user` trigger** is referenced in code comments but its SQL is
  in `schema.sql` (base schema). Not confirmed whether it was applied to the
  production database alongside Phase 15 migrations.

---

## 6. Solana / Wallet Dependencies

**Status: [LEGACY / DEFERRED]**

All Solana/wallet code exists but the **player-facing route is disabled**.
No Solana npm packages are installed (`package.json` has zero wallet-adapter
dependencies). Solana interaction is handled via raw browser `window.solana`
injection and `signInWithWeb3` on `@supabase/supabase-js`.

### Player-facing (currently disabled)

| File | Classification | Notes |
|---|---|---|
| `src/components/WalletAuthPage.tsx` | PLAYER-FACING | Not routed. Shows Phantom/Solflare/Backpack wallet list. |
| `src/lib/wallet/SolanaWalletProviders.ts` | PLAYER-FACING | `discoverSolanaWallets()` — reads `window.solana` etc. |
| `src/lib/wallet/SolanaWalletAuth.ts` | PLAYER-FACING | `signInWithWeb3` wrapper. |
| `/wallet` route | PLAYER-FACING | Redirects to `/auth`. Disabled. |

### Backend / Edge Functions (still live)

| Edge Function | Classification | Notes |
|---|---|---|
| `claim-rugtown-reward` | BACKEND / SOLANA | SPL token transfer, treasury private key. Gated by `SETTLEMENT_MODE`. |
| `create-wallet-verification-challenge` | BACKEND / SOLANA | Issues challenge for wallet signature. |
| `refresh-holder-status` | BACKEND / SOLANA | Reads SPL balance from Solana RPC. |
| `verify-wallet-signature` | BACKEND / SOLANA | Verifies ed25519 signature. |
| `submit-reward-settlement` | BACKEND / SOLANA | Settlement pipeline. |
| `verify-reward-settlement` | BACKEND / SOLANA | Verifies on-chain tx. |
| `retry-reward-settlement` | BACKEND / SOLANA | Retry logic. |
| `revoke-verified-wallet` | BACKEND / SOLANA | Revokes a verified wallet link. |

### Database tables (Solana-related)

| Table | Classification | Notes |
|---|---|---|
| `holder_status` | LEGACY / DEFERRED | Token balance, holder tier, rp_multiplier. |
| `player_epoch_rewards` | LEGACY / DEFERRED | Per-epoch SPL allocations. |
| `reward_epochs` | LEGACY / DEFERRED | Daily epoch windows for token distribution. |
| `verified_wallets` | LEGACY / DEFERRED | Verified wallet addresses. |
| `wallet_verifications` (schema.sql) | LEGACY | Base schema placeholder. |
| `profiles.wallet_address` | LEGACY / DEFERRED | Populated by holder onboarding. |
| `profiles.wallet_chain` | LEGACY / DEFERRED | Default 'solana'. |
| `profiles.holder_tier` | LEGACY / DEFERRED | 'None'/'Bronze'/'Silver'/'Gold'. |

### Env variables (Solana-related)

From `.env.example`:
- `VITE_RUGTOWN_TOKEN_ENABLED` — currently `false`
- `VITE_RUGTOWN_TOKEN_MINT_ADDRESS` — empty
- `VITE_RUGTOWN_TOKEN_CLUSTER` — `mainnet-beta`
- `VITE_SOLANA_RPC_URL` — devnet default
- `VITE_RUGTOWN_TOKEN_MINT` — empty
- Server-only: `TREASURY_PUBLIC_ADDRESS`, `RUGTOWN_REWARD_TREASURY_SECRET`,
  `SOLANA_RPC_ENDPOINT`, `SETTLEMENT_MODE` (currently `disabled`)

### What can safely be disabled later

The entire Solana path can be deferred without touching gameplay code because:
- No Solana npm packages are installed
- `VITE_RUGTOWN_TOKEN_ENABLED=false` disables the feature flag
- `SETTLEMENT_MODE=disabled` keeps epoch claims in dev mode
- `/wallet` route already redirects to `/auth`
- `WalletAuthPage` is already unrouted

The 8 Solana Edge Functions can be left deployed but will never be called by
players while the UI routes are disabled.

---

## 7. REP System

**Status: [PARTIAL]**

### What is implemented

- `profiles.rep` column — the canonical lifetime REP field.
- `ProgressionService.awardRep()` — client-side, idempotent via claimed-key
  map, awards REP to `PlayerProgression.rep` and persists to localStorage.
- `RewardTables.ts` — REP amounts: landmark visit (+2), district visit (+4),
  interior visit (+3), player interaction (+1).
- `saveRep()` in `profile.ts` — direct `profiles.update({rep})`. **This is a
  legacy path** — Phase 10G's trigger blocks it unless the mutation flag is set.
- `award_gameplay_reward` RPC (Phase 10G) — server-authoritative REP grants via
  `reward_ledger`. Properly guarded by SECURITY DEFINER + mutation flag.
- `complete_chapter_mission` RPC — awards `rep_reward` from chapter catalog.
- `claim_mission_reward` RPC — awards `rep_reward` from period missions.
- `claim_guild_contract` RPC — awards `rep_reward` from guild contracts.
- REP is protected server-side by the `profiles_protect_reward_columns` trigger.

### What is missing / broken

- **`saveRep()` still called in `GamePage.tsx`** for legacy/guest paths. For
  authenticated users on Phase 10G+ databases, this write is silently blocked
  by the trigger. The client doesn't know this happened. REP may appear to save
  locally but not persist to Supabase for authenticated users in legacy code
  paths.
- **No separate REP leaderboard** — REP is visible in `PlayerProfilePanel` but
  not ranked. The leaderboard ranks by `points`, not REP.
- **REP is not exposed on the `get_rugtown_profile_state` RPC return value** in
  a way that the client guarantees sync. The client loads initial REP from
  `profile.rep` at game start, but mid-session REP is tracked locally only.

---

## 8. XP / Level System

**Status: [PARTIAL — CRITICAL DB MISMATCH]**

### What is implemented (client)

- `XpCurve.ts` — 100-level curve v4: `200 + 45n + 6n² + 0.08n³` per level.
  `PROGRESSION_CURVE_VERSION = 4`. `MAX_LEVEL = 100`.
- `levelFromLifetimeXp()`, `totalXpRequiredForLevel()`, `applyXpGain()` — all
  correct for 100 levels.
- `ProgressionService.awardXp()` — idempotent, awards XP, triggers level-up
  detection, emits `level_up` event, fires `LevelUpToast`.
- `LevelUpToast.tsx` — level-up notification component exists.
- `ProgressionRepository.ts` — localStorage persistence. `syncToServer()` is a
  **no-op stub** — labeled "Phase 10G — server-authoritative snapshots" but
  never implemented. XP/level are never pushed to Supabase by the client.
- `syncFromServerSnapshot()` — pulls XP/level from server on login. One-way
  server→client sync on session start.

### Critical mismatch

- **DB `player_progression.level` has `CHECK (level >= 1 AND level <= 50)`.**
  This constraint is defined in Phase 10G and never removed in any subsequent
  migration (Phase 14 adds a v3 curve but still caps at level 50 in SQL).
- **DB XP curve cap**: `rt_xp_required_for_level_v3` returns 0 for
  `p_level >= 50`, meaning DB considers level 50 as max.
- **Client XP curve goes to 100, DB caps at 50.** Any server RPC that tries to
  write a level > 50 will hit the CHECK constraint and fail.
- The `test-gameplay-completion.ts` test asserts `PROGRESSION_CURVE_VERSION = 3`
  but `XpCurve.ts` exports version 4. **This test assertion is stale.**

### What is missing

- A Phase 16 migration that: removes the `level <= 50` CHECK, adds a v4 XP
  curve function matching the client, and updates `rt_recompute_level`.
- Client `syncToServer()` stub needs implementing to push XP/level progress
  back to Supabase during play sessions (currently XP never reaches the server
  except via mission/reward RPCs that include a progression snapshot response).

---

## 9. Points System

**Status: [PARTIAL]**

### What is implemented

- `PlayerProgression.points: { daily, weekly, lifetime }` — all three buckets
  tracked in `ProgressionService`.
- `ProgressionService.awardPoints()` — idempotent, increments daily + weekly +
  lifetime atomically with claimed-key deduplication.
- Daily reset: `recomputeDerived()` detects a new UTC calendar day and sets
  `points.daily = 0`. Weekly reset is **not implemented** — weekly points
  accumulate forever in the client.
- `PointsLeaderboardPanel.tsx` — UI exists with Daily / Weekly / All-Time tabs.
  Reads from `progressionService.get()`. **Uses NPC seed data for all other
  entries**. The panel has a comment: "swap the mock data for
  `supabase.rpc('get_points_leaderboard', ...)`".
- Mission definitions include `rewardPoints` fields (e.g., starter missions
  reward 10–100 pts, bracket missions reward up to 100,000 pts).
- `claim_mission_reward` RPC returns `seasonPointsAwarded` and
  `rugPointsAwarded` — Points are tracked server-side as `rug_points` and
  `season_points` in `player_progression`.

### What is missing

- **No `get_points_leaderboard` RPC in any migration.** The DB has a
  `season_leaderboard` view (season_points based) and `get_season_leaderboard`
  RPC, but no daily/weekly/all-time Points leaderboard.
- **No DB column for separate `daily_points` or `weekly_points`** — DB only
  has `rug_points` (cumulative) and `season_points`. Client tracks daily/weekly
  locally but these are never persisted server-side.
- **Weekly points reset is missing** from `recomputeDerived()`. The client
  accumulates weekly points but never resets them on Monday.
- **Points awarded by `awardPoints()` are never sent to the server.** They live
  in localStorage only. The server's `rug_points` field is only updated via
  `claim_mission_reward` or `award_gameplay_reward` RPCs.

---

## 10. Streak System

**Status: [PARTIAL]**

### What is implemented

- `PlayerProgression.streak: { current, longest, lastActiveDate, multiplier }` —
  defined in types and populated by `ProgressionRepository`.
- `recomputeDerived()` in `ProgressionService` — detects day change, increments
  streak if consecutive, resets to 1 if gap > 1 day. Computes multiplier:
  `min(2.0, 1.0 + (streak.current - 1) * 0.05)`.
- `ProgressionSnapshot.currentStreak` and `streakMultiplier` — exposed for HUD.
- DB: `player_daily_streaks` table (Phase 14) — `current_streak`,
  `longest_streak`, `last_daily_key`.
- DB: `guild_streaks` table (Phase 15) — separate streak for guild contract
  completions.

### What is missing

- **Client streak is localStorage-only.** `player_daily_streaks` table exists
  in the DB but there is no RPC or client code that writes to it. The server
  streak and client streak are completely disconnected.
- **No server-side streak verification** — a player could manipulate
  `lastActiveDate` in localStorage to fake a streak.
- **Multiplier is computed but never applied.** `streakMultiplier` is stored but
  no code in `RewardService` or `ProgressionService` multiplies any reward by
  `streak.multiplier`. The multiplier is purely cosmetic/display currently.
- **No streak bonus notification.** No toast or HUD indicator fires when a
  streak advances.

---

## 11. Mission System

**Status: [COMPLETE — client layer. PARTIAL — server persistence]**

### What is implemented

**Types (`MissionTypes.ts`):**
- 12 `MissionCategory` values (matching spec exactly)
- 14 `ObjectiveKind` values
- 18 `GameplayEventType` values
- Full `MissionDefinition`, `MissionObjectiveDef`, `MissionProgress` types

**Engine (`MissionSystem.ts`):**
- Event-driven, no per-frame polling
- `handleEvent(GameplayEvent)` — dispatches to all objectives of active mission
- All 14 objective kinds implemented: `enter_building`, `talk_town_crier`,
  `visit_landmark`, `interact_landmark`, `talk_npc_role`, `open_panel`,
  `customize_character`, `send_chat`, `use_emote`, `meet_player_or_fallback`,
  `join_city_event`, `party_or_solo_action`, `visit_any_of`, `accept_mission`,
  `walk_distance`
- Sequential mission gating: only the first incomplete mission is "active"
- Persistence: `restoreCompleted()`, `restoreObjectiveCounts()`,
  `getObjectiveCountSnapshot()` — round-trips to localStorage
- `getHighlightedZoneId()` — tells the HUD which zone to highlight

**Bridge (`MissionEventBridge.ts`):**
- Pub/sub pattern, `setActiveMissionBridge` / `getActiveMissionBridge`
- `emitGameplayEvent()` global helper used by WorldScene and GamePage
- Mission system subscribes via `bridge.subscribe()`

**Catalogs:**
- `STARTER_MISSIONS` — 10 missions, total 320 XP, all onboarding
- `LEVEL_TWO_MISSIONS` — exactly 15 missions covering all 12 categories
- `STORY_MISSIONS` — 5 multi-stage story arcs (4 stages each)
- `BRACKET_MISSIONS` — 10 tier-representative missions for levels 11–100
- `PARTY_MISSION_CATALOG` — 5 party missions (confirmed by test assertion)

**Server persistence (`ChapterMissionService.ts` + RPCs):**
- `ensure_chapter_missions` RPC — initialises player's chapter_mission_state rows
- `get_my_chapter_missions` RPC — read state
- `complete_chapter_mission` RPC — SECURITY DEFINER, awards XP/REP, returns
  progression snapshot
- `chapter_mission_state` DB table — fully implemented with RLS (read-only for
  clients)

### What is missing

- **Only Chapter One missions are server-persisted.** Level 2, story arc,
  bracket, and party missions are tracked in `MissionSystem` (localStorage).
  Completing `l2_exp_north_traverse` is not persisted to Supabase.
- **No `mission_completion` server event pipeline** for non-Chapter-One
  missions. The `award_gameplay_reward` RPC exists but is called with broad
  `sourceType` strings, not per-mission-id tracking.
- **`MissionSystem` and `ChapterMissionService` are parallel systems** that do
  not share state. Chapter One missions run through the server RPC. Everything
  else runs through the local `MissionSystem`. There is no unification layer.
- **Mission prerequisites** (`unlocksNext` fields exist in definitions but the
  `MissionSystem` ignores them) — missions unlock sequentially by array order
  only. The `minimumLevel` field is defined but not enforced by `MissionSystem`.

---

## 12. Daily Missions

**Status: [PARTIAL]**

### What is implemented

- `DAILY_MISSION_CATALOG` — 21 daily mission definitions (exceeds the 20
  minimum requirement).
- `pickLocalDaily(playerId, periodKey)` — deterministic UTC-based hash
  selection. Idempotent for the same player + day key.
- `DAILY_ASSIGN_COUNT = 3` — **assigns 3, not 5** (spec calls for 5).
- `utcDailyKey()` — ISO date string, correct UTC basis.
- `ensure_period_missions` RPC (Phase 14) — server-side daily assignment. Wired
  in `RewardService.initForUser()`.
- `claim_mission_reward` RPC — server-authoritative claim with XP/REP/points.
- Daily completion bonus: +40 XP, +8 REP, +12 season points, +15 rug points
  (when all 3 are claimed). Implemented in DB via `rt_claim_daily_bonus`.
- Category variety: catalog includes Exploration, Social, Activity, Landmark,
  Discovery, Challenge, Event-type missions.

### What is missing

- **5 daily missions, not 3.** Spec requires: 1 Exploration, 1 Social,
  1 Mission, 1 Activity, 1 Wildcard. The current system assigns 3 via
  `DAILY_ASSIGN_COUNT = 3` using a hash-pick without category enforcement.
- **No category-guaranteed composition.** The hash-pick selects by score, not
  by ensuring 1 per category. Two Exploration missions could be assigned on the
  same day.
- **No server-side daily reset tracking** tied to the leaderboard. Daily points
  reset client-side but the DB has no `daily_points` column to reset.
- **`daily_completion_bonus` fires at 3 claims**, not 5. The bonus threshold
  must be updated when count changes to 5.

---

## 13. Weekly Missions

**Status: [PARTIAL]**

### What is implemented

- `WEEKLY_MISSION_CATALOG` — 15 weekly mission definitions (exceeds the 15
  minimum requirement).
- `pickLocalWeekly(playerId, periodKey)` — deterministic ISO week key.
- `WEEKLY_ASSIGN_COUNT = 4` — assigns 4 per week.
- `utcWeeklyKey()` — ISO week number format `YYYY-WNN`, correct UTC basis.
- `ensure_period_missions` RPC handles weekly assignments server-side.
- Weekly missions have significant Points rewards (100–150 XP, 16–24 REP,
  32–55 season_points, 40–65 rug_points).
- Weekly completion bonus: +120 XP, +25 REP, +40 season points, +50 rug points.

### What is missing

- **Weekly Points reset is not implemented.** `recomputeDerived()` resets
  `points.daily` on new day but has no equivalent for `points.weekly` on Monday.
- **No server-side `weekly_points` column.** Weekly Points are local-only.
- **No top-3 weekly reward mechanism.** The spec calls for configurable
  in-game rewards for weekly top-3 players. There is no DB table, RPC, or UI
  for this.
- **4 missions assigned, not "approximately 3"** — the spec says ~3 weekly.
  Current value is 4. Minor discrepancy but worth noting.

---

## 14. Hidden Quest System

**Status: [PARTIAL — client complete, no DB backend]**

### What is implemented

- `HiddenQuestDirector.ts` — full class with `processEvent()`, `markCompleted()`,
  `getState()`, `restoreState()`.
- All 5 canonical hidden quests defined with correct trigger types:
  - `hq_empty_chair` — LOCATION trigger (`bench_east`)
  - `hq_forgotten_door` — INTERACTION trigger (`quest-archive-masonry`)
  - `hq_silent_npc` — NPC trigger (`silent_wanderer`)
  - `hq_three_signs` — SEQUENCE trigger (`notice → whale → fountain`)
  - `hq_the_stranger` — TIME trigger (night + `coffee-shop`)
- 6 of 12 trigger types implemented in `processEvent()`:
  `LOCATION`, `INTERACTION`, `NPC`, `SEQUENCE`, `TIME`, and implicit `default`.
- `HiddenQuestDefinition` extends `MissionDefinition` — hidden quests have XP,
  REP, Points, title unlocks.
- State serializes to `{ discoveredIds, completedIds, currentSequenceSteps }`.
- `CANONICAL_HIDDEN_QUESTS` are wired into `MissionTypes.MissionCategory`
  (category: `'hidden'`).

### What is missing

- **No database table for hidden quest state.** `HiddenQuestDirector` state is
  persisted to localStorage only. Clearing browser storage loses all hidden
  quest progress.
- **6 of 12 trigger types not implemented** in `processEvent()`:
  `SOCIAL`, `LEVEL`, `MISSION_COMPLETION`, `EXPLORATION_COMBINATION`,
  `STREAK`, `EVENT`, `COMPOUND`.
- **`HiddenQuestDirector` is not wired into `WorldScene` or `GamePage`.** It
  is defined but there is no call site in the active game session that
  instantiates it, feeds it events, or shows discovery notifications.
- **No "UNKNOWN" state.** Hidden quests are either undiscovered (not in
  `discovered`) or discovered. The spec's 4-state model
  (UNKNOWN / DISCOVERED / IN_PROGRESS / COMPLETED) is not implemented —
  there is only discovered/completed binary.
- **`hq_forgotten_door` target `quest-archive-masonry`** — this landmark ID
  does not exist in `BuildingRegistry` or `WORLD_OBJECTS`. The trigger can
  never fire.

---

## 15. Leaderboards

**Status: [PARTIAL — UI exists, no DB backend for Points leaderboard]**

### What is implemented

- `PointsLeaderboardPanel.tsx` — React component with Daily / Weekly / All-Time
  tabs. Shows player's own rank from `progressionService`. Accessible via the
  'Leaderboard' HUD button (icon '🏆', key 'L').
- Leaderboard entries show: rank, username, level, points. Top-3 get medal icons.
- `get_season_leaderboard` RPC (Phase 10G) — returns ranked rows from
  `season_leaderboard_public` view (season_points based, not daily/weekly points).
- `season_leaderboard_public` view — public read, ranks by `season_points`.
- `RewardService.fetchSeasonLeaderboard()` — calls `get_season_leaderboard`.
- Hall of Fame building — `EnterableBuilding` with `interiorType: 'hall_of_fame'`,
  display name 'Hall of Fame & Leaderboards'. Interior scene exists.

### What is missing

- **No `get_points_leaderboard` RPC.** The panel's comment explicitly says to
  swap NPC seed for this RPC, but it does not exist in any migration.
- **No `points_leaderboard` table or view** for daily/weekly/all-time ranking.
  There is no DB mechanism to rank players by `rug_points` daily or weekly.
- **The panel shows fake NPC data for all non-player entries.** Players see
  themselves ranked against fictional names (WhaleGhost, AlphaAisha, etc.).
- **No weekly top-3 reward mechanism** — no DB table, Edge Function, or cron
  job to identify and reward the weekly top 3 players.
- **Hall of Fame interior** — enterable and has a scene, but the scene renders
  a generic `InteriorScene` room. There is no actual leaderboard display
  inside the building — it's just an empty decorative room.

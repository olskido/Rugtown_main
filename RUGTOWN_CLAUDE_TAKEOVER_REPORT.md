# RugTown Claude Takeover Report — Phase 0 Audit

**Audit date:** 2026-07-08 (session date; repo's own internal doc timestamps run ahead, see note below)
**Audited by:** Claude (senior engineering takeover, Phase 0 — read-only)
**Previous audit:** `RUGTOWN_V2_TAKEOVER_AUDIT.md` (Kiro, dated Aug 17 2026 internally — see dating note)
**Repository:** `C:\Users\Surface\Desktop\Rugtown\Rugtown`
**Branch:** `phase1-refactor` (tracking `rugtown_main/main`, up to date)
**HEAD commit:** `95a3e0f` — "feat: complete RugTown missions buildings progression and quests"
**Package version:** 2.0.0

> **Dating note:** internal doc timestamps in this repo (Kiro's audit, several migration file names) are dated in August 2026, ahead of this session's actual date. This does not affect any technical finding below — it's flagged only so nobody is confused about chronology. All findings in this report reflect the **actual on-disk state at audit time**, i.e. HEAD `95a3e0f` **plus a large amount of uncommitted working-tree changes** (see §0).

---

## 0. How this audit was conducted — read this first

This is not a read of a clean, committed codebase. `git status` shows **26 modified tracked files and ~25 new untracked files/directories**, none staged or committed. This uncommitted work is substantial (net +1,444/-263 lines across the tracked diff alone, plus several entirely new subsystems) and is **not described anywhere** — not in Kiro's audit (which predates most of it), not in any commit message, not in any doc. Every finding below that references "the diff," "uncommitted," or "the working tree" is describing this in-flight, unverified-by-anyone-but-this-audit body of work.

Investigation method: this audit read `RUGTOWN_V2_TAKEOVER_AUDIT.md` in full, read the Phase 16 migration and all progression-adjacent diffs directly, ran `npx tsc --noEmit`, `npm run build`, and all five offline test scripts directly, and dispatched parallel deep-read investigations (buildings/world, mission system, Supabase schema/RLS table inventory, Supabase RPC/function inventory, auth/profile) that each independently read source and cited file:line evidence. Findings from those investigations are folded in below and marked accordingly. No source file, migration, or Supabase project was modified.

**Addendum:** the RPC/function inventory (§17) completed after the rest of this report was first drafted and landed with materially more severe findings than the earlier draft anticipated — several unauthenticated SECURITY DEFINER functions, most seriously one that lets any caller prematurely close a live token-reward epoch with no auth check at all. §17, §22, §24, and §26 have been updated in place to reflect the complete picture; nothing below is speculative or partial anymore.

---

## 1. Existing Architecture

- **Stack:** React 18 + TypeScript 5.3 + Phaser 3.60 + Vite 5, plain CSS. `@supabase/supabase-js` 2.110. `react-router-dom` 6.30. **Zero Solana npm packages** (`@solana/web3.js`/`@solana/spl-token` are used only inside Deno Edge Functions via `esm.sh` imports, never in the client bundle).
- **Repo shape:** mono-package, no workspaces. All app source under `src/`. Database migrations under `database/migrations/` (16 files, manually applied via Supabase SQL Editor — **not** Supabase CLI migrations). Consolidated apply scripts under `database/release/`. A diagnostic-only script exists at `database/diagnostics/inspect_current_supabase_state.sql` (never executed by this audit — see §26 manual steps).
- **No `implementation_plan.md` exists anywhere in the repo.** This is a real gap against the product brief's Part 29 reading list.
- **README.md is severely stale — a real, high-value finding.** It documents an entirely different, earlier version of the product: "30-Level Progression System" (not 100), "Mock Holder tier," DexScreener market panels as a headline feature, "City Rankings" NPC-only leaderboard, and states plainly "**No real wallet**" and "Supabase Email Auth as its **only** account system" — **Google OAuth is not mentioned anywhere in the README.** This is not a minor drift; it describes the pre-pivot product. Anyone onboarding from the README alone would have a materially wrong mental model of the current codebase.
- **Build/test status is objectively clean** (this audit ran these directly, not inherited from any prior claim):
  - `npx tsc --noEmit` → **0 errors**, including across the entire uncommitted diff.
  - `npm run build` → **succeeds**, only benign Rollup chunk-size/dynamic-import warnings (phaser + main bundle >500kB — a real but non-blocking perf note for later).
  - `node scripts/test-session-store.mjs` → pass.
  - `node scripts/test-phase15-1-hardening.mjs` → pass.
  - `node scripts/test-prelaunch-wallet-guild.mjs` → pass.
  - `node scripts/test-staging-supabase-rls.mjs` → gracefully skips (no `STAGING_*` env vars set — by design, safe).
  - `npx tsx scripts/test-gameplay-completion.ts` → pass, including explicit XP-curve-v4/100-level boundary assertions. **Kiro's claim that this test still asserts curve v3 is now false** — the test itself was rewritten as part of the uncommitted work.
  - A live Supabase project exists (`zdffsxlrdelykpkpbokk.supabase.co`, per `docs/supabase/PRODUCTION_READINESS_REPORT.md`, dated well before Phase 15/15.1/16). **This audit did not connect to it** (Phase 0 forbids touching Supabase). That report shows the project was **not production-ready as of its date** (missing table GRANTs, `party_members` RLS infinite recursion) pending a Phase 13C fix. **The actual currently-applied migration state of the live project is unknown** — it could be anywhere from "Phase 13C not yet applied" to "fully caught up through Phase 16." This is a material unknown, not an assumption either way. See §26 manual step.

---

## 2. Antigravity Work Detected

Inherited from Kiro's audit (§3 of that document) — this audit did not attempt to re-attribute authorship independently, since git history has only one flat commit chain with no author-distinguishing markers and all the work in question predates the current uncommitted diff. Kiro's attribution (by architectural coherence, not commit metadata) credits Antigravity with: the entire `src/game/progression/` and `src/game/missions/` directories as they stood pre-diff, `PeriodMissions.ts`, `PointsLeaderboardPanel.tsx`, `UsernameOnboardingPage.tsx`, `AuthCallbackPage.tsx`, `LevelUpToast.tsx`, Phase 13–15.1 migrations, the 100-level `BRACKET_MISSIONS`/`STORY_MISSIONS` catalogs, and the original 5-canonical-hidden-quest `HiddenQuestDirector`. This audit's independent reads of those files are consistent with that attribution (nothing found contradicts it) but did not re-verify authorship itself, which is unknowable from the artifacts available.

---

## 3. Kiro Changes Detected

Kiro is confirmed as the author of `RUGTOWN_V2_TAKEOVER_AUDIT.md` (self-attributed, header line 4). Beyond the audit document itself, **this audit found a large body of additional, uncommitted work that was not present when Kiro's audit was written** (it post-dates or was written alongside the audit — several of the fixes map 1:1 onto gaps Kiro's own document flags). This cannot be attributed with certainty (no commit boundary exists), but is functionally "whatever happened after/alongside the Kiro audit," and is the majority of what this Phase 0 audit had to independently verify:

- `database/migrations/20260817_phase16_100level_progression.sql` — new, untracked. Removes the level-50 CHECK constraint, adds XP curve v4 SQL matching the client, adds `daily_points`/`weekly_points` columns, adds `push_progression_snapshot` (client→server sync RPC), updates `get_rugtown_profile_state`/`get_my_progression`/`award_gameplay_reward` for v4. **This directly targets Kiro's #1 flagged critical gap.**
- `database/migrations/20260813_phase15_1_production_hardening.sql`, `20260813_phase15_prelaunch_wallet_guild_vault.sql` — new, untracked. Guild contracts, vault/holder-tier system, prelaunch hardening (see §7/§16 — this is Solana-adjacent infrastructure, not gameplay progression).
- `src/game/progression/ProgressionRepository.ts`, `ProgressionService.ts`, `types.ts`, `RankLadder.ts`, `XpCurve.ts`, `ProgressionEvents.ts` — modified. Implements `syncToServer()` (previously a stub — **directly targets Kiro's XP/sync gap**), adds `PointsProgress`/`StreakProgress` types, rewrites `RankLadder` to be level-driven (10 tiers, matching the product brief exactly: Citizen→Explorer→...→RugTown Legend), rewrites `XpCurve` to v4/100-level.
- `src/game/missions/DailyWeeklyMissionDirector.ts`, `src/game/missions/definitions/bracketMissions.ts` — new. A correct, category-guaranteed 5-daily/3-weekly implementation, and a 15-mission `LEVEL_TWO_MISSIONS` + 10-mission `BRACKET_MISSIONS` catalog. **Directly targets Kiro's daily/weekly-count gap — but see §11/§12: it was never wired in.**
- `src/components/WalletAuthPage.tsx`, `src/lib/wallet/`, `src/lib/guild/`, `src/lib/vault/`, `src/components/guild/`, `src/components/vault/`, `src/config/guildConfig.ts`, `src/config/rewardConfig.ts`, `supabase/functions/_shared/holder.ts`, `_shared/spl-transfer.ts` — new. Continued build-out of the guild (REP-based, non-blockchain) and vault (Solana holder-tier/token-claim, blockchain) systems. **Important: this is NOT purely "legacy code left alone" — this is active, continued investment in both systems, including the Solana one, contemporaneous with everything else.** See §5 for why this matters.
- Scripts: `test-gameplay-completion.ts` rewritten (+242/-42 lines) for v4; `test-phase15-1-hardening.mjs`, `test-prelaunch-wallet-guild.mjs`, `test-staging-supabase-rls.mjs` — all new.

---

## 4. Current Authentication — **[BROKEN]**

PKCE setup, session restore, guest mode, and the returning-user fast path all work correctly. **The core new-player flow — the single most important behavior this audit was asked to verify — is broken on the live code path.**

Full trace (independently verified, `src/App.tsx`, `AuthPage.tsx`, `AuthCallbackPage.tsx`, `UsernameOnboardingPage.tsx`):

- The onboarding-redirect check (`finishHydration`, `App.tsx:208-236`) only runs from the initial-page-load path and is gated to fire **at most once per mount** via `didRestoreRouteRef`.
- A brand-new Google sign-in causes a **full-page redirect** to Google and back. The return trip is a **fresh SPA mount**. Because the PKCE code hasn't been exchanged yet at that first render, `getSession()` resolves with `session: null`, so `finishHydration('guest', null)` fires immediately and **permanently consumes the one-shot onboarding-check for this mount** before the user is even authenticated.
- The code exchange then happens inside `AuthCallbackPage`, which fires Supabase's `SIGNED_IN` event. The `SIGNED_IN` listener (`App.tsx:261-282`) **never checks onboarding status** — it only branches on `authActionPendingRef`, which is never set for the Google path (`AuthPage.tsx`'s `handleGoogleSignIn` doesn't call `onSignInAttempt()`, unlike the email/password paths).
- Net result: a first-time Google player is routed straight to `/character` → `/play`, **never sees `/onboarding/username`**, and plays permanently under whatever the `handle_new_user` DB trigger auto-generated from their email (with a silent random suffix on any collision, per `schema.sql:217-267`) — exactly the outcome the product brief says must never happen.
- **A separate, previously-unreported bug** compounds this: `/character` re-submits the username on **every login** via `saveUsername()`, which is fire-and-forget (`App.tsx:371-373`, `.catch(() => {})`) and — critically — `profile.ts`'s `saveUsername()` only inspects the RPC transport error, never the RPC's own `{ok: false, reason: 'cooldown'}` response body. A rejected rename (collision or the 14-day cooldown) is silently swallowed and the client proceeds as if it succeeded.
- **What is fixed, for the record:** the exact narrow scenario Kiro's audit described (a returning user with no username deep-linking straight to `/play`) is now handled correctly. Server-side username uniqueness IS enforced and IS surfaced to the player, but only on the `/onboarding/username` page's own submit path — which the primary Google flow never reaches.
- Wallet auth (`/wallet`, `WalletAuthPage.tsx`) is correctly disabled/unrouted for login purposes, matching product direction.
- Email verification is not enforced anywhere (Kiro's finding, unchanged) — lower priority now that Google is the primary path, but the email/password path remains fully live alongside it, not hidden or removed.
- **Manual step required**, not a code gap: Google OAuth needs Supabase-dashboard configuration (provider enable + Client ID/Secret, redirect URL allow-list, Google Cloud Console consent screen out of Testing mode). See §26.

---

## 5. Current Solana Dependencies — **[LEGACY/DEFERRED for login] + [ACTIVE for in-game economy — see contradiction below]**

Login-surface Solana code is correctly deferred, exactly as Kiro found: no wallet npm packages, `/wallet` redirects to `/auth`, `WalletAuthPage.tsx` is unrouted and unreferenced.

**This audit found something Kiro's audit did not catch, and it materially changes the picture:** the in-game token-reward economy is not dormant. `RugTownVaultPanel.tsx` — holder tier, RP multiplier, "Claimable $RUGTOWN," a live "Claim Rewards" button wired to the `claim-rugtown-reward` Edge Function (real SPL transfer, treasury-signed) — is imported and rendered unconditionally in `GamePage.tsx`, and opens when any player interacts with the **`cashback`** world landmark, which is `access: 'open'` in `BuildingRegistry.ts` with no feature flag gating it. This is a default, always-reachable part of the game world, not a hidden or disabled feature.

**This is the same landmark the buildings audit (§15 below) found has been externally relabeled "Quest Archive."** Put together: **a building the UI calls "Quest Archive" still functions, underneath, as the live Solana holder-vault token-claim interface.** A player who walks in expecting quest lore sees a wallet-tier/token-claim panel instead. This is flagged as a contradiction in §22 — it is the single clearest example in this codebase of a rename happening at the display-label layer without the underlying behavior being decoupled, which is the exact opposite of what Part 2 of the product brief asks for ("remove wallet gating from gameplay").

Also newly active (server-side, non-player-facing): `supabase/functions/_shared/holder.ts` (holder-tier thresholds) and `_shared/spl-transfer.ts` (treasury-signed SPL transfer helper) — both new, both continued investment in the Solana settlement pipeline, both correctly kept server-only (no npm wallet deps in the client bundle, no leaked secrets found — see §16).

Separately, the REP-based **Guild** system (`RugTownGuildPanel.tsx`, non-blockchain, opens via the `government` landmark) is also active — this one is fine to keep per product direction (no tokens involved), but see §15/§18 for why "government → Guild panel" is not the same thing as "government → Mission HQ."

---

## 6. Current Profile / Username System — **[BROKEN]**

See §4 for the primary finding (silent auto-generated username on first Google login, silent rename-rejection on every subsequent login). Server-side uniqueness enforcement genuinely exists and works correctly for the one path that reaches it (`create_rugtown_profile` RPC via `/onboarding/username`). The `handle_new_user` DB trigger's silent-suffix behavior (unchanged since Kiro's audit) is the root cause underneath both bugs. A Phase-15 migration backfill (`UPDATE profiles SET onboarding_completed = true WHERE ... username IS NOT NULL`) also permanently locks out any pre-Phase-15 account from ever seeing the onboarding picker, regardless of whether their username was a real choice or an auto-generated one.

---

## 7. Current REP System — **[PARTIAL, with a newly-found CRITICAL security gap]**

`profiles.rep` is the canonical field, protected by the `profiles_protect_reward_columns` trigger (blocks direct client writes unless a SECURITY DEFINER RPC sets a mutation flag) since Phase 10G. `award_gameplay_reward`, `complete_chapter_mission`, `claim_mission_reward`, `claim_guild_contract` all correctly gate REP writes.

**New finding, not in Kiro's audit:** two other columns that function as reward/anti-cheat-relevant state are **not** in that trigger's protected list and are directly client-writable via the standard owner-UPDATE policy on their tables:
- `profiles.holder_tier` — any authenticated player can `UPDATE profiles SET holder_tier = 'Gold' WHERE id = auth.uid()` directly. No RPC involved.
- `player_daily_streaks.current_streak` / `longest_streak` — has an explicit, unrestricted owner-UPDATE RLS policy (`"daily_streaks: owner update"`, Phase 14) with no column guard and no protective trigger (unlike `profiles.rep`). Directly writable, and surfaced to the client via `get_rugtown_profile_state()`.
- Also newly unprotected: `profiles.social_restricted_until` (a muted player can un-mute themselves) and `profiles.username_changed_at` (bypasses the 14-day rename cooldown).

These are all listed with exact file:line evidence in §16/§18. They are cheap, surgical fixes (add columns to an existing trigger allowlist / add a similar trigger to one more table) — recommended as an immediate pre-Phase-1 hotfix in §26, not deferred to "later."

REP is still not separately leaderboard-ranked (leaderboard ranks by Points/REP inconsistently depending on which of the two leaderboard UIs you're looking at — see §14).

---

## 8. Current XP / Level System — **[MOSTLY FIXED, pending live-DB verification, with one trust gap]**

Kiro's #1 critical finding (client goes to 100, DB capped at 50) has a real, well-written fix sitting in the uncommitted `Phase 16` migration: constraint raised to 100, `rt_xp_required_for_level_v4`/`rt_recompute_level_v4` match the client's formula exactly, a grandfathering migration ensures no player's level can decrease, and all award RPCs route through the v4 dispatcher with an explicit `least(level, 100)` cap. The client `syncToServer()` stub Kiro flagged as a no-op is now implemented and calls `push_progression_snapshot`, debounced to fire at most once per 10s during play plus an explicit flush on unload/logout.

**What is NOT yet true:**
- **This migration has not been applied to the live Supabase project** (unverifiable by this audit — see §1/§26). Until it is, every one of these fixes is inert in production.
- **`push_progression_snapshot` has a real anti-cheat gap**, flagged independently by the Supabase/RLS investigation: it accepts client-declared `lifetime_xp`/`rep`/`points_*` values and does `greatest(server_value, client_value)` with **no delta cap, no rate limit, and no correlation to a trusted receipt/session**. A single malicious call can permanently set a player's XP, REP, and lifetime Points to an arbitrary large number. This directly undercuts Part 6's "server must be authoritative, client must not determine the reward" principle, despite being nominally an RPC-gated write path. This is the most important single finding in this report from a security standpoint and should be fixed before this migration is applied to production.

---

## 9. Current Points System — **[PARTIAL]**

`daily_points`/`weekly_points` columns and UTC-boundary period-reset logic (`rt_reset_period_points_if_needed`) are new in Phase 16 and correctly designed (reset-guard prevents a stale client snapshot from "un-resetting" a period). Client-side daily/weekly/lifetime tracking, `awardPoints()`, and streak-driven multiplier display all exist. **No `get_points_leaderboard` RPC and no points-ranking table/view exist anywhere in the 16 reviewed migrations** — Kiro's finding here is unchanged and independently reconfirmed. `season_leaderboard_public` (season_points-based) is the only ranking view that exists, and it is not the same metric.

---

## 10. Current Mission System — **[PARTIAL]**

Engine mechanics (event-driven dispatch, all 14 original `ObjectiveKind`s, sequential completion, localStorage round-trip persistence) remain solid. Real new content was wired in during the uncommitted work: `bracketMissions.ts`'s `LEVEL_TWO_MISSIONS` (15, all 12 categories) and `BRACKET_MISSIONS` (10, levels 11–100) are now genuinely spliced into `MissionSystem`'s live definitions list (previously only `STARTER_MISSIONS + STORY_MISSIONS`).

Real, independently-verified problems:
- **There are four parallel mission systems with zero shared state**: `MissionSystem` (local, event-driven), `ChapterMissionService` (server RPC, Chapter One only), `PeriodMissions.ts` (server RPC, daily/weekly), and the new `DailyWeeklyMissionDirector` (fully built, entirely unused — see §11).
- `minimumLevel` and `unlocksNext` are declared on every new mission (real data: values 2 through 100) but **never read by any application logic** — `MissionSystem.getActiveDefinition()` is still pure array-order. This was a cosmetic gap before; it's now a live, reachable bug because real level-gated content exists.
- `MissionCategory` grew to **29 values**, not 12 — the original 12 lowercase categories plus a fully duplicate uppercase set (`'EXPLORATION' | 'SOCIAL' | ...`) that is never actually assigned anywhere in any mission literal. Dead type surface, but it means "12 categories, unbroken" (Kiro's claim) no longer holds.
- `ObjectiveKind` grew to 15 (`hidden_discovery` added) but that new kind is never handled in `MissionSystem`'s switch — declared, non-functional.
- Several new `bracketMissions.ts` objectives target building IDs that don't exist in `EnterableBuildings` (`mission_hq`, `quest-archive`, `challenge-arena` vs. the real `government`/`holder-cashback-vault`/`future-arena`), making those specific missions permanently uncompletable.
- No hardcoded mission definitions were found embedded in any `.tsx` component — the data-driven-catalog discipline the product brief asks for is genuinely being followed.

---

## 11. Current Daily Missions — **[PARTIAL — correct fix exists as dead code]**

`DailyWeeklyMissionDirector.getDailyMissions()` is a **fully correct, spec-compliant implementation**: exactly 5 missions, one guaranteed from each of Exploration/Social/Mission/Activity/Wildcard pools. **It is imported by nothing.** The system actually wired into the running game — `PeriodMissions.ts`, called via `RewardService.initForUser()` from `GamePage.tsx` — is byte-for-byte unchanged: `DAILY_ASSIGN_COUNT = 3`, hash-picked, no category guarantee. **A player playing the game today still gets 3 daily missions, not 5.** This is the cheapest, highest-value fix available in the entire codebase: the correct logic already exists and just needs to be wired in place of (or to replace) `PeriodMissions.ts`'s pick logic, then a matching server-side RPC update for `ensure_period_missions`.

---

## 12. Current Weekly Missions — **[PARTIAL — same pattern as daily]**

`DailyWeeklyMissionDirector.getWeeklyMissions()` correctly returns exactly 3 hard missions (matching the product brief's "approximately 3," a change from Kiro's audit which flagged 4 as a "minor discrepancy"). Also unused — live system (`PeriodMissions.ts`) still assigns 4, unchanged.

---

## 13. Current Hidden Quests — **[PLANNED-ONLY]**

No DB table or RPC exists for hidden quest state (confirmed against all 16 migrations, including the 3 newest ones — no `hidden_quest`/`quest_state` table anywhere). `HiddenQuestDirector` is not imported or instantiated anywhere in `GamePage.tsx` or `WorldScene.ts` — it is completely disconnected from the running game, confirmed by a repo-wide grep returning only the file itself. Only 5 of 12 trigger types are implemented (`LOCATION`, `INTERACTION`, `NPC`, `SEQUENCE`, `TIME` — though the `TIME` branch doesn't actually check time-of-day, only location, so it's mislabeled). **All 5 canonical hidden quests target landmark/NPC IDs that don't exist anywhere in the world registries** (`bench_east`, `quest-archive-masonry`, `silent_wanderer`, `mysterious_stranger`) — except `hq_three_signs`, whose three targets (`notice`, `whale`, `fountain`) are real. Even if this system were wired in today, 4 of 5 quests could never trigger. This entire system needs the wiring, the DB layer, the remaining 7 trigger types, and corrected target IDs before it does anything for a player.

---

## 14. Current Leaderboard — **[PARTIAL/BROKEN]**

Two separate, non-communicating leaderboard UIs exist:
- `PointsLeaderboardPanel.tsx` — has Daily/Weekly/All-Time tabs, reads local `progressionService` state, fills all other rows with **hardcoded NPC seed data** (explicit code comment says to swap in `get_points_leaderboard`, which doesn't exist — see §9). **This component is imported once in `GamePage.tsx` and never rendered anywhere in JSX** — it's dead code.
- The actual working "Leaderboard" HUD panel (a separate, hand-built inline block in `GamePage.tsx`) is **REP-based, not Points-based**, and its Daily/Weekly/All-Time tabs are **cosmetically present but functionally identical** — selecting a different tab does not change the displayed data.
- No leaderboard is reachable from inside the Hall of Fame building's interior — the only physical/world-integrated touch is three exterior podium statues (`WorldScene.setHallOfFameStatues()`) near the landmark, fed by local session data.
- No `get_points_leaderboard` RPC, no ranking table/view for daily/weekly/all-time Points, no weekly top-3 reward mechanism anywhere in the schema.

---

## 15. Current Buildings — **[PARTIAL]**

Full building-by-building detail from the dedicated buildings/world investigation:

| Old name | Enterable? | Interior | Notes |
|---|---|---|---|
| Government Quarter → Mission HQ | **NO** — absent from `ENTERABLE_BUILDINGS`/`InteriorType` | N/A | The `access` flag was flipped to `'open'` in `BuildingRegistry.ts`, but that field is functionally inert (only read by a dev debug snapshot). The real gate, `ENTERABLE_BUILDINGS`, still excludes it. Opening the building via proximity-interact instead opens `RugTownGuildPanel` (REP contracts) — narrower than the full Mission HQ vision in Part 18 (no mission list, no daily/weekly view, no progression display, no chain view live at this location). |
| Cashback Vault → Quest Archive | YES (enterable) | Generic placeholder room, zero quest content | **See §5/§22 — this building's interact-panel is still the live Solana `RugTownVaultPanel`, not quest content.** `WorldObjects.ts` (feeds the world-map floating label + minimap icon) was never updated for this building — still shows "Holder Cashback Vault" with a 🔒 icon, while the door prompt says "Quest Archive." Three different names on three different UI surfaces for the same building. |
| Hall of Fame | YES | Cosmetic decor + one flavor line, no leaderboard UI inside | See §14 |
| Future Arena → Challenge Arena | YES | Generic placeholder | `BuildingRegistry.ts`'s `arena` entry still says `access: 'coming_soon'` (stale/unused field, harmless but confusing) |
| Coffee Shop → Social Hub | YES | Cosmetic decor + one flavor line | Working as a landmark; no dedicated social-mission content beyond generic mission catalog entries |
| Alpha Lounge → Alpha Club | YES, unconditionally | Cosmetic decor | **Never actually renamed** — `WorldObjects.ts` and `EnterableBuildings.ts` both still say "Alpha Lounge (Level 30+)." Only `GamePage.tsx`'s internal `ZONE_INFO` dict says "Alpha Club." The "Level 30+" gate is cosmetic text only, not enforced. |

World coordinates and collision data are confirmed untouched by the uncommitted diff (every changed line across all three world-registry files is a string field — display name, description, icon, access flag — never x/y/radius/width/height).

**Systemic issue:** building identity is scattered across **four independent name-holding sources** (`WorldObjects.ts` for world-map labels, `BuildingRegistry.ts` for the registry/debug view, `EnterableBuildings.ts` for the interior gate, `GamePage.tsx`'s `ZONE_INFO` for the interact-modal) that have drifted out of sync with each other. `ZONE_INFO` is the most complete and correct source of the *intended* end-state naming; the other three have not caught up to it.

---

## 16. Current Supabase Schema — **[PARTIAL, well-structured overall, several real gaps]**

150 tables across `schema.sql` + 16 migrations. Every single table has RLS enabled (verified exhaustively — no table lacks `ENABLE ROW LEVEL SECURITY`). A blanket `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO anon, authenticated` was applied in Phase 13C (a normal PostgREST/RLS pattern — RLS is meant to be the only real gate from that point on, but it does mean every RLS gap below is *immediately* exploitable with no additional privilege needed, and any future table that forgets to enable RLS would be a full read/write hole). No service-role or JWT secrets found prefixed `VITE_` in `.env.example` — that boundary is respected.

The overwhelming majority of reward/mission/social/party/guild/tournament/world-event tables follow the correct pattern: either **no client policy at all** (fully server/RPC-gated) or **owner-SELECT-only** (no client write policy, mutations exclusively through SECURITY DEFINER RPCs). This is a well-executed, consistent architecture for the vast majority of the schema.

**Real exceptions found (see §7 for two of these already, repeated here for completeness):**
- `profiles.holder_tier` — directly client-writable (no protective trigger, standard owner-UPDATE policy applies).
- `player_daily_streaks.current_streak`/`longest_streak` — directly client-writable (explicit owner-UPDATE policy, no trigger).
- `profiles.social_restricted_until` — self-clearable by a muted player.
- `profiles.username_changed_at` — self-resettable, bypassing the 14-day rename cooldown.
- `player_badges`, `player_inventory`, `district_unlocks` (all from the original `schema.sql`, pre-dating the Phase 10G+ RPC-gated architecture) — still `FOR ALL` owner policies, meaning a player can self-grant badges/inventory items/district unlocks by direct table write. Not confirmed to be wired into the active reward economy today, but the write surface is live.
- `push_progression_snapshot` (Phase 16) — see §8, the max-wins-trusts-client design.

Several tables/columns are also flagged as apparently unused/dead (`guild_join_requests`, `guild_message_reads`, `guild_announcements`, `guild_activity_events`, `party_activity_events`, and others) — no RPC in the reviewed migrations reads or writes them. Not a bug, but worth pruning eventually to reduce audit surface.

---

## 17. Current RPCs — **[EXHAUSTIVELY SWEPT — 214 functions across 16 migrations, real findings]**

A complete function-by-function pass was run: every `CREATE OR REPLACE FUNCTION` in all 16 migration files, checked for `SECURITY DEFINER`, `SET search_path`, `auth.uid()` scoping, idempotency, and (where a function was redefined more than once) whether later redefinitions changed access control or introduced drift.

**Category 1 — missing `SET search_path`: none found.** Every `SECURITY DEFINER` function that touches a table correctly sets `search_path = public`. This is a genuinely well-disciplined area of the codebase — no privilege-escalation-via-search_path risk anywhere in the schema.

**Category 2 — missing or broken `auth.uid()` scoping: real and numerous.** Two sub-patterns:

*2A — no auth check at all, and no `REVOKE ALL FROM PUBLIC` either (default-executable by any `anon`/`authenticated` caller, since Phase 13C's blanket schema-USAGE grant makes this concretely exploitable, not theoretical):*

- **`rt_finalize_reward_epoch(p_epoch_id)`** — defined in both `phase15_prelaunch_wallet_guild_vault.sql:388` and (the version actually live, applied after) `phase15_1_production_hardening.sql:154`. **Zero auth check in either version, and not `REVOKE`d.** Any caller can prematurely finalize/close the current token-reward epoch before it naturally ends — and the current epoch's ID is trivially discoverable via the self-service `get_reward_vault_state()` RPC. **The single most severe access-control finding in this audit** — it lets anyone disrupt the on-chain reward-payout pipeline for the whole playerbase at will.
- **`rt_grant_title(p_player, p_title_id, p_source_type, p_source_id)`** — `phase10i_achievements_season_pass_analytics.sql:728`. No auth check, no ownership check, arbitrary `p_player`, never patched in any later migration. Lets anyone grant themselves (or anyone else) any title in the catalog for free, auto-equipped.
- **`rt_resolve_auth_wallet(p_user_id)`** — `phase15_prelaunch_wallet_guild_vault.sql:298`. SECURITY DEFINER read into the privileged `auth.users`/`auth.identities` tables plus `profiles.wallet_address`/`verified_wallets`, for an arbitrary `p_user_id`. Discloses any player's linked wallet address given only their profile UUID. PII/deanonymization risk, not `REVOKE`d anywhere.
- **`rt_is_blocked(a, b)` / `rt_are_friends(a, b)`** — `phase10j_social_identity_moderation.sql:478,487`. Bypass their tables' owner-only RLS for arbitrary player pairs — a relationship-status privacy leak.
- A cluster of similar-severity ungated helpers in `phase10i`/`phase10j`, all missing `REVOKE ALL FROM PUBLIC`: `rt_analytics_event`, `rt_prog_history`, `rt_rule_value` (arbitrary-player progression read), `rt_seed_achievement` (content injection), `rt_raise_alert` (log injection), `rt_social_restricted`, `rt_social_audit`, `rt_social_analytics`, `rt_check_rate_limit` (lets an attacker pre-burn a victim's rate-limit budget), `rt_ensure_profile_settings`. Contrast: the equivalent internal helpers in `phase10k`/`phase10l` (parties/guilds, written later) correctly batch-`REVOKE ALL FROM PUBLIC` — this defensive pattern simply wasn't applied consistently to the earlier files.
- **`rt_notify`** (`phase10h:618`) had this exact defect originally, and it was **caught and explicitly fixed** in `phase10j:7-9` with an acknowledged commit-style comment ("Critical fix: revoke public rt_notify (Phase 10H spoof vector)") — proof the pattern is understood by whoever wrote these migrations, just not applied everywhere.

*2B — auth check present but logically inverted (fails open on `auth.uid() IS NULL` instead of rejecting):*

- `enqueue_achievement_evaluation`, `evaluate_player_achievements` (**mints real XP/REP/title rewards** — highest-impact of this group), `grant_season_pass_points`, `evaluate_party_shared_mission` all use `IF auth.uid() IS NOT NULL AND auth.uid() <> p_player_id AND NOT operator THEN RAISE EXCEPTION` — when `auth.uid()` is NULL, the whole condition is false and the check silently passes instead of rejecting. Correct form is `IF auth.uid() IS NULL OR (...) THEN`. Practical risk is reduced by these being granted only to `authenticated` (never `anon`), but the logic is wrong regardless and should be fixed on principle.
- `evaluate_season_pass_progress` (`phase10i:1138`) is worse — no ownership/operator check at all, any authenticated user can force recomputation/notification-spam against any other player.

**Category 3 — redefined across files with meaningfully different access control (confirms real vulnerabilities existed and some were fixed, some weren't):**

- `create_dev_claim`: originally grantable by any authenticated user (`phase10g:983`); fixed in `phase10h:999` to require operator role — a self-documented, confirmed-real fix.
- `refresh_holder_status`: the **original** (`phase15_prelaunch:1101`) trusted a client-supplied token balance directly (its own comment says "DEV ONLY: trusts client-reported balance"), letting any player self-assign the top "whale" reward multiplier. **Fixed** in `phase15_1:120`, which ignores the parameter entirely. Genuinely fixed — but only if `phase15_1` is actually applied after `phase15_prelaunch` in the live project (see the file-ordering trap noted in §22).
- `rt_recompute_level(bigint)` — the single-arg level-from-XP function — was redefined **four times** across phase10g→13→14→16 as the XP curve version advanced (v1→v2→v3→v4). Most callers stay in sync via a parallel 2-arg dispatcher, **except `migrate_local_progression`**, which still hardcodes a direct call to `rt_recompute_level_v2` and was never updated. A guest-to-authenticated account migration happening today computes the player's grandfathered level on the **old v2 curve** while every other reward path uses v4 — a real, live cross-function inconsistency.
- `activate_token_integration` (`phase10mnpqs:89`) gates on `rt_is_social_operator('admin')`, but that helper only recognizes `'support'/'moderator'/'senior_moderator'/'administrator'` — `'admin'` isn't a valid value, so the gate is permanently, unconditionally false for every caller. Fails safe (nobody can call it, including intended operators) rather than exploitably — a correctness bug, not a vulnerability, but worth knowing before anyone wonders why token-integration activation "doesn't work."

**Category 4 — `push_progression_snapshot` (already flagged in §8/§16/§22), now independently confirmed by this sweep as well.** It has the *correct* shape on paper — `SECURITY DEFINER`, `SET search_path`, a correct `auth.uid()` check, and a correct `REVOKE ALL FROM PUBLIC + GRANT authenticated` — which is exactly why it's dangerous: nothing about its permissions looks wrong on a shallow read. The actual problem is purely behavioral (see §8) and this sweep's assessment agrees with the earlier RLS investigation's: **this is likely the single most exploitable vulnerability in the codebase**, since it directly inflates `rug_points`, which feeds the real token-payout pipeline.

Idempotency across the ~214 functions reviewed is otherwise strong — the overwhelming majority of reward/mission/social/party/guild functions use `ON CONFLICT DO NOTHING`/`ON CONFLICT ... DO UPDATE` keyed by an idempotency key, a status short-circuit, or a `FOR UPDATE` row lock, consistent with the well-executed ledger architecture noted in §16.

---

## 18. Current RLS — See §16 for table-level RLS and §17 for function-level access control. Summary verdict: **structurally sound at the schema-design level (100% RLS coverage, correct ledger/idempotency architecture, no search_path issues), with a specific, enumerable, fixable set of access-control holes concentrated in a few files** — 5 table-level RLS gaps (§16) plus roughly 20 function-level gaps (§17, dominated by two files: `phase10i` and `phase10j`'s earliest helper functions, plus the two `phase15`/`phase16` functions handling reward-epoch closure and progression sync). This is not a systemic architecture problem; it's a consistency-of-application problem, and the fix pattern (`REVOKE ALL FROM PUBLIC` + explicit auth check) is already used correctly elsewhere in the same codebase (`phase10k`/`phase10l`), so remediation is mechanical, not a redesign.

---

## 19. Current Edge Functions — **[PARTIAL]**

16 functions total. Independently re-verified against Kiro's audit:
- **`send-direct-message` has no `index.ts`** — confirmed, matches Kiro's finding, still broken.
- **New finding, not in Kiro's audit: `social-safety-check` also has no `index.ts`.** Two functions are non-deployable stubs, not one.
- 8 functions are Solana-related (`claim-rugtown-reward`, `create-wallet-verification-challenge`, `refresh-holder-status`, `verify-wallet-signature`, `submit-reward-settlement`, `verify-reward-settlement`, `retry-reward-settlement`, `revoke-verified-wallet`) — all still deployed/live per Kiro's original classification; this audit did not independently re-verify deployment status (that requires live Supabase access, out of scope for Phase 0).
- Two new shared helpers (`_shared/holder.ts`, `_shared/spl-transfer.ts`) — server-only, Solana-related, consistent with continued build-out noted in §3/§5.

---

## 20. Current Tests — **[COMPLETE, all passing]** — see §1 for the full run log. This is a genuine bright spot.

## 21. Current Build Status — **[COMPLETE, clean]** — see §1.

---

## 22. Contradictions Found

1. **"Quest Archive" building still runs the live Solana vault-claim UI.** The building's world-map label, door prompt, and interior room all disagree on what this building even is (§5, §15), and none of the three match what actually opens when you interact with it.
2. **The onboarding-username fix and the underlying bug it was meant to close are simultaneously present.** The exact scenario Kiro described is fixed; a more central, more damaging variant of the same class of bug (new Google users skip onboarding entirely) was introduced/left in the same body of work, on the primary signup path. See §4.
3. **Two fully-built, correct implementations of 5-daily/3-weekly missions exist and are entirely disconnected from the live game**, which still runs the old 3-daily/4-weekly logic. The "fix" and the "bug" coexist in the same commit-in-progress, on different files, with nothing wiring them together.
4. **`MissionCategory` has 29 members for a "12-category" system** — a full duplicate uppercase union sits alongside the real 12 (now more like 12 renamed) lowercase ones, unused but present, which will confuse any future contributor who greps for "how many categories are there."
5. **`push_progression_snapshot` is architecturally "server-authoritative" (an RPC, SECURITY DEFINER, gated by auth.uid()) while behaviorally trusting client-declared values** via unconditional max-wins merge with no rate limit or delta cap — this satisfies the letter of Part 6's "server writes the mutation" requirement while violating its spirit ("client must not determine the reward").
6. **Building identity is defined in four different files that disagree with each other** (§15) — most visibly Alpha Lounge, which was never actually renamed to Alpha Club anywhere except one internal display dictionary.
7. **The README describes a different product** (30-level, no Google OAuth, DexScreener-headline, "no real wallet") than the one in the repository (100-level, Google OAuth primary, Solana vault live in-world). This isn't a code contradiction, but it is a documentation-vs-reality contradiction serious enough to actively mislead anyone using it as a reference.
8. **The filename order and the actual apply order of the two Phase 15 migrations are reversed**, and this is not cosmetic: `phase15_1_production_hardening.sql` sorts and reads first alphabetically, but its own header says it must be applied *after* `phase15_prelaunch_wallet_guild_vault.sql` — and `phase15_1`'s version is the one that actually fixes `refresh_holder_status`'s client-trusted-balance bug (§17). Anyone reviewing these files in filename order (as this audit initially did, and as any future engineer naturally would) can easily mistake the vulnerable original for a discarded draft rather than the version that ships first. The same reversed-precedence trap affects `rt_finalize_reward_epoch`, `claim_epoch_reward`, `claim_guild_contract`, and `get_reward_vault_state`, all defined in both files.

## 23. Duplicate Systems Found

- **Four parallel mission-tracking systems** with zero shared state (`MissionSystem`, `ChapterMissionService`, `PeriodMissions.ts`, `DailyWeeklyMissionDirector`) — §10/§11/§12.
- **Two leaderboard UI components** (`PointsLeaderboardPanel.tsx`, dead; the inline HUD panel, live but REP-based) — §14.
- **`MissionCategory`'s duplicate uppercase/lowercase union** — §10/§22.
- No duplicate database tables, no duplicate RPCs with divergent behavior, and no duplicate authentication system were found — the schema/RPC layer does not have this problem; it is specifically a client-side/mission-layer problem.

## 24. Broken Systems

- New-Google-player onboarding flow (§4) — **highest priority, this is the core signup experience.**
- Silent username-save failures on every `/character` visit (§4/§6).
- Mission HQ (not enterable; the missions written to target it can never be completed) (§10/§15).
- Hall of Fame leaderboard (fake tab data, no physical leaderboard display, dead Points panel) (§14).
- `send-direct-message` and `social-safety-check` Edge Functions (no deployable code) (§19).
- Five specific RLS/trigger gaps enabling direct client mutation of `holder_tier`, streak counts, moderation-restriction status, and username-cooldown state (§7/§16).
- `push_progression_snapshot`'s unlimited trust-the-client merge (§8/§17/§22) — independently confirmed by two separate investigations as the most exploitable single vulnerability in the codebase.
- **`rt_finalize_reward_epoch` — zero auth check, anyone can prematurely close the live token-reward epoch** (§17). The single most severe finding in this entire audit.
- **`rt_grant_title` — zero auth check, anyone can grant themselves any title for free** (§17).
- **`rt_resolve_auth_wallet` — zero auth check, discloses any player's linked wallet address** (§17).
- ~15 more SECURITY DEFINER functions in `phase10i`/`phase10j` missing `REVOKE ALL FROM PUBLIC` (arbitrary-player analytics/audit-log forgery, relationship-privacy leaks, rate-limit griefing) plus 4 NULL-auth-bypass logic bugs, one of which (`evaluate_player_achievements`) can mint real XP/REP/title rewards for an arbitrary player (§17).
- `migrate_local_progression` permanently stuck computing grandfathered level on the old v2 XP curve while every other reward path is on v4 (§17/§22) — a live logic-drift bug, not a security hole.

## 25. Missing Systems

- `get_points_leaderboard` RPC + any daily/weekly/all-time Points ranking mechanism (§9/§14).
- Hidden quest DB persistence, the remaining 7/12 trigger types, and any wiring into the running game at all (§13).
- Weekly top-3 reward mechanism (no table, RPC, or scheduled job found anywhere).
- A real Mission HQ (the actual "view missions/progression/chains" hub described in Part 18 — currently just a REP-contract panel, and not even reachable via the building).
- `implementation_plan.md` (does not exist).

## 26. Recommended Implementation Order

The product brief's Phase 1–12 structure (from the master instruction) remains the right shape. This audit's addition is sequencing *within* that structure based on what's cheap-and-already-built versus what's genuinely unstarted, plus one new phase inserted before Phase 1 for the security findings, since they're small, self-contained, and independent of everything else:

- **Phase 0.5 (new, recommend before Phase 1 — small, surgical, high-value — revised after the full RPC sweep landed):** this phase grew once §17 completed, and should now be treated as the actual first priority, ahead of anything else in this list, because it's cheap (every fix below is `REVOKE`/`GRANT`/an added `IF` check — no new tables, no architecture change) and because one item (`rt_finalize_reward_epoch`) can disrupt the live token-payout pipeline for every player at any time until it's closed:
  1. **`rt_finalize_reward_epoch`** — add an auth/operator check. Top priority in the whole report.
  2. **`push_progression_snapshot`** — add an upper bound / rate limit / plausibility check on client-declared XP/REP/Points instead of unconditional max-wins (§8/§17).
  3. **`rt_resolve_auth_wallet`** — add `REVOKE ALL FROM PUBLIC` + an ownership/operator check.
  4. **`rt_grant_title`** — add `REVOKE ALL FROM PUBLIC` + an ownership/operator check.
  5. Apply the same `REVOKE ALL FROM PUBLIC` pattern (already used correctly elsewhere in this same codebase, e.g. `phase10k`/`phase10l`) to the ~15 remaining ungated `phase10i`/`phase10j` helpers listed in §17.
  6. Fix the NULL-auth-bypass boolean logic in `enqueue_achievement_evaluation`, `evaluate_player_achievements`, `grant_season_pass_points`, `evaluate_party_shared_mission`, `evaluate_season_pass_progress` (§17).
  7. Close the 5 table-level RLS/trigger gaps from §7/§16 (add `holder_tier`, `social_restricted_until`, `username_changed_at` to the existing `profiles_protect_reward_columns` trigger; add an equivalent trigger or RPC-only policy to `player_daily_streaks`).
  8. Fix `migrate_local_progression` to call the current curve-version dispatcher instead of a hardcoded `rt_recompute_level_v2` (§17/§22).
- **Phase 1 (Auth):** the pieces mostly exist — this phase is a *fix*, not a build. Fix the OAuth-completion race described in §4 (make the `SIGNED_IN` listener, not just `finishHydration`, check onboarding status — or restructure so the callback page itself performs the check after `exchangeCodeForSession` resolves, before any navigation happens). Fix `saveUsername()` to actually surface `{ok:false}` responses instead of swallowing them.
- **Phase 2 (100-level progression):** essentially done pending (a) applying the Phase 16 migration to the live project after confirming its actual current state via `database/diagnostics/inspect_current_supabase_state.sql`, and (b) the Phase 0.5 fix to `push_progression_snapshot`.
- **Phase 3 (Authoritative REP/XP/Points):** mostly done at the mechanism level; needs the Phase 0.5 fixes plus deciding what to do about the always-open Solana vault contradiction in §5/§22 (this is a product decision, not just an engineering one — flag it to the user before Phase 3 work proceeds).
- **Phase 4 (Leaderboards):** genuinely unstarted at the DB layer — needs `get_points_leaderboard` + a ranking mechanism, then reconciling the two competing leaderboard UIs into one.
- **Phase 5/6 (Daily/Weekly missions):** the cheapest phase in the whole plan — `DailyWeeklyMissionDirector` already does the right thing, it just needs to replace (or be wired ahead of) `PeriodMissions.ts`'s pick logic, plus a matching `ensure_period_missions` update server-side.
- **Phase 7 (Level-gated mission catalogue):** wire `minimumLevel`/`unlocksNext` into `MissionSystem.getActiveDefinition()` — the data already exists (§10), it's just never read. Also fix the bracket-mission target IDs that point at nonexistent buildings.
- **Phase 8 (Hidden quests):** the least-started system relative to its ambition — needs DB tables, the missing 7 trigger types, real wiring into `WorldScene`/`GamePage`, and corrected target IDs for 4 of 5 existing quests.
- **Phase 9 (Building repurposing):** mostly a naming/consistency pass across the four drifted source files (§15), plus making Mission HQ actually enterable, plus resolving the Quest Archive/Vault identity conflict (§22) — likely the single most product-sensitive decision in this whole audit.
- **Phase 10 (Weekly competition/rewards):** blocked on Phase 4 (no leaderboard to rank against) — do after.
- **Phase 11 (Anti-abuse/security hardening):** with the full RPC sweep now already done (§17) and its urgent items pulled forward into Phase 0.5, what's left for this phase is lower-urgency cleanup: a fresh look at `player_badges`/`player_inventory`/`district_unlocks`'s legacy `FOR ALL` policies (§16) to confirm they're truly dead or lock them down, pruning the confirmed-unused tables noted in §16, and re-running a verification pass on the Phase 0.5 fixes once they've been live for a while.
- **Phase 12 (Production QA):** should explicitly include the README rewrite (§1) as a checklist item — it's not code, but it's actively misleading in its current state and costs nothing to fix once the architecture stabilizes.

### Manual steps required (per Part 27 — none of these were or should be performed by this audit)

| What | Where | Value/setting | How to verify |
|---|---|---|---|
| Determine actual applied-migration state of the live Supabase project | Supabase SQL Editor, run `database/diagnostics/inspect_current_supabase_state.sql` | N/A — diagnostic only | Compare output against `docs/supabase/CURRENT_MIGRATION_APPLY_ORDER.md` and the Phase 16 migration's own verification queries (bottom of that file) |
| Apply Phase 16 migration (only after Phase 0.5 fixes are added to it) | Supabase SQL Editor | Paste `database/migrations/20260817_phase16_100level_progression.sql` (amended) | Run its own built-in verification `SELECT`s |
| Enable Google OAuth provider | Supabase Dashboard → Authentication → Providers → Google | Client ID + Client Secret from Google Cloud Console | Test sign-in from `/auth` |
| Add Google Cloud OAuth redirect URI | Google Cloud Console → OAuth 2.0 Client | `https://<project-ref>.supabase.co/auth/v1/callback` | Sign-in completes without a Google-side redirect error |
| Configure Supabase redirect URL allow-list | Supabase Dashboard → Authentication → URL Configuration | Site URL + both `http://localhost:3000/auth/callback` and the production origin's `/auth/callback` | Sign-in redirects back into the app instead of erroring |
| Take Google OAuth consent screen out of Testing mode | Google Cloud Console → OAuth consent screen | Publish or add real test users | Non-whitelisted Google accounts can sign in |
| Confirm `player_epoch_rewards`/Solana settlement pipeline's actual production intent | Product decision, not a technical step | N/A | Get an explicit answer on whether the always-open Vault building is in-scope for "no blockchain in current launch" before Phase 9 |
| **Confirm which of `phase15_1`/`phase15_prelaunch` was actually applied first on the live project** — this determines whether `refresh_holder_status` is currently the safe or the client-trusted version (§17/§22) | Supabase SQL Editor — inspect `pg_proc`/function source for `refresh_holder_status`, or re-run `database/diagnostics/inspect_current_supabase_state.sql` if it checks this | N/A — read-only inspection | The live function body should ignore its `p_balance_base_units` argument; if it doesn't, the vulnerable original is live and needs immediate remediation, independent of Phase 0.5 |

---

*End of Phase 0 audit. Per Part 30 of the master instruction: stopping here. No source files, migrations, or Supabase state were modified in the course of this investigation. Awaiting approval before any Phase 1 work begins.*

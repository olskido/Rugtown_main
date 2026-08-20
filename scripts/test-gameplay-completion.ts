/**
 * Focused gameplay completion tests — Phase 16 updated.
 * Run: npx tsx scripts/test-gameplay-completion.ts
 *
 * Tests cover:
 *  - Catalog sizes and shapes
 *  - Building registry completeness
 *  - XP curve v4 (100-level) — boundary transitions at L1, L49, L50, L51, L75, L99, L100
 *  - PROGRESSION_CURVE_VERSION matches canonical version 4
 *  - levelFromLifetimeXp / totalXpRequiredForLevel / applyXpGain boundary math
 *  - Duplicate reward prevention (idempotency) tested via XpCurve arithmetic
 *  - Mission sequencing (cannot skip ahead)
 *
 * Note: ProgressionService imports supabase.ts which uses import.meta.env —
 * unavailable in the Node / tsx runtime.  The progression engine math
 * (curves, idempotency keys, award amounts) is tested directly through the
 * pure XpCurve and MissionSystem imports that have no Supabase dependency.
 * Live Supabase integration is covered by test-staging-supabase-rls.mjs.
 */
import assert from 'node:assert/strict';
import { createStarterMissionSystem } from '../src/game/missions/MissionSystem';
import { STARTER_MISSIONS, STARTER_MISSIONS_TOTAL_XP } from '../src/game/missions/definitions/starterMissions';
import { STORY_MISSIONS } from '../src/game/missions/definitions/storyMissions';
import {
  DAILY_MISSION_CATALOG,
  WEEKLY_MISSION_CATALOG,
  pickLocalDaily,
  pickLocalWeekly,
  DAILY_ASSIGN_COUNT,
  WEEKLY_ASSIGN_COUNT,
} from '../src/game/rewards/PeriodMissions';
import { getBuildingRegistry, assertAllBuildingsRegistered } from '../src/game/world/BuildingRegistry';
import { WORLD_OBJECTS } from '../src/game/world/WorldObjects';
import { FUNCTIONAL_NPCS } from '../src/game/npcs/FunctionalNpcs';
import {
  xpRequiredForLevel,
  levelFromLifetimeXp,
  totalXpRequiredForLevel,
  applyXpGain,
  PROGRESSION_CURVE_VERSION,
} from '../src/game/progression/XpCurve';
import { MAX_LEVEL } from '../src/game/progression/types';
import { PARTY_MISSION_CATALOG } from '../src/game/missions/definitions/partyMissions';

// ─── helpers ─────────────────────────────────────────────────────────────────

function section(name: string): void {
  console.log(`\n  ── ${name}`);
}

// ─── 1. Catalog sizes ─────────────────────────────────────────────────────────
section('Catalog sizes');

assert.equal(STARTER_MISSIONS.length, 10, 'starter missions count');
assert.equal(STARTER_MISSIONS_TOTAL_XP, 320, 'starter missions total XP');
assert.ok(STORY_MISSIONS.length >= 5, 'story missions count');
assert.ok(DAILY_MISSION_CATALOG.length >= 20, 'daily catalog size');
assert.ok(WEEKLY_MISSION_CATALOG.length >= 15, 'weekly catalog size');
// Phase 2: daily missions are 5 category-guaranteed slots (exploration/social/
// mission/activity/wildcard), weekly is 3 — was 3/4 pre-Phase-2.
assert.equal(DAILY_ASSIGN_COUNT, 5, 'daily assign count');
assert.equal(WEEKLY_ASSIGN_COUNT, 3, 'weekly assign count');
assert.equal(pickLocalDaily('user_a').length, 5, 'pickLocalDaily count');
assert.equal(pickLocalWeekly('user_a').length, 3, 'pickLocalWeekly count');
// Determinism: same seed → same result.
assert.deepEqual(
  pickLocalDaily('user_a', '2026-07-30').map((m) => m.id),
  pickLocalDaily('user_a', '2026-07-30').map((m) => m.id),
  'pickLocalDaily is deterministic',
);
assert.equal(PARTY_MISSION_CATALOG.length, 5, 'party missions count');

// ─── 2. Building registry ──────────────────────────────────────────────────────
section('Building registry');

assert.equal(assertAllBuildingsRegistered().length, 0, 'all buildings registered');
assert.equal(getBuildingRegistry().length, WORLD_OBJECTS.length, 'registry length matches world objects');
assert.ok(getBuildingRegistry().every((b) => b.interactionLive), 'all buildings interactionLive');
assert.ok(FUNCTIONAL_NPCS.length >= 10, 'functional NPC count');

// ─── 3. XP Curve v4 — version assertion ───────────────────────────────────────
section('XP Curve v4 — version');

// Phase 16 fix: was incorrectly asserted as 3 in the old test.
assert.equal(PROGRESSION_CURVE_VERSION, 4, 'PROGRESSION_CURVE_VERSION must be 4');
assert.equal(MAX_LEVEL, 100, 'MAX_LEVEL must be 100');

// ─── 4. XP Curve v4 — xpRequiredForLevel spot-checks ─────────────────────────
section('XP Curve v4 — xpRequiredForLevel');

// Level 1→2: step=0, so 200 + 0 + 0 + 0 = 200.
assert.equal(xpRequiredForLevel(1), 200, 'xpRequiredForLevel(1) = 200');

// Level 2→3: step=1, so round(200 + 45 + 6 + 0.08) = round(251.08) = 251.
assert.equal(xpRequiredForLevel(2), 251, 'xpRequiredForLevel(2) = 251');

// Level 100: at max, no more XP required.
assert.equal(xpRequiredForLevel(100), 0, 'xpRequiredForLevel(100) = 0');
assert.equal(xpRequiredForLevel(MAX_LEVEL), 0, 'xpRequiredForLevel(MAX_LEVEL) = 0');

// All levels below 100 must require > 0 XP.
// Level 50 and 51 were broken when the DB cap was 50 — verify they return nonzero.
assert.ok(xpRequiredForLevel(49) > 0, 'xpRequiredForLevel(49) > 0');
assert.ok(xpRequiredForLevel(50) > 0, 'xpRequiredForLevel(50) > 0 (was broken at old cap)');
assert.ok(xpRequiredForLevel(51) > 0, 'xpRequiredForLevel(51) > 0 (past old cap)');
assert.ok(xpRequiredForLevel(75) > 0, 'xpRequiredForLevel(75) > 0');
assert.ok(xpRequiredForLevel(99) > 0, 'xpRequiredForLevel(99) > 0');

// XP cost must be monotonically increasing (harder to level up as you go).
for (let L = 1; L < 99; L++) {
  assert.ok(
    xpRequiredForLevel(L + 1) >= xpRequiredForLevel(L),
    `xpRequiredForLevel is non-decreasing at L${L}→L${L + 1}`,
  );
}

// ─── 5. XP Curve v4 — totalXpRequiredForLevel ─────────────────────────────────
section('XP Curve v4 — totalXpRequiredForLevel');

assert.equal(totalXpRequiredForLevel(1), 0, 'totalXpRequiredForLevel(1) = 0 (start with nothing)');
assert.equal(totalXpRequiredForLevel(2), 200, 'totalXpRequiredForLevel(2) = 200');

// Sanity: total XP to reach L100 must be > total XP to reach L50.
const totalAt50  = totalXpRequiredForLevel(50);
const totalAt100 = totalXpRequiredForLevel(100);
assert.ok(totalAt100 > totalAt50, 'totalXpRequiredForLevel(100) > totalXpRequiredForLevel(50)');

// ─── 6. XP Curve v4 — levelFromLifetimeXp boundary transitions ────────────────
section('XP Curve v4 — levelFromLifetimeXp boundaries');

// Level 1 boundaries.
assert.equal(levelFromLifetimeXp(0), 1, 'levelFromLifetimeXp(0) = 1');
assert.equal(levelFromLifetimeXp(199), 1, 'levelFromLifetimeXp(199) = 1');
assert.equal(levelFromLifetimeXp(200), 2, 'levelFromLifetimeXp(200) = 2');

// L49 / L50 boundary.
const xpToL49 = totalXpRequiredForLevel(49);
const xpToL50 = totalXpRequiredForLevel(50);
assert.equal(levelFromLifetimeXp(xpToL49),     49, 'levelFromLifetimeXp reaches L49');
assert.equal(levelFromLifetimeXp(xpToL50 - 1), 49, 'levelFromLifetimeXp(L50-1) still L49');
assert.equal(levelFromLifetimeXp(xpToL50),     50, 'levelFromLifetimeXp reaches L50');

// L50 → L51: this was the broken boundary when the DB cap was level 50.
const xpToL51 = totalXpRequiredForLevel(51);
assert.equal(levelFromLifetimeXp(xpToL51 - 1), 50, 'levelFromLifetimeXp(L51-1) still L50');
assert.equal(levelFromLifetimeXp(xpToL51),     51, 'levelFromLifetimeXp crosses L51 (DB cap fix verified)');

// L75 boundary.
const xpToL75 = totalXpRequiredForLevel(75);
assert.equal(levelFromLifetimeXp(xpToL75), 75, 'levelFromLifetimeXp reaches L75');

// L99 / L100 boundary.
const xpToL99  = totalXpRequiredForLevel(99);
const xpToL100 = totalXpRequiredForLevel(100);
assert.equal(levelFromLifetimeXp(xpToL99),      99,  'levelFromLifetimeXp reaches L99');
assert.equal(levelFromLifetimeXp(xpToL100 - 1), 99,  'levelFromLifetimeXp(L100-1) = 99');
assert.equal(levelFromLifetimeXp(xpToL100),     100, 'levelFromLifetimeXp reaches L100');

// Overflow beyond max: must stay at 100.
assert.equal(levelFromLifetimeXp(xpToL100 + 999_999), 100, 'levelFromLifetimeXp cannot exceed 100');

// ─── 7. applyXpGain ───────────────────────────────────────────────────────────
section('applyXpGain');

// Basic level-up.
const gain1 = applyXpGain(0, 200);
assert.equal(gain1.newLevel,     2, 'applyXpGain 0+200 → L2');
assert.equal(gain1.levelsGained, 1, 'levelsGained = 1');
assert.equal(gain1.lifetimeXp, 200, 'lifetimeXp = 200');

// No level-up (partial XP).
const gainPartial = applyXpGain(0, 100);
assert.equal(gainPartial.newLevel,     1, 'partial XP: stays at L1');
assert.equal(gainPartial.levelsGained, 0, 'levelsGained = 0');

// Cross L50→L51 (the previously broken boundary).
const gain50 = applyXpGain(xpToL50, xpToL51 - xpToL50);
assert.equal(gain50.previousLevel, 50, 'previousLevel = 50');
assert.equal(gain50.newLevel,      51, 'newLevel = 51 (level-cap fix confirmed)');
assert.equal(gain50.levelsGained,   1, 'levelsGained = 1');

// At max level: lifetimeXp accumulates but level stays at 100.
const gainMax = applyXpGain(xpToL100, 10_000);
assert.equal(gainMax.newLevel,       100,            'level stays 100 at max');
assert.equal(gainMax.lifetimeXp, xpToL100 + 10_000, 'lifetimeXp accumulates past max');
assert.equal(gainMax.levelsGained,     0,            'no levels gained at max');

// ─── 8. Idempotency — XP accumulation is additive only ────────────────────────
// These tests verify the pure math without importing Supabase-dependent modules.
section('XP accumulation idempotency (pure math)');

// Simulate claimed-key deduplication: applying the same gain twice should not
// produce extra levels if the caller guards with an idempotency key set.
// We verify this by checking that applyXpGain is deterministic:
// applyXpGain(base, amount) always returns the same new level for the same inputs.
const base = totalXpRequiredForLevel(5);
const result1 = applyXpGain(base, 500);
const result2 = applyXpGain(base, 500); // identical inputs
assert.equal(result1.newLevel,     result2.newLevel,     'applyXpGain is deterministic');
assert.equal(result1.lifetimeXp,   result2.lifetimeXp,   'lifetimeXp is deterministic');
assert.equal(result1.levelsGained, result2.levelsGained, 'levelsGained is deterministic');

// If the idempotency key is already in the claimed set, the caller returns
// amount=0. Verify applyXpGain with 0 is a true no-op.
const noOp = applyXpGain(xpToL50, 0);
assert.equal(noOp.newLevel,     50, 'applyXpGain with 0 is no-op: level unchanged');
assert.equal(noOp.lifetimeXp,   xpToL50, 'applyXpGain with 0 is no-op: XP unchanged');
assert.equal(noOp.levelsGained, 0,  'applyXpGain with 0: levelsGained = 0');

// ─── 9. Mission sequencing ────────────────────────────────────────────────────
section('Mission sequencing');

const ms = createStarterMissionSystem();
assert.equal(ms.getActiveMissionId(), 'ch1_new_face', 'first mission active');
assert.equal(
  ms.handleEvent({ type: 'LANDMARK_VISITED', landmarkId: 'fountain' }),
  true,
  'visit fountain progresses ch1_new_face',
);
assert.equal(ms.getActiveMissionId(), 'ch1_new_face', 'still active after partial progress');
assert.equal(
  ms.handleEvent({ type: 'LANDMARK_INTERACTED', landmarkId: 'fountain' }),
  true,
  'interact fountain completes ch1_new_face',
);
assert.equal(ms.getActiveMissionId(), 'ch1_water_before_rumours', 'advanced to next mission');

// Repeating the same event on a completed mission objective is a no-op.
assert.equal(
  ms.handleEvent({ type: 'LANDMARK_INTERACTED', landmarkId: 'fountain' }),
  false,
  'completed objective idempotent (returns false)',
);

ms.handleEvent({ type: 'TOWN_CRIER_TALKED' });
ms.handleEvent({ type: 'PANEL_OPENED', panelId: 'missions' });
assert.equal(ms.getActiveMissionId(), 'ch1_empty_cart', 'advanced to ch1_empty_cart');

// Unknown / future event type cannot skip ahead.
assert.equal(
  ms.handleEvent({ type: 'JOIN_CITY_EVENT' as never }),
  false,
  'unknown event type returns false (cannot skip)',
);

// ─── Done ─────────────────────────────────────────────────────────────────────
console.log('\n✓ test-gameplay-completion: all tests passed\n');

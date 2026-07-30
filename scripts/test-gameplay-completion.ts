/**
 * Focused gameplay completion tests.
 * Run: npx tsx scripts/test-gameplay-completion.ts
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
import { xpRequiredForLevel, levelFromLifetimeXp, PROGRESSION_CURVE_VERSION } from '../src/game/progression/XpCurve';
import { PARTY_MISSION_CATALOG } from '../src/game/missions/definitions/partyMissions';

assert.equal(STARTER_MISSIONS.length, 10);
assert.equal(STARTER_MISSIONS_TOTAL_XP, 320);
assert.ok(STORY_MISSIONS.length >= 5);
assert.ok(DAILY_MISSION_CATALOG.length >= 20);
assert.ok(WEEKLY_MISSION_CATALOG.length >= 15);
assert.equal(DAILY_ASSIGN_COUNT, 3);
assert.equal(WEEKLY_ASSIGN_COUNT, 4);
assert.equal(pickLocalDaily('user_a').length, 3);
assert.equal(pickLocalWeekly('user_a').length, 4);
assert.deepEqual(
  pickLocalDaily('user_a', '2026-07-30').map((m) => m.id),
  pickLocalDaily('user_a', '2026-07-30').map((m) => m.id),
);

assert.equal(assertAllBuildingsRegistered().length, 0);
assert.equal(getBuildingRegistry().length, WORLD_OBJECTS.length);
assert.ok(getBuildingRegistry().every((b) => b.interactionLive));
assert.ok(FUNCTIONAL_NPCS.length >= 10);
assert.equal(PARTY_MISSION_CATALOG.length, 5);

assert.equal(PROGRESSION_CURVE_VERSION, 3);
assert.equal(xpRequiredForLevel(1), 200);
assert.equal(levelFromLifetimeXp(199), 1);
assert.equal(levelFromLifetimeXp(200), 2);

const ms = createStarterMissionSystem();
assert.equal(ms.getActiveMissionId(), 'ch1_new_face');
assert.equal(ms.handleEvent({ type: 'LANDMARK_VISITED', landmarkId: 'fountain' }), true);
assert.equal(ms.getActiveMissionId(), 'ch1_new_face');
assert.equal(ms.handleEvent({ type: 'LANDMARK_INTERACTED', landmarkId: 'fountain' }), true);
assert.equal(ms.getActiveMissionId(), 'ch1_water_before_rumours');
assert.equal(ms.handleEvent({ type: 'LANDMARK_INTERACTED', landmarkId: 'fountain' }), false);

ms.handleEvent({ type: 'TOWN_CRIER_TALKED' });
ms.handleEvent({ type: 'PANEL_OPENED', panelId: 'missions' });
assert.equal(ms.getActiveMissionId(), 'ch1_empty_cart');

// Invalid position / skip prevention: cannot complete later mission early
assert.equal(ms.handleEvent({ type: 'JOIN_CITY_EVENT' as never }), false);

console.log('test-gameplay-completion: all passed');

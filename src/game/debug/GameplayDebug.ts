/**
 * Dev-only gameplay diagnostics. Never mounted in production builds
 * unless import.meta.env.DEV is true.
 */
import { getBuildingRegistry } from '../world/BuildingRegistry';
import { utcDailyKey, utcWeeklyKey } from '../rewards/PeriodMissions';

export interface GameplayDebugSnapshot {
  buildingCount: number;
  buildings: Array<{ id: string; name: string; district: string }>;
  dailyResetId: string;
  weeklyResetId: string;
}

export function buildGameplayDebugSnapshot(): GameplayDebugSnapshot {
  const buildings = getBuildingRegistry().map((b) => ({
    id: b.id,
    name: b.displayName,
    district: b.district,
  }));
  return {
    buildingCount: buildings.length,
    buildings,
    dailyResetId: utcDailyKey(),
    weeklyResetId: utcWeeklyKey(),
  };
}

export function isGameplayDebugEnabled(): boolean {
  return import.meta.env.DEV === true;
}

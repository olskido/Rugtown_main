/**
 * RankLadder.ts — RugTown 10-Tier Progression Ladder (100 Levels).
 * Driven directly by player level and achievements.
 */

import type { RankTierId } from './types';

export interface RankTierDef {
  id: RankTierId;
  displayName: string;
  minLevel: number;
  maxLevel: number;
  order: number;
}

export const RANK_LADDER: RankTierDef[] = [
  { id: 'citizen',        displayName: 'Citizen',          minLevel: 1,   maxLevel: 10,  order: 0 },
  { id: 'explorer',       displayName: 'Explorer',         minLevel: 11,  maxLevel: 20,  order: 1 },
  { id: 'socialite',      displayName: 'Socialite',        minLevel: 21,  maxLevel: 30,  order: 2 },
  { id: 'specialist',     displayName: 'Specialist',       minLevel: 31,  maxLevel: 40,  order: 3 },
  { id: 'investigator',   displayName: 'Investigator',     minLevel: 41,  maxLevel: 50,  order: 4 },
  { id: 'hunter',         displayName: 'Hunter',           minLevel: 51,  maxLevel: 60,  order: 5 },
  { id: 'elite',          displayName: 'Elite',            minLevel: 61,  maxLevel: 70,  order: 6 },
  { id: 'master',         displayName: 'Master',           minLevel: 71,  maxLevel: 80,  order: 7 },
  { id: 'legend_hunter',  displayName: 'Legend Hunter',    minLevel: 81,  maxLevel: 90,  order: 8 },
  { id: 'endgame',        displayName: 'Endgame Pioneer',  minLevel: 91,  maxLevel: 99,  order: 9 },
  { id: 'rugtown_legend', displayName: 'RugTown Legend',   minLevel: 100, maxLevel: 100, order: 10 },
];

export function rankTierFromLevel(level: number): RankTierDef {
  const lvl = Math.max(1, Math.min(100, Math.floor(level)));
  for (const tier of RANK_LADDER) {
    if (lvl >= tier.minLevel && lvl <= tier.maxLevel) {
      return tier;
    }
  }
  return RANK_LADDER[0];
}

export function deriveRankTier(opts: {
  level: number;
  rep?: number;
  achievementPoints?: number;
  seasonPoints?: number;
}): RankTierId {
  return rankTierFromLevel(opts.level).id;
}

export function rankDisplayName(id: RankTierId): string {
  return RANK_LADDER.find((r) => r.id === id)?.displayName ?? 'Citizen';
}

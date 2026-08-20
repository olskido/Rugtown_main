/**
 * Progression types — 100-Level Social Progression Engine.
 * REP (lifetime reputation), XP (level progression), POINTS (leaderboard score),
 * and STREAK (consistency multiplier) are strictly decoupled.
 */

export type RankTierId =
  | 'citizen'         // Levels 1–10
  | 'explorer'        // Levels 11–20
  | 'socialite'       // Levels 21–30
  | 'specialist'      // Levels 31–40
  | 'investigator'    // Levels 41–50
  | 'hunter'          // Levels 51–60
  | 'elite'           // Levels 61–70
  | 'master'          // Levels 71–80
  | 'legend_hunter'   // Levels 81–90
  | 'endgame'         // Levels 91–99
  | 'rugtown_legend'; // Level 100

export type TitleRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type TitleCategory =
  | 'exploration'
  | 'missions'
  | 'social'
  | 'events'
  | 'progression'
  | 'special';

export type AchievementCategory =
  | 'exploration'
  | 'missions'
  | 'social'
  | 'events'
  | 'progression'
  | 'collection';

export interface AchievementProgress {
  current: number;
  completed: boolean;
  completedAt?: string;
}

export interface PlayerStatistics {
  missionsCompleted: number;
  uniqueLandmarksVisited: number;
  districtsVisited: number;
  interiorsEntered: number;
  cityEventsJoined: number;
  uniquePlayersInteractedWith: number;
  totalRepEarned: number;
  lifetimeXp: number;
  playTimeSeconds: number;
  distanceTravelled: number;
  currentLoginStreak: number;
  longestLoginStreak: number;
  accountCreatedAt: string;
  lastActiveAt: string;
}

export interface SeasonProgress {
  seasonId: string | null;
  seasonPoints: number;
  seasonRank: number | null;
  seasonStart: string | null;
  seasonEnd: string | null;
}

export interface PointsProgress {
  daily: number;
  weekly: number;
  lifetime: number;
}

export interface StreakProgress {
  current: number;
  longest: number;
  lastActiveDate: string | null;
  multiplier: number;
}

export interface PlayerProgression {
  schemaVersion: number;
  playerId: string;
  isGuest: boolean;
  level: number;
  currentXp: number;
  lifetimeXp: number;
  rep: number;
  points: PointsProgress;
  streak: StreakProgress;
  rankTier: RankTierId;
  season: SeasonProgress;
  equippedTitleId: string | null;
  unlockedTitleIds: string[];
  achievementProgress: Record<string, AchievementProgress>;
  unlockedFeatureIds: string[];
  statistics: PlayerStatistics;
  /** Claimed reward / discovery keys — never re-award. */
  claimedRewardKeys: string[];
  discoveredDistrictIds: string[];
  discoveredLandmarkIds: string[];
  discoveredInteriorIds: string[];
  uniquePlayerInteractIds: string[];
  updatedAt: string;
}

export interface XpAwardResult {
  awarded: boolean;
  amount: number;
  reason: string;
  key: string;
  levelsGained: number;
  newLevel: number;
  previousLevel: number;
}

export interface RepAwardResult {
  awarded: boolean;
  amount: number;
  reason: string;
  key: string;
  newRep: number;
}

export interface PointsAwardResult {
  awarded: boolean;
  amount: number;
  reason: string;
  key: string;
  newDaily: number;
  newWeekly: number;
  newLifetime: number;
}

export interface ProgressionSnapshot {
  level: number;
  currentXp: number;
  xpToNext: number;
  progressPercent: number;
  lifetimeXp: number;
  rep: number;
  pointsDaily: number;
  pointsWeekly: number;
  pointsLifetime: number;
  currentStreak: number;
  streakMultiplier: number;
  rankTier: RankTierId;
  rankLabel: string;
  equippedTitleId: string | null;
  equippedTitleName: string | null;
  achievementCompleted: number;
  achievementTotal: number;
  discoveryLandmarks: number;
  discoveryDistricts: number;
  seasonPoints: number;
  latestEvent: string | null;
  latestRewardKey: string | null;
}

export const PROGRESSION_SCHEMA_VERSION = 2;
export const MAX_LEVEL = 100;

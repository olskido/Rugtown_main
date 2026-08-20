/**
 * ProgressionRepository.ts — local persistence + Supabase boundary (Phase 16).
 * syncToServer is now implemented: it calls push_progression_snapshot on the
 * server (Phase 16 migration required) and is debounced by the caller so it
 * fires at most once per 10 s during active gameplay.
 */

import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { loadProgress, patchProgress, type RugtownProgress } from '../../lib/progress';
import { ACHIEVEMENT_CATALOG } from './AchievementCatalog';
import { deriveRankTier } from './RankLadder';
import { emptySeasonProgress } from './SeasonFoundation';
import { unlocksForLevel } from './UnlockCatalog';
import { levelFromLifetimeXp, levelProgressPercent } from './XpCurve';
import {
  PROGRESSION_SCHEMA_VERSION,
  type AchievementProgress,
  type PlayerProgression,
  type PlayerStatistics,
} from './types';

const STORAGE_KEY = 'rugtown:progression:v1';

function nowIso(): string {
  return new Date().toISOString();
}

function defaultStatistics(createdAt?: string): PlayerStatistics {
  const t = createdAt ?? nowIso();
  return {
    missionsCompleted: 0,
    uniqueLandmarksVisited: 0,
    districtsVisited: 0,
    interiorsEntered: 0,
    cityEventsJoined: 0,
    uniquePlayersInteractedWith: 0,
    totalRepEarned: 0,
    lifetimeXp: 0,
    playTimeSeconds: 0,
    distanceTravelled: 0,
    currentLoginStreak: 1,
    longestLoginStreak: 1,
    accountCreatedAt: t,
    lastActiveAt: t,
  };
}

export function createDefaultProgression(opts: {
  playerId: string;
  isGuest: boolean;
  rep?: number;
  visitedInteriors?: string[];
  completedMissions?: number;
}): PlayerProgression {
  const created = nowIso();
  const rep = Math.max(0, Math.floor(opts.rep ?? 0));
  const interiors = opts.visitedInteriors ?? [];
  const missionsCompleted = opts.completedMissions ?? 0;
  const stats = defaultStatistics(created);
  stats.totalRepEarned = rep;
  stats.missionsCompleted = missionsCompleted;
  stats.interiorsEntered = interiors.length;
  stats.lifetimeXp = 0;

  const achievementProgress: Record<string, AchievementProgress> = {};
  for (const a of ACHIEVEMENT_CATALOG) {
    achievementProgress[a.id] = { current: 0, completed: false };
  }

  const level = 1;
  const today = nowIso().slice(0, 10);
  return {
    schemaVersion: PROGRESSION_SCHEMA_VERSION,
    playerId: opts.playerId,
    isGuest: opts.isGuest,
    level,
    currentXp: 0,
    lifetimeXp: 0,
    rep,
    points: {
      daily: 0,
      weekly: 0,
      lifetime: 0,
    },
    streak: {
      current: 1,
      longest: 1,
      lastActiveDate: today,
      multiplier: 1.0,
    },
    rankTier: deriveRankTier({ level }),
    season: emptySeasonProgress(),
    equippedTitleId: null,
    unlockedTitleIds: [],
    achievementProgress,
    unlockedFeatureIds: unlocksForLevel(level),
    statistics: stats,
    claimedRewardKeys: [],
    discoveredDistrictIds: [],
    discoveredLandmarkIds: [],
    discoveredInteriorIds: [...interiors],
    uniquePlayerInteractIds: [],
    updatedAt: created,
  };
}

/**
 * Migrate legacy RugtownProgress + rugtown:currentLevel into PlayerProgression.
 * Preserves REP and discovery seeds. Does not reset progress.
 */
export function migrateFromLegacy(
  playerId: string,
  isGuest: boolean,
  legacy?: RugtownProgress,
): PlayerProgression {
  const base = legacy ?? loadProgress();
  const prog = createDefaultProgression({
    playerId,
    isGuest,
    rep: base.rep,
    visitedInteriors: base.visitedInteriors,
    completedMissions: base.completedMissions.length,
  });

  // Seed claimed keys so interior discoveries aren't re-awarded
  for (const id of base.visitedInteriors) {
    const key = `interior:${id}:first_visit`;
    if (!prog.claimedRewardKeys.includes(key)) prog.claimedRewardKeys.push(key);
  }
  for (const mid of base.completedMissions) {
    const key = `mission:${mid}:complete`;
    if (!prog.claimedRewardKeys.includes(key)) prog.claimedRewardKeys.push(key);
  }

  // Sync interior discovery lists / stats
  prog.discoveredInteriorIds = [...new Set(base.visitedInteriors)];
  prog.statistics.interiorsEntered = prog.discoveredInteriorIds.length;
  prog.statistics.missionsCompleted = base.completedMissions.length;
  prog.statistics.totalRepEarned = Math.max(0, base.rep);

  return prog;
}

function sanitize(raw: Partial<PlayerProgression>, playerId: string, isGuest: boolean): PlayerProgression {
  const fallback = createDefaultProgression({ playerId, isGuest, rep: typeof raw.rep === 'number' ? raw.rep : 0 });
  const lifetimeXp = typeof raw.lifetimeXp === 'number' && Number.isFinite(raw.lifetimeXp)
    ? Math.max(0, Math.floor(raw.lifetimeXp))
    : 0;
  const levelInfo = levelProgressPercent(lifetimeXp);
  const rep = typeof raw.rep === 'number' && Number.isFinite(raw.rep) ? Math.max(0, Math.floor(raw.rep)) : 0;

  const achievementProgress: Record<string, AchievementProgress> = { ...fallback.achievementProgress };
  if (raw.achievementProgress && typeof raw.achievementProgress === 'object') {
    for (const a of ACHIEVEMENT_CATALOG) {
      const p = raw.achievementProgress[a.id];
      if (p && typeof p.current === 'number') {
        achievementProgress[a.id] = {
          current: Math.max(0, Math.floor(p.current)),
          completed: !!p.completed,
          completedAt: typeof p.completedAt === 'string' ? p.completedAt : undefined,
        };
      }
    }
  }

  const unlockedTitleIds = Array.isArray(raw.unlockedTitleIds)
    ? raw.unlockedTitleIds.filter((x): x is string => typeof x === 'string')
    : [];
  let equippedTitleId = typeof raw.equippedTitleId === 'string' ? raw.equippedTitleId : null;
  if (equippedTitleId && !unlockedTitleIds.includes(equippedTitleId)) {
    equippedTitleId = null;
  }

  const stats = { ...fallback.statistics, ...(raw.statistics ?? {}) };
  stats.lifetimeXp = lifetimeXp;
  stats.totalRepEarned = Math.max(stats.totalRepEarned ?? 0, rep);

  const achPoints = Object.values(achievementProgress).filter((p) => p.completed).length;

  return {
    schemaVersion: PROGRESSION_SCHEMA_VERSION,
    playerId,
    isGuest,
    level: levelInfo.level,
    currentXp: levelInfo.currentXp,
    lifetimeXp,
    rep,
    points: {
      daily: typeof raw.points?.daily === 'number' && Number.isFinite(raw.points.daily) ? Math.max(0, Math.floor(raw.points.daily)) : 0,
      weekly: typeof raw.points?.weekly === 'number' && Number.isFinite(raw.points.weekly) ? Math.max(0, Math.floor(raw.points.weekly)) : 0,
      lifetime: typeof raw.points?.lifetime === 'number' && Number.isFinite(raw.points.lifetime) ? Math.max(0, Math.floor(raw.points.lifetime)) : 0,
    },
    streak: {
      current: typeof raw.streak?.current === 'number' && Number.isFinite(raw.streak.current) ? Math.max(1, Math.floor(raw.streak.current)) : 1,
      longest: typeof raw.streak?.longest === 'number' && Number.isFinite(raw.streak.longest) ? Math.max(1, Math.floor(raw.streak.longest)) : 1,
      lastActiveDate: typeof raw.streak?.lastActiveDate === 'string' ? raw.streak.lastActiveDate : nowIso().slice(0, 10),
      multiplier: typeof raw.streak?.multiplier === 'number' && Number.isFinite(raw.streak.multiplier) ? Math.max(1.0, raw.streak.multiplier) : 1.0,
    },
    rankTier: deriveRankTier({ level: levelInfo.level }),
    season: {
      ...emptySeasonProgress(),
      ...(raw.season ?? {}),
      // Hide fake season if catalog has none active
      seasonId: emptySeasonProgress().seasonId ? (raw.season?.seasonId ?? null) : null,
      seasonRank: emptySeasonProgress().seasonId ? (raw.season?.seasonRank ?? null) : null,
    },
    equippedTitleId,
    unlockedTitleIds,
    achievementProgress,
    unlockedFeatureIds: unlocksForLevel(levelInfo.level),
    statistics: stats,
    claimedRewardKeys: Array.isArray(raw.claimedRewardKeys)
      ? raw.claimedRewardKeys.filter((x): x is string => typeof x === 'string')
      : [],
    discoveredDistrictIds: Array.isArray(raw.discoveredDistrictIds)
      ? raw.discoveredDistrictIds.filter((x): x is string => typeof x === 'string')
      : [],
    discoveredLandmarkIds: Array.isArray(raw.discoveredLandmarkIds)
      ? raw.discoveredLandmarkIds.filter((x): x is string => typeof x === 'string')
      : [],
    discoveredInteriorIds: Array.isArray(raw.discoveredInteriorIds)
      ? raw.discoveredInteriorIds.filter((x): x is string => typeof x === 'string')
      : [],
    uniquePlayerInteractIds: Array.isArray(raw.uniquePlayerInteractIds)
      ? raw.uniquePlayerInteractIds.filter((x): x is string => typeof x === 'string')
      : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function storageKeyFor(playerId: string): string {
  return `${STORAGE_KEY}:${playerId}`;
}

export interface ProgressionRepository {
  load(playerId: string, isGuest: boolean): PlayerProgression;
  save(prog: PlayerProgression): void;
  /**
   * Push the authoritative local snapshot to the server via
   * push_progression_snapshot (Phase 16 RPC).
   *
   * - No-op for guests (isGuest = true) or when Supabase is not configured.
   * - Server applies max-wins merge for XP/REP so this is safe to call
   *   speculatively; it will never reduce the server-side values.
   * - Returns true if the server acknowledged the push, false otherwise
   *   (network failure, pre-migration DB, etc.).  Callers must not block
   *   gameplay on the return value.
   */
  syncToServer?(prog: PlayerProgression): Promise<boolean>;
}

export const localProgressionRepository: ProgressionRepository = {
  load(playerId, isGuest) {
    if (typeof window === 'undefined') {
      return migrateFromLegacy(playerId, isGuest);
    }
    try {
      const raw = window.localStorage.getItem(storageKeyFor(playerId));
      if (!raw) {
        // First load: migrate legacy shared progress into this identity
        const migrated = migrateFromLegacy(playerId, isGuest);
        this.save(migrated);
        // Keep legacy REP in sync
        patchProgress({ rep: migrated.rep });
        return migrated;
      }
      const parsed = JSON.parse(raw) as Partial<PlayerProgression>;
      return sanitize(parsed, playerId, isGuest);
    } catch {
      return migrateFromLegacy(playerId, isGuest);
    }
  },

  save(prog) {
    if (typeof window === 'undefined') return;
    try {
      const next = { ...prog, updatedAt: nowIso() };
      window.localStorage.setItem(storageKeyFor(prog.playerId), JSON.stringify(next));
      // Keep legacy progress.rep in sync for older readers
      patchProgress({ rep: next.rep });
    } catch {
      /* ignore */
    }
  },

  async syncToServer(prog: PlayerProgression): Promise<boolean> {
    // Guests never sync — their progress is intentionally session-only.
    if (prog.isGuest) return false;
    if (!isSupabaseConfigured || !supabase) return false;

    try {
      const { data, error } = await supabase.rpc('push_progression_snapshot', {
        p_lifetime_xp:      prog.lifetimeXp,
        p_rep:              prog.rep,
        p_points_daily:     prog.points?.daily    ?? 0,
        p_points_weekly:    prog.points?.weekly   ?? 0,
        p_points_lifetime:  prog.points?.lifetime ?? 0,
        p_streak_current:   prog.streak?.current  ?? 1,
        p_streak_longest:   prog.streak?.longest  ?? 1,
        p_streak_date:      prog.streak?.lastActiveDate ?? null,
      });

      if (error) {
        const missing =
          error.code === 'PGRST202' ||
          /does not exist|function .* does not exist|schema cache/i.test(error.message ?? '');
        if (missing) {
          // Phase 16 migration not yet applied — silently skip rather than spam errors.
          return false;
        }
        console.warn('[ProgressionRepository] syncToServer failed:', error.message);
        return false;
      }

      // Server may return updated authoritative values; if so, patch local cache.
      if (data && typeof data === 'object') {
        const snap = data as Record<string, unknown>;
        if (typeof snap.level === 'number' && snap.level > prog.level) {
          prog.level = snap.level as number;
        }
        if (typeof snap.lifetime_xp === 'number' && (snap.lifetime_xp as number) > prog.lifetimeXp) {
          prog.lifetimeXp = snap.lifetime_xp as number;
        }
        if (typeof snap.rep === 'number' && (snap.rep as number) > prog.rep) {
          prog.rep = snap.rep as number;
        }
        if (typeof snap.rug_points === 'number') {
          if (!prog.points) prog.points = { daily: 0, weekly: 0, lifetime: 0 };
          prog.points.lifetime = Math.max(prog.points.lifetime, snap.rug_points as number);
        }
        if (typeof snap.daily_points === 'number') {
          if (!prog.points) prog.points = { daily: 0, weekly: 0, lifetime: 0 };
          // If the server reset the daily bucket, honour that reset locally.
          prog.points.daily = snap.daily_points as number;
        }
        if (typeof snap.weekly_points === 'number') {
          if (!prog.points) prog.points = { daily: 0, weekly: 0, lifetime: 0 };
          prog.points.weekly = snap.weekly_points as number;
        }
        // Persist the post-merge state so localStorage stays consistent.
        this.save(prog);
      }

      return true;
    } catch {
      return false;
    }
  },
};

/** Dev-only reset helper. */
export function resetProgressionStorage(playerId: string): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV) return;
  window.localStorage.removeItem(storageKeyFor(playerId));
}

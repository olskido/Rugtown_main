/**
 * src/lib/leaderboard.ts
 * ───────────────────────
 * Thin client wrappers around the Phase 2 leaderboard RPCs
 * (get_points_leaderboard / get_my_leaderboard_rank / get_weekly_champions).
 * All server-side ranking — the client never computes rank itself.
 */

import { supabase } from './supabase';

export type LeaderboardPeriod = 'daily' | 'weekly' | 'all_time';

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  username: string;
  level: number;
  rep: number;
  points: number;
  /** Phase 17: Robinhood Chain wallet address (null if player has not linked one) */
  walletAddress: string | null;
  walletChain: string | null;
}

export interface MyLeaderboardRank {
  playerId: string;
  period: LeaderboardPeriod;
  rank: number;
  points: number;
}

/** Top-N ranked rows for a period. Returns null on any error (caller falls back to local data). */
export async function getPointsLeaderboard(
  period: LeaderboardPeriod,
  limit = 15,
  offset = 0,
): Promise<LeaderboardRow[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_points_leaderboard', {
    p_period: period,
    p_limit: limit,
    p_offset: offset,
  });
  if (error || !data || typeof data !== 'object') return null;
  const rows = (data as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      rank:          Number(o.rank ?? 0),
      playerId:      String(o.playerId ?? ''),
      username:      String(o.username ?? ''),
      level:         Number(o.level ?? 1),
      rep:           Number(o.rep ?? 0),
      points:        Number(o.points ?? 0),
      walletAddress: (o.walletAddress ?? null) as string | null,
      walletChain:   (o.walletChain   ?? null) as string | null,
    };
  });
}

/** The current player's own rank + points for a period. Returns null on error/not signed in. */
export async function getMyLeaderboardRank(period: LeaderboardPeriod): Promise<MyLeaderboardRank | null> {
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase.rpc('get_my_leaderboard_rank', { p_period: period });
  if (error || !data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  return {
    playerId: uid,
    period,
    rank: Number(o.rank ?? 0),
    points: Number(o.points ?? 0),
  };
}

export interface WeeklyChampion {
  periodKey: string;
  rank: number;
  playerId: string;
  username: string;
  points: number;
  titleAwarded: string | null;
  settledAt: string;
}

/** Past weekly top-3 winners, most recent week first — for the Hall of Fame panel. */
export async function getWeeklyChampions(limit = 12): Promise<WeeklyChampion[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('get_weekly_champions', { p_limit: limit });
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      periodKey: String(o.period_key ?? ''),
      rank: Number(o.rank ?? 0),
      playerId: String(o.player_id ?? ''),
      username: String(o.username ?? ''),
      points: Number(o.points ?? 0),
      titleAwarded: (o.title_awarded ?? null) as string | null,
      settledAt: String(o.settled_at ?? ''),
    };
  });
}

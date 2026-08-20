/**
 * src/lib/activity.ts
 * ────────────────────
 * Client wrappers for the Phase 2 streak + bounded time-in-game RPCs.
 * Both are server-authoritative and idempotent/rate-limited server-side —
 * the client just calls them at sensible moments (see GamePage.tsx) and
 * reflects whatever the server actually granted.
 */

import { supabase } from './supabase';

export interface StreakResult {
  currentStreak: number;
  longestStreak: number;
  milestoneBonus: { streakDays: number; repAwarded: number; pointsAwarded: number } | null;
}

/**
 * Call once per UTC day after the player completes a qualifying activity
 * (a daily mission claim, a hidden quest completion). Idempotent — calling
 * it again the same UTC day is a safe no-op and returns the existing streak.
 */
export async function recordDailyParticipation(): Promise<StreakResult | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('record_daily_participation');
  if (error || !data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const bonus = o.milestoneBonus as Record<string, unknown> | null | undefined;
  return {
    currentStreak: Number(o.currentStreak ?? 0),
    longestStreak: Number(o.longestStreak ?? 0),
    milestoneBonus: bonus
      ? {
          streakDays: Number(bonus.streakDays ?? 0),
          repAwarded: Number(bonus.repAwarded ?? 0),
          pointsAwarded: Number(bonus.pointsAwarded ?? 0),
        }
      : null,
  };
}

export async function getMyStreak(): Promise<{ currentStreak: number; longestStreak: number } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_my_streak');
  if (error || !data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  return { currentStreak: Number(o.currentStreak ?? 0), longestStreak: Number(o.longestStreak ?? 0) };
}

export interface HeartbeatResult {
  ok: boolean;
  reason?: 'cooldown' | 'daily_cap_reached';
  rewardCountToday: number;
}

/**
 * Bounded time-in-game reward. Call at most every few minutes while the
 * player is actively doing something (not on a blurred/idle tab) — the
 * server enforces the real cooldown (5 min) and daily cap (6/day) regardless
 * of how often this is called, so calling it too often just returns
 * `{ ok: false, reason: 'cooldown' }` harmlessly.
 */
export async function recordActivityHeartbeat(): Promise<HeartbeatResult | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('record_activity_heartbeat');
  if (error || !data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  return {
    ok: o.ok === true,
    reason: o.reason as HeartbeatResult['reason'],
    rewardCountToday: Number(o.rewardCountToday ?? 0),
  };
}

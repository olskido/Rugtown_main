/**
 * src/lib/supabase.ts
 * ────────────────────
 * Supabase client singleton for RugTown.
 *
 * If the environment variables are not present (local dev without a
 * Supabase project, CI, or pure guest-only mode) `supabase` is null and
 * `isSupabaseConfigured` is false.  All calling code must guard on
 * `isSupabaseConfigured` so that guest mode keeps working with zero
 * changes to existing gameplay code.
 *
 * Required env vars (copy .env.example → .env.local to set them):
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── Database types ───────────────────────────────────────────────
// Kept in this file so there is a single source of truth.
// Extend as new tables are added to database/schema.sql.

export interface DbProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  rep: number;
  holder_tier: 'None' | 'Bronze' | 'Silver' | 'Gold';
  wallet_address?: string | null;
  wallet_chain?: string | null;
  username_normalized?: string | null;
  onboarding_completed?: boolean;
  authenticated_at?: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface RugtownProfileState {
  id: string;
  username: string;
  displayName: string | null;
  onboardingCompleted: boolean;
  walletAddress: string | null;
  rep: number;
  level?: number;
  /** Phase 16: full progression fields from get_rugtown_profile_state */
  lifetimeXp?: number;
  rugPoints?: number;
  dailyPoints?: number;
  weeklyPoints?: number;
  progressionCurveVersion?: number;
  streakCurrent?: number | null;
  streakLongest?: number | null;
  streakLastDailyKey?: string | null;
}

export interface DbCharacterAppearance {
  user_id: string;
  skin_tone: string;
  hairstyle: string;
  facial_hair: string;
  hat: string;
  glasses: string;
  accessory: string;
  jacket: string;
  pants: string;
  shoes: string;
  backpack: string;
  handheld: string;
  updated_at: string;
}

export interface DbPlayerBadge {
  id: number;
  user_id: string;
  badge_id: string;
  earned_at: string;
}

export interface DbPlayerInventoryItem {
  id: number;
  user_id: string;
  item_id: string;
  quantity: number;
  acquired_at: string;
}

export interface DbDistrictUnlock {
  user_id: string;
  district_id: string;
  unlocked_at: string;
}

export interface DbWalletVerification {
  user_id: string;
  wallet_address: string;
  chain: string;
  verified_at: string | null;
  token_balance: number | null;
  holder_tier: 'None' | 'Bronze' | 'Silver' | 'Gold' | null;
  updated_at: string;
}

/** Phase 10G+ player progression row (subset used by the client). */
export interface DbPlayerProgression {
  player_id: string;
  schema_version: number;
  lifetime_xp: number;
  level: number;
  rep: number;
  rug_points: number;
  season_id: string | null;
  season_points: number;
  progression_curve_version: number;
  claimed_reward_keys: unknown;
  migrated_from_local: boolean;
  updated_at: string;
}

/** Phase 13 Chapter One mission state (read via RPC; clients cannot write). */
export interface DbChapterMissionState {
  user_id: string;
  mission_id: string;
  mission_version: number;
  status: 'locked' | 'active' | 'completed';
  progress: Record<string, unknown>;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  reward_claimed_at: string | null;
}

/**
 * Locally maintained RPC argument / return shapes for Phase 13+.
 * Not remotely generated — keep in sync with database/migrations.
 */
export interface DbRpcMap {
  ensure_chapter_missions: {
    Args: Record<string, never>;
    Returns: { missions: DbChapterMissionState[] };
  };
  get_my_chapter_missions: {
    Args: Record<string, never>;
    Returns: {
      missions: Array<{
        missionId: string;
        status: DbChapterMissionState['status'];
        missionVersion: number;
        title: string;
        xpReward: number;
        repReward: number;
        missionOrder: number;
        completedAt: string | null;
        rewardClaimedAt: string | null;
      }>;
    };
  };
  complete_chapter_mission: {
    Args: { p_mission_id: string };
    Returns: {
      awarded: boolean;
      duplicate: boolean;
      missionId: string;
      xpAwarded?: number;
      repAwarded?: number;
      progression?: DbPlayerProgression;
    };
  };
  claim_mission_reward: {
    Args: { p_assignment_id: string };
    Returns: {
      claimed: boolean;
      duplicate: boolean;
      assignment?: unknown;
      xpAwarded?: number;
      repAwarded?: number;
      seasonPointsAwarded?: number;
      rugPointsAwarded?: number;
      progression?: DbPlayerProgression;
    };
  };
  migrate_progression_curve_v2: {
    Args: Record<string, never>;
    Returns: {
      migrated: boolean;
      already?: boolean;
      computedLevel?: number;
      grandfatheredLevel?: number;
      progression?: DbPlayerProgression;
    };
  };
  get_rugtown_profile_state: {
    Args: Record<string, never>;
    Returns: RugtownProfileState | null;
  };
  check_username_available: {
    Args: { p_username: string };
    Returns: boolean;
  };
  create_rugtown_profile: {
    Args: { p_username: string };
    Returns: { ok: boolean; username?: string; error?: string };
  };
  get_guild_state: {
    Args: Record<string, never>;
    Returns: unknown;
  };
  assign_daily_guild_contracts: {
    Args: Record<string, never>;
    Returns: unknown;
  };
  claim_guild_contract: {
    Args: { p_contract_id: string };
    Returns: unknown;
  };
  complete_guild_day: {
    Args: Record<string, never>;
    Returns: unknown;
  };
  report_guild_gameplay_event: {
    Args: {
      p_event_type: string;
      p_ref?: string | null;
      p_counterpart_id?: string | null;
      p_idempotency_key?: string | null;
    };
    Returns: unknown;
  };
  record_reward_points: {
    Args: {
      p_source_type: string;
      p_source_id: string;
      p_base_points: number;
      p_idempotency_key: string;
    };
    Returns: unknown;
  };
  get_reward_vault_state: {
    Args: Record<string, never>;
    Returns: unknown;
  };
  claim_epoch_reward: {
    Args: { p_epoch_id: string };
    Returns: unknown;
  };
  refresh_holder_status: {
    Args: { p_balance_base_units?: number | string | null };
    Returns: unknown;
  };
  apply_verified_holder_status: {
    Args: {
      p_user_id: string;
      p_wallet_address: string;
      p_balance_base_units: number | string;
      p_is_stale?: boolean;
      p_refresh_error?: string | null;
    };
    Returns: unknown;
  };
  begin_epoch_reward_claim: {
    Args: { p_epoch_id: string };
    Returns: unknown;
  };
  run_reward_epoch_maintenance: {
    Args: Record<string, never>;
    Returns: unknown;
  };

  // ── Phase 2: progression, missions, hidden quests, leaderboards ──
  ensure_period_missions: {
    Args: { p_period_type: 'daily' | 'weekly' };
    Returns: { periodType: string; periodKey: string; timezone: 'UTC'; assignments: unknown[] };
  };
  claim_daily_completion_bonus: {
    Args: Record<string, never>;
    Returns: { ok: boolean; duplicate?: boolean; reason?: string; claimed?: number; total?: number; progression?: DbPlayerProgression };
  };
  record_daily_participation: {
    Args: Record<string, never>;
    Returns: {
      ok: boolean; duplicate: boolean; currentStreak: number; longestStreak: number;
      milestoneBonus: { streakDays: number; repAwarded: number; pointsAwarded: number } | null;
    };
  };
  get_my_streak: {
    Args: Record<string, never>;
    Returns: { currentStreak: number; longestStreak: number; lastDailyKey: string | null };
  };
  record_activity_heartbeat: {
    Args: Record<string, never>;
    Returns: { ok: boolean; reason?: 'cooldown' | 'daily_cap_reached'; rewardCountToday: number; repAwarded?: number; pointsAwarded?: number };
  };
  discover_hidden_quest: {
    Args: { p_quest_id: string };
    Returns: { ok: boolean; questId: string };
  };
  complete_hidden_quest: {
    Args: { p_quest_id: string };
    Returns: { ok: boolean; duplicate: boolean; reward?: { xp_reward: number; rep_reward: number; points_reward: number }; progression?: DbPlayerProgression };
  };
  get_my_hidden_quests: {
    Args: Record<string, never>;
    Returns: { quests: Array<{ player_id: string; quest_id: string; status: 'discovered' | 'completed'; discovered_at: string; completed_at: string | null }> };
  };
  get_points_leaderboard: {
    Args: { p_period: 'daily' | 'weekly' | 'all_time'; p_limit?: number; p_offset?: number };
    Returns: {
      period: string; limit: number; offset: number;
      rows: Array<{ rank: number; playerId: string; username: string; level: number; rep: number; points: number }>;
    };
  };
  get_my_leaderboard_rank: {
    Args: { p_period: 'daily' | 'weekly' | 'all_time' };
    Returns: { period: string; points: number; rank: number };
  };
  get_leaderboard_history: {
    Args: { p_period_type: 'daily' | 'weekly'; p_period_key: string; p_limit?: number };
    Returns: unknown[];
  };
  settle_weekly_leaderboard: {
    Args: { p_period_key?: string | null };
    Returns: { ok: boolean; duplicate: boolean; periodKey: string; settled: number };
  };
  get_weekly_champions: {
    Args: { p_limit?: number };
    Returns: Array<{ period_key: string; rank: number; player_id: string; username: string; points: number; title_awarded: string | null; settled_at: string }>;
  };
}

// ─── Client ──────────────────────────────────────────────────────

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL      as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * True when both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
 *
 * Always check this flag before calling any Supabase API so that
 * unauthenticated / offline guest mode keeps working unchanged:
 *
 * @example
 * if (isSupabaseConfigured && supabase) {
 *   const { data } = await supabase.from('profiles').select('*');
 * }
 */
export const isSupabaseConfigured: boolean =
  Boolean(supabaseUrl) && Boolean(supabaseAnonKey);

if (!isSupabaseConfigured) {
  // Development-only notice — harmless in production where env vars are set.
  console.info(
    '[RugTown] Supabase env vars not configured — running in guest-only mode.\n' +
    'Copy .env.example → .env.local and add your project credentials to enable accounts.'
  );
}

/**
 * Supabase client — null when env vars are not configured.
 * All consumers must check `isSupabaseConfigured` (or null-guard `supabase`)
 * before use so that guest mode is unaffected.
 *
 * Auth options:
 * - PKCE flow; session persisted in localStorage with auto refresh.
 * - detectSessionInUrl is false — `/auth/callback` exchanges the code once
 *   via `handleAuthCallback()` so we never double-consume the PKCE code.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true,
      },
      realtime: {
        params: { eventsPerSecond: 12 },
      },
    })
  : null;

// Keep Realtime JWT aligned with auth so signed-in presence keys match track().
if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.access_token) {
      void supabase.realtime.setAuth(session.access_token);
    } else if (event === 'SIGNED_OUT') {
      void supabase.realtime.setAuth('');
    }
  });
}

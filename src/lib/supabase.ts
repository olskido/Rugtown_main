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
  created_at: string;
  last_seen_at: string;
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

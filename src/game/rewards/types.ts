/**
 * Reward types — Phase 10G economy identity (separate from REP / XP / season).
 */

export type RewardType =
  | 'XP'
  | 'REP'
  | 'SEASON_POINTS'
  | 'RUG_POINTS'
  | 'TITLE_UNLOCK'
  | 'COSMETIC_UNLOCK'
  | 'CLAIMABLE_REWARD'
  | 'ADMIN_ADJUSTMENT';

export type ClaimStatus =
  | 'pending'
  | 'eligible'
  | 'reserved'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type MissionPeriodType = 'daily' | 'weekly';

export type MissionObjectiveType =
  | 'visit_district'
  | 'visit_landmark'
  | 'discover_landmarks'
  | 'enter_interior'
  | 'meet_player'
  | 'wave_player'
  | 'join_event'
  | 'complete_missions'
  | 'meet_players'
  | 'visit_districts'
  | 'join_events'
  | 'enter_interiors';

export interface RewardEligibility {
  eligible: boolean;
  reasons: string[];
  playerId: string | null;
  campaignId?: string | null;
  amount?: string;
  asset?: string;
  expiresAt?: string;
  snapshotHash?: string;
}

export interface ClaimableReward {
  id: string;
  playerId: string;
  rewardAsset: string;
  amount: string;
  source: string;
  campaignId?: string | null;
  status: ClaimStatus;
  eligibilitySnapshot: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string | null;
  claimedAt?: string | null;
  transactionSignature?: string | null;
}

export interface MissionAssignmentView {
  id: string;
  missionDefinitionId: string;
  periodType: MissionPeriodType;
  periodKey: string;
  progress: number;
  target: number;
  status: 'active' | 'completed' | 'claimed' | 'expired';
  title: string;
  description: string;
  xpReward: number;
  repReward: number;
  seasonPoints: number;
  rugPoints: number;
  objectiveType: MissionObjectiveType;
  objectiveRef?: string | null;
  sponsored?: boolean;
}

export interface ServerProgressionSnapshot {
  player_id: string;
  lifetime_xp: number;
  level: number;
  rep: number;
  rug_points: number;
  season_id: string | null;
  season_points: number;
  equipped_title_id: string | null;
  unlocked_titles: unknown;
  claimed_reward_keys: unknown;
  migrated_from_local: boolean;
  /** Phase 13: 1 = legacy soft curve, 2 = Chapter One slower curve. */
  progression_curve_version?: number;
  /** Phase 16: separate daily/weekly point buckets. */
  daily_points?: number;
  weekly_points?: number;
  updated_at: string;
}

export const RUG_POINTS_DISCLAIMER =
  'Rug Points may be used for eligible campaigns and do not represent guaranteed monetary value.';

export const REWARD_RULES_VERSION = '1';

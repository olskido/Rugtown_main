/**
 * src/lib/hiddenQuests.ts
 * ────────────────────────
 * Server-authoritative discovery/completion for hidden quests. The client
 * (HiddenQuestDirector.ts) detects triggers locally and calls these — the
 * server is what actually persists state and grants rewards, so a player can
 * never receive the same hidden-quest reward twice even across sessions.
 * Guests: calls are no-ops (state stays client-only, matching guest mode
 * everywhere else in RugTown — see profile.ts's null-guard convention).
 */

import { supabase } from './supabase';

export interface HiddenQuestServerState {
  playerId: string;
  questId: string;
  status: 'discovered' | 'completed';
  discoveredAt: string;
  completedAt: string | null;
}

/** Record a new discovery. Idempotent — safe to call again for an already-discovered quest. */
export async function discoverHiddenQuest(questId: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.rpc('discover_hidden_quest', { p_quest_id: questId });
  return !error;
}

export interface CompleteHiddenQuestResult {
  ok: boolean;
  duplicate: boolean;
  xpAwarded?: number;
  repAwarded?: number;
  pointsAwarded?: number;
}

/** Record completion + claim the reward. Idempotent — a duplicate call never double-grants. */
export async function completeHiddenQuest(questId: string): Promise<CompleteHiddenQuestResult> {
  if (!supabase) return { ok: false, duplicate: false };
  const { data, error } = await supabase.rpc('complete_hidden_quest', { p_quest_id: questId });
  if (error || !data || typeof data !== 'object') return { ok: false, duplicate: false };
  const o = data as Record<string, unknown>;
  const reward = o.reward as Record<string, unknown> | undefined;
  return {
    ok: o.ok === true,
    duplicate: o.duplicate === true,
    xpAwarded: reward ? Number(reward.xp_reward ?? 0) : undefined,
    repAwarded: reward ? Number(reward.rep_reward ?? 0) : undefined,
    pointsAwarded: reward ? Number(reward.points_reward ?? 0) : undefined,
  };
}

/** Server-side discovered/completed quest ids for the current player (authoritative — call on session start to reconcile with local cache). */
export async function getMyHiddenQuests(): Promise<HiddenQuestServerState[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('get_my_hidden_quests');
  if (error || !data || typeof data !== 'object') return [];
  const rows = (data as Record<string, unknown>).quests;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      playerId: String(o.player_id ?? ''),
      questId: String(o.quest_id ?? ''),
      status: (o.status === 'completed' ? 'completed' : 'discovered') as 'discovered' | 'completed',
      discoveredAt: String(o.discovered_at ?? ''),
      completedAt: (o.completed_at ?? null) as string | null,
    };
  });
}

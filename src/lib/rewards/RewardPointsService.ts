import { supabase } from '../supabase';

/** Default RP grant for qualifying mission completions (holder multiplier applied server-side). */
export const DEFAULT_MISSION_RP = 50;

export async function recordRewardPoints(opts: {
  sourceType: string;
  sourceId: string;
  basePoints: number;
  idempotencyKey: string;
}): Promise<{ recorded: boolean; duplicate?: boolean }> {
  if (!supabase) return { recorded: false };
  const { data, error } = await supabase.rpc('record_reward_points', {
    p_source_type: opts.sourceType,
    p_source_id: opts.sourceId,
    p_base_points: opts.basePoints,
    p_idempotency_key: opts.idempotencyKey,
  });
  if (error) return { recorded: false };
  const o = (data ?? {}) as Record<string, unknown>;
  return {
    recorded: o.recorded === true,
    duplicate: o.duplicate === true,
  };
}

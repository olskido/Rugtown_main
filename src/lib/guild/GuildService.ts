import { supabase } from '../supabase';

export interface GuildContractView {
  id: string;
  code: string;
  title: string;
  description: string;
  contractType: 'daily' | 'bounty';
  difficulty: string;
  progress: number;
  target: number;
  status: 'active' | 'completed' | 'claimed' | 'expired';
  repReward: number;
}

export interface GuildStateView {
  dailyContracts: GuildContractView[];
  bounties: GuildContractView[];
  streak: { current: number; longest: number; lastCompletedDay: string | null };
  dailyCompletionBonusRep: number;
  allDailiesComplete: boolean;
}

function mapContract(raw: Record<string, unknown>): GuildContractView {
  return {
    id: String(raw.id ?? ''),
    code: String(raw.code ?? raw.definition_id ?? ''),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    contractType: (raw.contract_type ?? raw.contractType ?? 'daily') as 'daily' | 'bounty',
    difficulty: String(raw.difficulty ?? 'easy'),
    progress: Number(raw.progress ?? 0),
    target: Number(raw.target ?? 1),
    status: (raw.status as GuildContractView['status']) ?? 'active',
    repReward: Number(raw.rep_reward ?? raw.repReward ?? 0),
  };
}

function asContractArray(raw: unknown): GuildContractView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => mapContract(r as Record<string, unknown>));
}

export async function fetchGuildState(): Promise<GuildStateView | null> {
  if (!supabase) return null;
  try {
    await supabase.rpc('assign_daily_guild_contracts');
    await supabase.rpc('assign_guild_bounties');
  } catch { /* pre-migration */ }
  const { data, error } = await supabase.rpc('get_guild_state');
  if (error || !data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const streakRaw = (o.streak ?? {}) as Record<string, unknown>;
  return {
    dailyContracts: asContractArray(o.dailyContracts ?? o.daily_contracts),
    bounties: asContractArray(o.bounties),
    streak: {
      current: Number(streakRaw.current ?? streakRaw.current_streak ?? 0),
      longest: Number(streakRaw.longest ?? streakRaw.longest_streak ?? 0),
      lastCompletedDay: (streakRaw.lastCompletedDay ?? streakRaw.last_completed_day ?? null) as string | null,
    },
    dailyCompletionBonusRep: Number(o.dailyCompletionBonusRep ?? o.daily_completion_bonus_rep ?? 250),
    allDailiesComplete: o.allDailiesComplete === true || o.all_dailies_complete === true,
  };
}

export async function claimGuildContract(contractId: string): Promise<{
  ok: boolean;
  repAwarded?: number;
  dailyBonusRep?: number;
  error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Not configured' };
  const { data, error } = await supabase.rpc('claim_guild_contract', { p_contract_id: contractId });
  if (error) return { ok: false, error: error.message };
  const o = (data ?? {}) as Record<string, unknown>;
  const day = (o.dailyCompletion ?? o.daily_completion ?? null) as Record<string, unknown> | null;
  return {
    ok: o.claimed === true || o.ok === true,
    repAwarded: Number(o.rep_awarded ?? o.repAwarded ?? 0),
    dailyBonusRep: day ? Number(day.repAwarded ?? day.rep_awarded ?? 0) : undefined,
    error: o.error ? String(o.error) : undefined,
  };
}

export async function completeGuildDay(): Promise<{ ok: boolean; bonusRep?: number }> {
  if (!supabase) return { ok: false };
  const { data } = await supabase.rpc('complete_guild_day');
  const o = (data ?? {}) as Record<string, unknown>;
  return { ok: o.ok === true || o.completed === true, bonusRep: Number(o.bonus_rep ?? o.bonusRep ?? 0) };
}

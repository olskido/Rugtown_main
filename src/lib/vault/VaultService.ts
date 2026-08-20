import { supabase } from '../supabase';
import { formatTokenBaseUnits } from '../../config/rewardConfig';

export interface VaultStateView {
  walletAddress: string | null;
  holderTier: string;
  rpMultiplier: number;
  rewardPoints: number;
  claimableTokenBaseUnits: bigint;
  lifetimeClaimedBaseUnits: bigint;
  pendingEpochId: string | null;
  epochStatus: string | null;
  holderStale: boolean;
  settlementMode: string;
}

export async function fetchVaultState(): Promise<VaultStateView | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_reward_vault_state');
  if (error || !data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;

  const hs = (o.holderStatus ?? o.holder_status ?? null) as Record<string, unknown> | null;
  const epoch = (o.currentEpoch ?? o.current_epoch ?? null) as Record<string, unknown> | null;
  const claimable = Array.isArray(o.claimableRewards ?? o.claimable_rewards)
    ? (o.claimableRewards ?? o.claimable_rewards) as Record<string, unknown>[]
    : [];

  const pending = claimable.find((r) =>
    ['claimable', 'processing', 'pending', 'failed'].includes(String(r.status ?? '')),
  ) ?? claimable[0];

  const projected = BigInt(String(o.projectedTokenBaseUnits ?? o.projected_token_base_units ?? 0));
  const claimableAmount = pending
    ? BigInt(String(pending.token_amount_base_units ?? pending.tokenAmountBaseUnits ?? 0))
    : projected;

  return {
    walletAddress: (hs?.wallet_address ?? hs?.walletAddress ?? null) as string | null,
    holderTier: String(hs?.holder_tier ?? hs?.holderTier ?? 'none'),
    rpMultiplier: Number(hs?.rp_multiplier ?? hs?.rpMultiplier ?? 1),
    rewardPoints: Number(o.epochEffectivePoints ?? o.epoch_effective_points ?? 0),
    claimableTokenBaseUnits: claimableAmount,
    lifetimeClaimedBaseUnits: BigInt(String(o.lifetimeClaimedBaseUnits ?? o.lifetime_claimed_base_units ?? 0)),
    pendingEpochId: (pending?.epoch_id ?? pending?.epochId ?? epoch?.id ?? null) as string | null,
    epochStatus: String(epoch?.status ?? 'open'),
    holderStale: hs?.is_stale === true || hs?.isStale === true,
    settlementMode: String(o.settlementMode ?? o.settlement_mode ?? 'disabled'),
  };
}

/** Claim via trusted edge function (production) or dev RPC fallback. */
export async function claimEpochReward(epochId: string): Promise<{
  ok: boolean;
  signature?: string;
  error?: string;
  devMode?: boolean;
}> {
  if (!supabase) return { ok: false, error: 'Not configured' };

  const { data, error } = await supabase.functions.invoke('claim-rugtown-reward', {
    body: { epochId },
  });

  if (error) return { ok: false, error: error.message };

  const o = (data ?? {}) as Record<string, unknown>;
  if (o.claimed === true || o.ok === true) {
    return {
      ok: true,
      signature: (o.signature ?? (o.reward as Record<string, unknown> | undefined)?.transaction_signature) as string | undefined,
      devMode: o.devMode === true,
    };
  }

  return {
    ok: false,
    error: String(o.error ?? o.message ?? o.reason ?? 'Claim failed'),
  };
}

export function formatVaultTokens(baseUnits: bigint): string {
  return formatTokenBaseUnits(baseUnits);
}

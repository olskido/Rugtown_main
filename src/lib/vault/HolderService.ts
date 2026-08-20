import { supabase } from '../supabase';

export interface HolderStatusView {
  holderTier: string;
  rpMultiplier: number;
  balanceBaseUnits: bigint;
  walletAddress: string | null;
  isStale: boolean;
  cached: boolean;
}

function mapHolder(raw: Record<string, unknown> | null): HolderStatusView | null {
  if (!raw) return null;
  return {
    holderTier: String(raw.holder_tier ?? raw.holderTier ?? 'none'),
    rpMultiplier: Number(raw.rp_multiplier ?? raw.rpMultiplier ?? 1),
    balanceBaseUnits: BigInt(String(raw.token_balance_base_units ?? raw.tokenBalanceBaseUnits ?? 0)),
    walletAddress: (raw.wallet_address ?? raw.walletAddress ?? null) as string | null,
    isStale: raw.is_stale === true || raw.isStale === true,
    cached: false,
  };
}

/** Server-verified holder refresh via edge function. Never sends balance from browser. */
export async function refreshHolderStatus(opts?: { force?: boolean }): Promise<{
  ok: boolean;
  status: HolderStatusView | null;
  error?: string;
  refreshFailed?: boolean;
}> {
  if (!supabase) return { ok: false, status: null, error: 'Not configured' };

  const { data, error } = await supabase.functions.invoke('refresh-holder-status', {
    body: { force: opts?.force ?? false },
  });

  if (error) {
    return { ok: false, status: null, error: error.message, refreshFailed: true };
  }

  const o = (data ?? {}) as Record<string, unknown>;
  const hs = mapHolder((o.holderStatus ?? o.holder_status ?? null) as Record<string, unknown> | null);
  if (hs) hs.cached = o.cached === true;

  return {
    ok: o.ok === true,
    status: hs,
    refreshFailed: o.refreshFailed === true,
    error: o.ok === false ? String(o.code ?? o.message ?? 'refresh_failed') : undefined,
  };
}

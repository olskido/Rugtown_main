/**
 * _shared/holder.ts — holder tier thresholds (mirror rewardConfig / rt_holder_tier_from_balance).
 */

export interface HolderTierResult {
  holderTier: string;
  rpMultiplier: number;
}

const TIERS: Array<{ tier: string; mult: number; minBal: bigint }> = [
  { tier: 'whale', mult: 1.5, minBal: 250_000_000_000n },
  { tier: 'gold', mult: 1.25, minBal: 50_000_000_000n },
  { tier: 'silver', mult: 1.1, minBal: 10_000_000_000n },
  { tier: 'holder', mult: 1.05, minBal: 1_000_000_000n },
  { tier: 'none', mult: 1.0, minBal: 0n },
];

export function tierFromBalanceBaseUnits(balance: bigint): HolderTierResult {
  let matched = TIERS[TIERS.length - 1];
  for (const t of TIERS) {
    if (balance >= t.minBal) {
      matched = t;
      break;
    }
  }
  return { holderTier: matched.tier, rpMultiplier: matched.mult };
}

export function isCacheFresh(lastCheckedAt: string | null | undefined, cacheSeconds: number): boolean {
  if (!lastCheckedAt) return false;
  const ageMs = Date.now() - new Date(lastCheckedAt).getTime();
  return ageMs >= 0 && ageMs < cacheSeconds * 1000;
}

/**
 * Holder tiers + reward epoch configuration (launch defaults).
 * Production values may be overridden via env / database config tables.
 */

export type HolderTierId = 'none' | 'holder' | 'silver' | 'gold' | 'whale';

export interface HolderTierConfig {
  id: HolderTierId;
  label: string;
  minBalanceBaseUnits: bigint;
  rpMultiplier: number;
}

/** 6 decimals assumed for $RUGTOWN SPL token unless configured otherwise. */
export const TOKEN_DECIMALS = 6;

function units(n: number): bigint {
  return BigInt(Math.floor(n * 10 ** TOKEN_DECIMALS));
}

export const HOLDER_TIER_CONFIG: HolderTierConfig[] = [
  { id: 'none', label: 'None', minBalanceBaseUnits: 0n, rpMultiplier: 1 },
  { id: 'holder', label: 'Holder', minBalanceBaseUnits: units(1_000), rpMultiplier: 1.05 },
  { id: 'silver', label: 'Silver', minBalanceBaseUnits: units(10_000), rpMultiplier: 1.1 },
  { id: 'gold', label: 'Gold', minBalanceBaseUnits: units(50_000), rpMultiplier: 1.25 },
  { id: 'whale', label: 'Whale', minBalanceBaseUnits: units(250_000), rpMultiplier: 1.5 },
];

export const DAILY_REWARD_POOL_BASE_UNITS = units(10_000); // dev default — override in DB epoch
export const MIN_CLAIM_BASE_UNITS = units(1);
export const EPOCH_DURATION_HOURS = 24;

export function tierFromBalance(balanceBaseUnits: bigint): HolderTierConfig {
  let matched = HOLDER_TIER_CONFIG[0];
  for (const t of HOLDER_TIER_CONFIG) {
    if (balanceBaseUnits >= t.minBalanceBaseUnits) matched = t;
  }
  return matched;
}

export function formatTokenBaseUnits(units: bigint, decimals = TOKEN_DECIMALS): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

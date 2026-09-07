/**
 * src/lib/wallet.ts
 * ─────────────────
 * Wallet address utilities — validation, formatting, and the Supabase
 * boundary for saving a player's wallet address.
 *
 * Only Robinhood Chain (EVM / 0x) is supported for player-facing onboarding.
 * The Solana infrastructure in src/lib/wallet/ is preserved but is deferred.
 */

import { supabase } from './supabase';

// ─── Constants ──────────────────────────────────────────────────────────────

export const ROBINHOOD_CHAIN_ID = 'robinhood';

/** Regex for a valid EVM address: 0x followed by exactly 40 hex characters. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Returns null if `addr` is a valid Robinhood Chain (EVM) public address,
 * or a human-readable error string if it is not.
 */
export function validateRobinhoodAddress(addr: string): string | null {
  const trimmed = addr.trim();
  if (!trimmed) return 'Wallet address is required.';
  if (!trimmed.startsWith('0x')) {
    return 'A Robinhood Chain address must start with 0x.';
  }
  if (trimmed.length !== 42) {
    return `Address must be 42 characters (got ${trimmed.length}).`;
  }
  if (!EVM_ADDRESS_RE.test(trimmed)) {
    return 'Address contains invalid characters. Only 0-9 and a-f are allowed after 0x.';
  }
  return null;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Shorten an address for display: first 6 + "…" + last 4 chars.
 * e.g. "0x742d…91A3"
 * Returns the full address unchanged if it is too short to truncate.
 */
export function shortenAddress(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * Human-readable chain label for profile display.
 */
export function chainLabel(chain: string | null | undefined): string {
  switch (chain) {
    case 'robinhood': return 'Robinhood Chain';
    case 'solana':    return 'Solana';
    default:          return chain ?? 'Unknown';
  }
}

// ─── Supabase boundary ──────────────────────────────────────────────────────

export interface SaveWalletResult {
  ok: boolean;
  walletAddress?: string;
  walletChain?: string;
  /** Server-side error code, e.g. 'wallet_already_linked' | 'invalid_evm_address' */
  error?: string;
  message?: string;
}

/**
 * Persist the player's Robinhood Chain wallet address via the
 * save_wallet_address SECURITY DEFINER RPC (Phase 17).
 *
 * The server validates format, checks for duplicate ownership, normalises the
 * address to lowercase hex, and sets onboarding_completed = true.
 *
 * Returns { ok: false } with a human-readable `message` on any failure so
 * the caller can surface it directly in the UI.
 */
export async function saveWalletAddress(
  walletAddress: string,
  walletChain: string = ROBINHOOD_CHAIN_ID,
): Promise<SaveWalletResult> {
  if (!supabase) {
    return { ok: false, error: 'supabase_not_configured', message: 'Supabase is not configured.' };
  }

  const { data, error } = await supabase.rpc('save_wallet_address', {
    p_wallet_address: walletAddress.trim(),
    p_wallet_chain:   walletChain,
  });

  if (error) {
    // Postgres-level exception (e.g. auth required, constraint violation)
    return {
      ok: false,
      error: 'rpc_error',
      message: error.message ?? 'Could not save wallet address. Please try again.',
    };
  }

  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'unexpected_response', message: 'Unexpected server response.' };
  }

  const o = data as Record<string, unknown>;

  if (!o.ok) {
    const code = String(o.error ?? 'unknown');
    const msg  = String(o.message ?? '');

    // Surface the most useful message per error code.
    const friendly: Record<string, string> = {
      wallet_already_linked:
        'This wallet is already linked to another RugTown account.',
      invalid_evm_address:
        'That doesn\'t look like a valid Robinhood Chain address. It must start with 0x and be 42 characters.',
      wallet_address_empty: 'Please enter your wallet address.',
      unsupported_chain:    'Unsupported chain.',
      profile_not_found:    'Profile not found. Please sign in again.',
    };

    return {
      ok: false,
      error: code,
      message: friendly[code] ?? msg ?? 'Could not save wallet address.',
    };
  }

  return {
    ok:            true,
    walletAddress: String(o.walletAddress ?? ''),
    walletChain:   String(o.walletChain   ?? ROBINHOOD_CHAIN_ID),
  };
}

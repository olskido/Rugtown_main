/**
 * refresh-holder-status
 * Server-side Solana SPL balance verification for authenticated players.
 * Never trusts client-reported balances.
 */

import { authenticate } from '../_shared/auth.ts';
import { handlePreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse, HandledError } from '../_shared/errors.ts';
import { loadSettlementEnv, loadTokenIntegrationEnv } from '../_shared/env.ts';
import { readBalanceAtomic } from '../_shared/solana.ts';
import { isCacheFresh } from '../_shared/holder.ts';
import { parseJson } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  try {
    const ctx = await authenticate(req);
    const tokenEnv = loadTokenIntegrationEnv();
    const body = await parseJson<{ force?: boolean }>(req).catch(() => ({}));
    const force = body.force === true;

    const { data: profile, error: pErr } = await ctx.admin
      .from('profiles')
      .select('wallet_address')
      .eq('id', ctx.userId)
      .maybeSingle();
    if (pErr) throw new HandledError('profile_error', 'Could not load profile', 500);

    const wallet = profile?.wallet_address?.trim();
    if (!wallet) {
      throw new HandledError('no_wallet', 'No wallet linked to this account', 400);
    }

    const { data: cached } = await ctx.admin
      .from('holder_status')
      .select('*')
      .eq('user_id', ctx.userId)
      .maybeSingle();

    if (
      cached &&
      !force &&
      isCacheFresh(cached.last_checked_at, tokenEnv.balanceCacheSeconds)
    ) {
      return jsonResponse(req, {
        ok: true,
        cached: true,
        holderStatus: cached,
      });
    }

    if (!tokenEnv.enabled || !tokenEnv.mintAddress) {
      const { data: applied, error: aErr } = await ctx.admin.rpc('apply_verified_holder_status', {
        p_user_id: ctx.userId,
        p_wallet_address: wallet,
        p_balance_base_units: 0,
        p_is_stale: false,
        p_refresh_error: null,
      });
      if (aErr) throw new HandledError('apply_failed', aErr.message, 500);
      return jsonResponse(req, {
        ok: true,
        tokenDisabled: true,
        holderStatus: applied?.holderStatus ?? null,
      });
    }

    const env = loadSettlementEnv();
    const balance = await readBalanceAtomic(env.rpcEndpoint, wallet, tokenEnv.mintAddress);

    if (!balance) {
      if (cached && isCacheFresh(cached.last_checked_at, tokenEnv.balanceCacheSeconds * 10)) {
        return jsonResponse(req, {
          ok: true,
          cached: true,
          stale: true,
          refreshFailed: true,
          holderStatus: { ...cached, is_stale: true },
          message: 'Solana RPC unavailable — using last verified status',
        });
      }

      const { data: staleApplied, error: sErr } = await ctx.admin.rpc('apply_verified_holder_status', {
        p_user_id: ctx.userId,
        p_wallet_address: wallet,
        p_balance_base_units: cached?.token_balance_base_units ?? 0,
        p_is_stale: true,
        p_refresh_error: 'rpc_unavailable',
      });
      if (sErr) throw new HandledError('apply_failed', sErr.message, 500);

      return jsonResponse(req, {
        ok: false,
        refreshFailed: true,
        code: 'rpc_unavailable',
        holderStatus: staleApplied?.holderStatus ?? cached,
      }, 503);
    }

    const { data: applied, error: aErr } = await ctx.admin.rpc('apply_verified_holder_status', {
      p_user_id: ctx.userId,
      p_wallet_address: wallet,
      p_balance_base_units: balance.atomic,
      p_is_stale: false,
      p_refresh_error: null,
    });
    if (aErr) throw new HandledError('apply_failed', aErr.message, 500);

    return jsonResponse(req, {
      ok: true,
      cached: false,
      holderStatus: applied?.holderStatus,
      balanceBaseUnits: balance.atomic,
      slot: balance.slot,
    });
  } catch (e) {
    if (e instanceof HandledError) {
      return errorResponse(req, e.code, e.message, e.status);
    }
    return errorResponse(req, 'internal', 'Holder refresh failed', 500);
  }
});

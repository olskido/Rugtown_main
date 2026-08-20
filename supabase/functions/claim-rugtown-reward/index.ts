/**
 * claim-rugtown-reward
 * Production SPL settlement for player epoch rewards.
 * SETTLEMENT_MODE=disabled returns dev confirmation without chain transfer.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { authenticate } from '../_shared/auth.ts';
import { handlePreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse, HandledError } from '../_shared/errors.ts';
import { loadSettlementEnv, loadTokenIntegrationEnv, requireEnv } from '../_shared/env.ts';
import { parseJson, requireString } from '../_shared/validation.ts';
import { transferSplTokens, readTreasuryBalances } from '../_shared/spl-transfer.ts';
import { verifyTransaction } from '../_shared/solana.ts';

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  try {
    const ctx = await authenticate(req);
    const env = loadSettlementEnv();
    const tokenEnv = loadTokenIntegrationEnv();
    const body = await parseJson<{ epochId: string }>(req);
    const epochId = requireString(body.epochId, 'epochId', 64);

    const userClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
      global: { headers: { Authorization: `Bearer ${ctx.token}` } },
    });

    const { data: begin, error: bErr } = await userClient.rpc('begin_epoch_reward_claim', {
      p_epoch_id: epochId,
    });
    if (bErr) throw new HandledError('begin_failed', bErr.message, 400);
    if (!begin?.ok) {
      return jsonResponse(req, { ok: false, ...begin }, 400);
    }

    const reward = begin.reward as Record<string, unknown>;
    const rewardId = String(reward.id);
    const amount = BigInt(String(reward.token_amount_base_units ?? 0));
    const walletAddress = String(begin.walletAddress ?? reward.destination_wallet ?? '');

    if (env.settlementMode === 'disabled') {
      const { data: done, error: dErr } = await ctx.admin.rpc('complete_epoch_reward_claim', {
        p_reward_id: rewardId,
        p_transaction_signature: 'dev:settlement_disabled',
      });
      if (dErr) throw new HandledError('complete_failed', dErr.message, 500);
      return jsonResponse(req, { ok: true, claimed: true, devMode: true, reward: done?.reward });
    }

    if (env.settlementMode !== 'enabled') {
      throw new HandledError('settlement_disabled', 'Settlement is not enabled', 503);
    }

    const existingSig = begin.recover ? String(reward.transaction_signature ?? '') : '';
    if (existingSig) {
      const verified = await verifyTransaction({
        rpcEndpoint: env.rpcEndpoint,
        signature: existingSig,
        expectedDestination: walletAddress,
        expectedAmountAtomic: Number(amount),
        assetType: 'SPL',
        expectedMint: tokenEnv.mintAddress ?? undefined,
        expectedDecimals: 6,
        minConfirmation: env.minConfirmations as 'finalized',
        approvedAtMs: Date.now() - env.verificationTimeoutMs,
        verificationWindowMs: env.verificationTimeoutMs * 4,
      });
      if (verified.verified) {
        const { data: done } = await ctx.admin.rpc('complete_epoch_reward_claim', {
          p_reward_id: rewardId,
          p_transaction_signature: existingSig,
        });
        return jsonResponse(req, { ok: true, claimed: true, recovered: true, signature: existingSig, reward: done?.reward });
      }
    }

    const treasurySecret = requireEnv('RUGTOWN_REWARD_TREASURY_SECRET');
    const treasuryPublic = env.treasuryPublicAddress;
    if (!treasuryPublic) throw new HandledError('config_error', 'TREASURY_PUBLIC_ADDRESS not configured', 500);
    if (!tokenEnv.mintAddress) throw new HandledError('config_error', 'RUGTOWN_TOKEN_MINT_ADDRESS not configured', 500);

    const treasuryBal = await readTreasuryBalances(env.rpcEndpoint, treasuryPublic, tokenEnv.mintAddress);
    if (!treasuryBal || treasuryBal.tokenBaseUnits < amount) {
      await ctx.admin.rpc('fail_epoch_reward_claim', {
        p_reward_id: rewardId,
        p_failure_code: 'insufficient_treasury',
        p_failure_message: 'Treasury token balance insufficient',
      });
      throw new HandledError('insufficient_treasury', 'Treasury cannot cover this reward yet', 503);
    }
    if (treasuryBal.solLamports < 5000n) {
      await ctx.admin.rpc('fail_epoch_reward_claim', {
        p_reward_id: rewardId,
        p_failure_code: 'insufficient_sol',
        p_failure_message: 'Treasury SOL balance too low for fees',
      });
      throw new HandledError('insufficient_sol', 'Treasury SOL too low for transaction fees', 503);
    }

    let signature: string;
    try {
      const result = await transferSplTokens({
        rpcEndpoint: env.rpcEndpoint,
        treasurySecret,
        mintAddress: tokenEnv.mintAddress,
        recipientWallet: walletAddress,
        amountBaseUnits: amount,
        minConfirmations: env.minConfirmations as 'confirmed' | 'finalized',
      });
      signature = result.signature;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'transfer_failed';
      await ctx.admin.rpc('fail_epoch_reward_claim', {
        p_reward_id: rewardId,
        p_failure_code: 'transfer_failed',
        p_failure_message: msg.slice(0, 500),
      });
      throw new HandledError('transfer_failed', 'Token transfer failed — reward remains claimable', 502);
    }

    await ctx.admin.rpc('store_epoch_reward_signature', {
      p_reward_id: rewardId,
      p_transaction_signature: signature,
    });

    const { data: done, error: cErr } = await ctx.admin.rpc('complete_epoch_reward_claim', {
      p_reward_id: rewardId,
      p_transaction_signature: signature,
    });
    if (cErr) throw new HandledError('complete_failed', cErr.message, 500);

    return jsonResponse(req, {
      ok: true,
      claimed: true,
      signature,
      reward: done?.reward,
    });
  } catch (e) {
    if (e instanceof HandledError) {
      return errorResponse(req, e.code, e.message, e.status);
    }
    return errorResponse(req, 'internal', 'Claim failed', 500);
  }
});

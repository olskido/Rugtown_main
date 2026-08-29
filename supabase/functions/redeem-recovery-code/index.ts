/**
 * redeem-recovery-code
 * ─────────────────────
 * Phase 3 lightweight-account system. Lets a player resume their EXISTING
 * account on a new device/browser using the 10-character recovery code
 * shown once in their Profile panel (see generate_my_recovery_code() in
 * database/migrations/20260823_phase3_recovery_code_auth.sql).
 *
 * Deliberately NOT a plain RPC: a Postgres function runs as the caller's
 * current auth.uid(), which is null (or a different account entirely) on a
 * device that has never seen this account before -- there is no way for a
 * client-scoped RPC to "become" a different existing user. Minting a real
 * session for an existing account requires the service-role key, which
 * must never leave the server -- hence this Edge Function.
 *
 * Mechanism: the code hashes to a known player_id. That account is given a
 * synthetic, never-emailed "address" (idempotent -- it's an internal
 * routing key, not a real mailbox) so the Admin API's generateLink() can
 * issue a magic-link token for it. The token is returned to the browser,
 * which exchanges it via supabase.auth.verifyOtp({ type: 'magiclink' }) to
 * get a genuine session -- the same mechanism Supabase's own passwordless
 * email flow uses, just without ever actually sending an email.
 *
 * Unauthenticated by design (the whole point is the caller has no session
 * yet) -- protected instead by hashed-only code storage + IP rate limiting.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handlePreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse, HandledError } from '../_shared/errors.ts';
import { parseJson, requireString } from '../_shared/validation.ts';
import { requireEnv } from '../_shared/env.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

const MAX_ATTEMPTS_PER_WINDOW = 8;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RECOVERY_EMAIL_DOMAIN = 'internal.rugtown.app'; // never sent to; routing key only

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const body = await parseJson<{ code: string }>(req);
    const normalized = requireString(body.code, 'code', 24).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length !== 10) {
      throw new HandledError('bad_request', 'Codes are 10 characters.', 400);
    }

    // ── Rate limit (best-effort, by caller IP) ──────────────────────────
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rateKey = `ip:${ip}`;
    const now = new Date();
    const { data: rl } = await admin
      .from('recovery_code_rate_limit')
      .select('window_start, attempt_count')
      .eq('rate_key', rateKey)
      .maybeSingle();

    if (rl && now.getTime() - new Date(rl.window_start as string).getTime() < WINDOW_MS) {
      if ((rl.attempt_count as number) >= MAX_ATTEMPTS_PER_WINDOW) {
        throw new HandledError('rate_limited', 'Too many attempts. Try again in a few minutes.', 429);
      }
      await admin
        .from('recovery_code_rate_limit')
        .update({ attempt_count: (rl.attempt_count as number) + 1 })
        .eq('rate_key', rateKey);
    } else {
      await admin
        .from('recovery_code_rate_limit')
        .upsert({ rate_key: rateKey, window_start: now.toISOString(), attempt_count: 1 });
    }

    // ── Look up the code by hash ─────────────────────────────────────────
    const hashHex = await sha256Hex(normalized);
    const { data: match } = await admin
      .from('account_recovery_codes')
      .select('player_id')
      .eq('code_hash', hashHex)
      .maybeSingle();

    if (!match) {
      throw new HandledError('invalid_code', "That code doesn't match any account.", 404);
    }
    const playerId = match.player_id as string;

    // ── Ensure a synthetic, pre-confirmed email exists for this account
    //    (idempotent -- setting the same value again is a harmless no-op),
    //    then mint a magic-link token for it. ──────────────────────────
    const syntheticEmail = `recovery+${playerId}@${RECOVERY_EMAIL_DOMAIN}`;
    const { error: updateErr } = await admin.auth.admin.updateUserById(playerId, {
      email: syntheticEmail,
      email_confirm: true,
    });
    if (updateErr && !/already been registered|already exists/i.test(updateErr.message ?? '')) {
      console.error('redeem-recovery-code: updateUserById failed', updateErr);
      throw new HandledError('internal', 'Could not prepare this account for restore.', 500);
    }

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: syntheticEmail,
    });
    const hashedToken = link?.properties?.hashed_token as string | undefined;
    if (linkErr || !hashedToken) {
      console.error('redeem-recovery-code: generateLink failed', linkErr);
      throw new HandledError('internal', 'Could not generate a restore link.', 500);
    }

    // Successful redemption -- clear this IP's counter so a legitimate
    // player who mistyped a few times isn't penalized afterward.
    await admin.from('recovery_code_rate_limit').delete().eq('rate_key', rateKey);

    return jsonResponse(req, { ok: true, tokenHash: hashedToken });
  } catch (e) {
    if (e instanceof HandledError) return errorResponse(req, e.code, e.message, e.status);
    console.error('redeem-recovery-code: unexpected error', e);
    return errorResponse(req, 'internal', 'Unexpected error', 500);
  }
});

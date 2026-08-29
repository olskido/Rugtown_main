/**
 * src/lib/recoveryCode.ts
 * ─────────────────────────
 * Phase 3 lightweight-account system. Two halves:
 *   - generateMyRecoveryCode() / hasMyRecoveryCode() — plain RPCs, called
 *     while already signed in (Profile panel "Recovery Code" section).
 *   - redeemRecoveryCode(code) — calls the redeem-recovery-code Edge
 *     Function (unauthenticated; the whole point is the caller has no
 *     session on this device yet), then exchanges the returned token for a
 *     real Supabase session via verifyOtp(). Once that resolves, the
 *     existing onAuthStateChange('SIGNED_IN', ...) handler in App.tsx takes
 *     over exactly as it does for any other sign-in.
 */
import { supabase } from './supabase';

export interface RecoveryCodeStatus {
  hasCode: boolean;
  createdAt: string | null;
}

/** (Re)generates the current player's recovery code. Returns the PLAINTEXT
 *  code exactly once — the server never stores it, only its hash, so this
 *  is the only chance to see/copy it until the player regenerates again
 *  (which invalidates whatever code was shown here). */
export async function generateMyRecoveryCode(): Promise<{ ok: boolean; code: string | null; error?: string }> {
  if (!supabase) return { ok: false, code: null, error: 'Not configured' };
  const { data, error } = await supabase.rpc('generate_my_recovery_code');
  if (error) return { ok: false, code: null, error: error.message };
  return { ok: data?.ok === true, code: data?.code ?? null };
}

/** Whether the current player already has a code saved (and when), without
 *  ever exposing the code itself. */
export async function hasMyRecoveryCode(): Promise<RecoveryCodeStatus> {
  if (!supabase) return { hasCode: false, createdAt: null };
  const { data, error } = await supabase.rpc('has_my_recovery_code');
  if (error || !data) return { hasCode: false, createdAt: null };
  return { hasCode: data.hasCode === true, createdAt: data.createdAt ?? null };
}

export type RedeemRecoveryCodeResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'invalid_code' | 'rate_limited' | 'network' | 'session_failed'; message: string };

/** Resumes an existing account on this device using a recovery code.
 *  Signs out of any current (guest/anonymous) session first, so the new
 *  session cleanly replaces it rather than merging. */
export async function redeemRecoveryCode(rawCode: string): Promise<RedeemRecoveryCodeResult> {
  if (!supabase) return { ok: false, reason: 'not_configured', message: 'Not configured' };

  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 10) {
    return { ok: false, reason: 'invalid_code', message: 'Codes are 10 characters — check for typos.' };
  }

  try {
    await supabase.auth.signOut();
  } catch { /* ignore — proceeding either way */ }

  const { data, error } = await supabase.functions.invoke('redeem-recovery-code', {
    body: { code },
  });
  if (error) {
    const status = (error as { context?: { response?: { status?: number } } }).context?.response?.status;
    if (status === 429) return { ok: false, reason: 'rate_limited', message: 'Too many attempts — wait a few minutes and try again.' };
    if (status === 404) return { ok: false, reason: 'invalid_code', message: "That code doesn't match any account." };
    return { ok: false, reason: 'network', message: error.message || 'Could not reach the server.' };
  }

  const tokenHash = (data as { tokenHash?: string } | null)?.tokenHash;
  if (!tokenHash) {
    return { ok: false, reason: 'invalid_code', message: "That code doesn't match any account." };
  }

  const { error: otpError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (otpError) {
    return { ok: false, reason: 'session_failed', message: 'Could not restore your session. Please try again.' };
  }

  return { ok: true };
}

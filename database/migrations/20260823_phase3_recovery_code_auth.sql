-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 3 — lightweight account system (no Google, no email/password)
--
-- Replaces the Google OAuth + email/password sign-in UI with three options:
--   1. Sign in as Guest        (unchanged -- no Supabase session at all)
--   2. New Sign Up             (username only -- Supabase anonymous auth)
--   3. Restore with Code       (a per-account recovery code lets a player
--                                resume their SAME account on a new device)
--
-- Architecture decision: this does NOT remove Supabase Auth, RLS, or
-- auth.uid() anywhere in the app -- "New Sign Up" uses Supabase's built-in
-- anonymous sign-in (supabase.auth.signInAnonymously()), which creates a
-- real, persistent auth.users row and a real session. Every existing RLS
-- policy and SECURITY DEFINER RPC (Phase 0.5 through Phase 2) keeps working
-- completely unchanged. Only the SIGN-IN METHOD changes -- not the identity/
-- security model underneath it.
--
-- The recovery code is a 10-character code (unambiguous alphabet, ~50 bits
-- of entropy) the player can view once from their Profile panel. Only its
-- SHA-256 hash is ever stored -- nobody, including this migration's own
-- RPCs, can read a previously-generated code back in plaintext; regenerating
-- shows a new one and immediately invalidates the old one.
--
-- Redeeming a code on a NEW device cannot be a plain RPC (a Postgres
-- function runs as the CALLER's auth.uid(), which is null/anonymous on a
-- device that has never seen this account before -- it has no way to
-- "become" a different existing user). That half lives in a Supabase Edge
-- Function (supabase/functions/redeem-recovery-code/) using the service-role
-- key to mint a real session via the standard generateLink + verifyOtp
-- pattern. This migration only provides the storage + generation side.
--
-- Per explicit product decision: existing Google-authenticated accounts are
-- NOT migrated by this change. That auth path is being removed from the
-- active UI; anyone who only ever had a Google (or email/password) account
-- and did not generate a recovery code first loses access to it. This was a
-- deliberate, informed tradeoff, not an oversight -- documented here and in
-- RUGTOWN_FINAL_IMPLEMENTATION_REPORT.md.
--
-- Safe to re-run: CREATE OR REPLACE / IF NOT EXISTS / ON CONFLICT throughout.
-- Additive only -- no existing table is altered or dropped.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. account_recovery_codes -- one active code per player, hash-only storage
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.account_recovery_codes (
  player_id     uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  code_hash     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_count integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_codes_hash
  ON public.account_recovery_codes (code_hash);

ALTER TABLE public.account_recovery_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies at all -- not even the owning player can SELECT
-- their own row. The hash must never be client-readable; the plaintext is
-- returned exactly once, directly by generate_my_recovery_code() below, and
-- redemption is handled entirely by the service-role Edge Function (which
-- bypasses RLS by design, same as every other admin-only table in this app).

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. recovery_code_rate_limit -- brute-force guard for the redeem Edge
--    Function. Service-role only; no client role can read or write this.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.recovery_code_rate_limit (
  rate_key      text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.recovery_code_rate_limit ENABLE ROW LEVEL SECURITY;
-- No policies -- fully locked to clients; the service-role Edge Function
-- bypasses RLS entirely, which is the only way this table is ever touched.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Plaintext code generator -- unambiguous alphabet (no 0/O/1/I/L
--    confusion), 10 characters, ~50 bits of entropy.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rt_generate_recovery_code_plaintext()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT string_agg(
    substr(alphabet, (floor(random() * length(alphabet)) + 1)::int, 1),
    ''
  )
  FROM (SELECT '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' AS alphabet) a,
       generate_series(1, 10);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. generate_my_recovery_code -- (re)generates the caller's code. Returns
--    the PLAINTEXT once; only its hash is ever persisted. Regenerating
--    silently invalidates any previously-issued code for this account
--    (ON CONFLICT overwrites the single row).
-- ═══════════════════════════════════════════════════════════════════════════
-- search_path includes `extensions` because Supabase installs pgcrypto
-- there by default, not into `public` -- digest() would otherwise fail to
-- resolve at call time for this SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.generate_my_recovery_code()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  uid   uuid := auth.uid();
  plain text;
  hash  text;
  tries integer := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  LOOP
    plain := public.rt_generate_recovery_code_plaintext();
    hash  := encode(digest(plain, 'sha256'), 'hex');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.account_recovery_codes WHERE code_hash = hash);
    tries := tries + 1;
    IF tries > 20 THEN RAISE EXCEPTION 'could not generate a unique code, try again'; END IF;
  END LOOP;

  INSERT INTO public.account_recovery_codes (player_id, code_hash, created_at, rotated_count)
  VALUES (uid, hash, now(), 0)
  ON CONFLICT (player_id) DO UPDATE
    SET code_hash     = EXCLUDED.code_hash,
        created_at    = now(),
        rotated_count = public.account_recovery_codes.rotated_count + 1;

  RETURN jsonb_build_object('ok', true, 'code', plain);
END;
$$;
REVOKE ALL ON FUNCTION public.generate_my_recovery_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_my_recovery_code() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. has_my_recovery_code -- lets the Profile panel show "you have a code
--    saved" vs "you haven't generated one yet" WITHOUT exposing the hash.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.has_my_recovery_code()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  row public.account_recovery_codes;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO row FROM public.account_recovery_codes WHERE player_id = uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('hasCode', false);
  END IF;
  RETURN jsonb_build_object('hasCode', true, 'createdAt', row.created_at);
END;
$$;
REVOKE ALL ON FUNCTION public.has_my_recovery_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_my_recovery_code() TO authenticated;

COMMENT ON TABLE public.account_recovery_codes IS
  'Phase 3 -- hash-only storage for the per-account device-restore code. Plaintext is returned exactly once by generate_my_recovery_code() and never stored. Redemption on a new device is handled by supabase/functions/redeem-recovery-code (service-role only).';

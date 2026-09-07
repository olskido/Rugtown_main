-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 17 — Robinhood Chain Wallet + Daily Leaderboard Priority
--
-- Purpose:
--   1. Add save_wallet_address RPC — validates Robinhood (EVM) address format,
--      checks for duplicate-wallet collision, and writes wallet_address +
--      wallet_chain = 'robinhood' to the player's own profiles row.
--   2. Update create_rugtown_profile to set wallet_chain = 'robinhood'
--      (replaces the old hardcoded 'solana' default for new profiles).
--   3. Extend get_points_leaderboard to return wallet_address + wallet_chain
--      alongside each ranked row so the leaderboard can display shortened
--      wallet addresses without a second query.
--   4. Add wallet_address + wallet_chain columns to leaderboard_period_snapshots
--      so historical snapshots also capture the wallet at the time of ranking.
--   5. Update rt_capture_leaderboard_snapshot to include the new wallet columns.
--
-- Safety:
--   • All existing profiles.wallet_address / wallet_chain data is preserved.
--   • The unique index on profiles.wallet_address (uq_profiles_wallet_address,
--     Phase 15) continues to enforce one-wallet-per-player without changes.
--   • No table is dropped. No column is removed. No player data is reset.
--   • Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- Apply AFTER 20260820_phase2_progression_leaderboards_quests.sql.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── 1. Allow 'robinhood' as a valid wallet_chain value ─────────────────────
-- profiles.wallet_chain has no CHECK constraint in the existing migrations
-- (it is a plain TEXT column with DEFAULT 'solana'), so no constraint change
-- is needed — any string is already accepted. This comment documents the
-- canonical values used by this project:
--   'solana'    — legacy / not used for new signups post-Phase 17
--   'robinhood' — Robinhood Chain (EVM-compatible, 0x address format)

COMMENT ON COLUMN public.profiles.wallet_chain IS
  'Chain identifier for wallet_address. Phase 17+: ''robinhood'' for Robinhood Chain (EVM/0x). Legacy: ''solana''.';


-- ─── 2. save_wallet_address — onboarding + profile update RPC ───────────────
-- Called by WalletOnboardingPage and the profile wallet editor after the
-- player enters their Robinhood Chain public address.
--
-- Validates:
--   • Authentication: auth.uid() must be present
--   • Format: must match ^0x[0-9a-fA-F]{40}$ (EVM 42-char address)
--   • Uniqueness: wallet must not already belong to a different player
--     (the unique index uq_profiles_wallet_address enforces this at the DB
--     level too, but we surface a clean message here rather than exposing
--     Postgres unique_violation text)
--
-- On success:
--   • Writes wallet_address (lowercased for normalisation) + wallet_chain to
--     the caller's own profiles row
--   • Sets onboarding_completed = true (wallet step is the final onboarding
--     step; this is idempotent for players who already had it set)
--   • Returns { ok: true, walletAddress, walletChain }
--
-- Security: SECURITY DEFINER + auth.uid() ownership — cannot write to
-- another player's row. REVOKE ALL FROM PUBLIC + GRANT to authenticated.

CREATE OR REPLACE FUNCTION public.save_wallet_address(
  p_wallet_address text,
  p_wallet_chain   text DEFAULT 'robinhood'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid           uuid   := auth.uid();
  clean_addr    text;
  clean_chain   text;
  existing_uid  uuid;
BEGIN
  -- Auth guard
  IF uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- Trim and normalise
  clean_addr  := trim(coalesce(p_wallet_address, ''));
  clean_chain := lower(trim(coalesce(p_wallet_chain, 'robinhood')));

  -- Format validation
  IF clean_addr = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wallet_address_empty');
  END IF;

  -- Robinhood Chain uses EVM address format: 0x followed by exactly 40 hex chars
  IF clean_chain = 'robinhood' THEN
    IF NOT (clean_addr ~* '^0x[0-9a-fA-F]{40}$') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_evm_address',
        'message', 'A Robinhood Chain address must start with 0x and be 42 characters long.');
    END IF;
    -- Normalise to lowercase hex (0x + lowercase chars) for consistent storage
    clean_addr := '0x' || lower(substr(clean_addr, 3));
  END IF;

  -- Chain whitelist (extensible — add chains here as the product grows)
  IF clean_chain NOT IN ('robinhood', 'solana') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unsupported_chain',
      'message', 'Unsupported wallet chain: ' || clean_chain);
  END IF;

  -- Duplicate-wallet check: is this address already linked to a DIFFERENT player?
  SELECT id INTO existing_uid
  FROM public.profiles
  WHERE wallet_address = clean_addr
    AND id <> uid
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wallet_already_linked',
      'message', 'This wallet is already linked to another RugTown account.');
  END IF;

  -- Persist — protected by the profiles_protect_reward_columns trigger
  -- (Phase 10G/15), so we must use rt_set_mutation_flag() before the UPDATE.
  PERFORM public.rt_set_mutation_flag();

  UPDATE public.profiles
  SET
    wallet_address       = clean_addr,
    wallet_chain         = clean_chain,
    -- Wallet step is the last onboarding screen — mark the full onboarding done.
    onboarding_completed = true,
    last_seen_at         = now()
  WHERE id = uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'profile_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok',           true,
    'walletAddress', clean_addr,
    'walletChain',   clean_chain
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_wallet_address(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_wallet_address(text, text) TO authenticated;

COMMENT ON FUNCTION public.save_wallet_address IS
  'Phase 17: validates and persists a Robinhood Chain (EVM) wallet address to the caller''s own profile. Rejects duplicates and format errors. Sets onboarding_completed = true.';


-- ─── 3. Update create_rugtown_profile: default wallet_chain to 'robinhood' ──
-- The Phase 1 version hardcodes wallet_chain = 'solana'. From Phase 17 onward
-- new profiles use 'robinhood'. The wallet_address is no longer auto-resolved
-- from auth identity (rt_resolve_auth_wallet) at profile-creation time —
-- instead it is set explicitly by save_wallet_address at the end of onboarding.
-- Existing players' wallet_chain values are NOT touched by this migration.
-- onboarding_completed is now set to FALSE here so the routing logic will
-- send new Google-signup players through the wallet step after the username step.
-- (Email/password signups that supply a username in metadata still see
-- onboarding_completed := chose_username from handle_new_user(), but
-- create_rugtown_profile itself is only called from UsernameOnboardingPage,
-- so all paths through it get wallet_onboarding required after this change.)

CREATE OR REPLACE FUNCTION public.create_rugtown_profile(p_username text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid  uuid := auth.uid();
  n    text := public.rt_normalize_username(p_username);
  prof public.profiles;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF n IS NULL OR char_length(n) < 3 OR char_length(n) > 16 THEN
    RAISE EXCEPTION 'username must be 3-16 characters';
  END IF;
  IF n !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid username characters';
  END IF;
  IF public.rt_is_username_reserved(n) THEN
    RAISE EXCEPTION 'username reserved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles WHERE username_normalized = n AND id <> uid
  ) THEN
    RAISE EXCEPTION 'username taken';
  END IF;

  PERFORM public.rt_set_mutation_flag();

  BEGIN
    INSERT INTO public.profiles (
      id, username, username_normalized, display_name,
      onboarding_completed, wallet_chain, authenticated_at
    ) VALUES (
      uid, p_username, n, p_username,
      -- Phase 17: wallet step follows username — onboarding NOT complete yet.
      -- save_wallet_address() sets onboarding_completed = true at the end.
      false,
      'robinhood',   -- default chain for new profiles
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      username             = EXCLUDED.username,
      username_normalized  = EXCLUDED.username_normalized,
      display_name         = coalesce(public.profiles.display_name, EXCLUDED.display_name),
      -- Do not overwrite an already-linked wallet address
      wallet_chain         = coalesce(public.profiles.wallet_chain, EXCLUDED.wallet_chain),
      authenticated_at     = coalesce(public.profiles.authenticated_at, EXCLUDED.authenticated_at),
      last_seen_at         = now()
    RETURNING * INTO prof;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'username taken';
  END;

  PERFORM public.rt_ensure_progression(uid);

  RETURN jsonb_build_object(
    'ok',                true,
    'username',          prof.username,
    'onboardingCompleted', false,
    'walletLinked',      prof.wallet_address IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_rugtown_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rugtown_profile(text) TO authenticated;

COMMENT ON FUNCTION public.create_rugtown_profile IS
  'Phase 17: sets onboarding_completed = false after username step so the wallet-address onboarding screen is shown next. wallet_chain defaults to ''robinhood''. Does NOT auto-resolve a wallet address — save_wallet_address() is the explicit wallet setter.';


-- ─── 4. Extend get_points_leaderboard to return wallet_address + wallet_chain ─
-- Replaces the Phase 2 version. The only change is adding p.wallet_address
-- and p.wallet_chain to the SELECT list. The JOIN to profiles already exists
-- (for username), so this costs nothing extra. NULL wallet_address rows are
-- returned as-is — the client renders a placeholder for unlinked wallets.

CREATE OR REPLACE FUNCTION public.get_points_leaderboard(
  p_period text,               -- 'daily' | 'weekly' | 'all_time'
  p_limit  integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rows jsonb;
  lim  integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  off  integer := greatest(coalesce(p_offset, 0), 0);
  col  text;
BEGIN
  IF p_period NOT IN ('daily', 'weekly', 'all_time') THEN
    RAISE EXCEPTION 'invalid period: %', p_period;
  END IF;
  col := CASE p_period
    WHEN 'daily'   THEN 'daily_points'
    WHEN 'weekly'  THEN 'weekly_points'
    ELSE                'rug_points'
  END;

  EXECUTE format(
    $q$
      SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT
          row_number() OVER (ORDER BY pp.%1$I DESC, pp.player_id ASC) + $1 AS rank,
          p.id            AS "playerId",
          p.username,
          p.wallet_address AS "walletAddress",
          p.wallet_chain   AS "walletChain",
          pp.level,
          pp.rep,
          pp.%1$I          AS points
        FROM public.player_progression pp
        JOIN public.profiles p ON p.id = pp.player_id
        WHERE pp.%1$I > 0
        ORDER BY pp.%1$I DESC, pp.player_id ASC
        LIMIT $2 OFFSET $1
      ) t
    $q$, col
  ) INTO rows USING off, lim;

  RETURN jsonb_build_object('period', p_period, 'limit', lim, 'offset', off, 'rows', rows);
END;
$$;

REVOKE ALL ON FUNCTION public.get_points_leaderboard(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_points_leaderboard(text, integer, integer) TO authenticated, anon;

COMMENT ON FUNCTION public.get_points_leaderboard IS
  'Phase 17: adds wallet_address + wallet_chain to each ranked row. Otherwise unchanged from Phase 2.';


-- ─── 5. Add wallet columns to leaderboard_period_snapshots ──────────────────
ALTER TABLE public.leaderboard_period_snapshots
  ADD COLUMN IF NOT EXISTS wallet_address text,
  ADD COLUMN IF NOT EXISTS wallet_chain   text;

COMMENT ON COLUMN public.leaderboard_period_snapshots.wallet_address IS
  'Snapshot of the player''s wallet address at the time of the period capture.';
COMMENT ON COLUMN public.leaderboard_period_snapshots.wallet_chain IS
  'Wallet chain (e.g. ''robinhood'') at time of snapshot.';


-- ─── 6. Update rt_capture_leaderboard_snapshot to include wallet columns ─────
CREATE OR REPLACE FUNCTION public.rt_capture_leaderboard_snapshot(
  p_period_type text,
  p_period_key  text,
  p_top_n       integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  col      text    := CASE p_period_type WHEN 'daily' THEN 'daily_points' ELSE 'weekly_points' END;
  inserted integer;
BEGIN
  EXECUTE format(
    $q$
      INSERT INTO public.leaderboard_period_snapshots
        (period_type, period_key, player_id, rank, username, points, level, rep, wallet_address, wallet_chain)
      SELECT
        $1, $2,
        p.id,
        row_number() OVER (ORDER BY pp.%1$I DESC, pp.player_id ASC),
        p.username,
        pp.%1$I,
        pp.level,
        pp.rep,
        p.wallet_address,
        p.wallet_chain
      FROM public.player_progression pp
      JOIN public.profiles p ON p.id = pp.player_id
      WHERE pp.%1$I > 0
      ORDER BY pp.%1$I DESC, pp.player_id ASC
      LIMIT $3
      ON CONFLICT (period_type, period_key, player_id) DO NOTHING
    $q$, col
  ) USING p_period_type, p_period_key, greatest(coalesce(p_top_n, 100), 1);
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.rt_capture_leaderboard_snapshot(text, text, integer) FROM PUBLIC;

COMMENT ON FUNCTION public.rt_capture_leaderboard_snapshot IS
  'Phase 17: also captures wallet_address + wallet_chain in historical snapshots.';


-- ─── 7. Also expose wallet in get_leaderboard_history ─────────────────────────
-- No change needed: it already returns to_jsonb(s) which now includes the new
-- wallet_address + wallet_chain columns added in step 5. No CREATE OR REPLACE
-- required for that function.


-- ─── 8. Verification queries (informational — safe to run after applying) ────
-- SELECT proname FROM pg_proc WHERE proname IN ('save_wallet_address','create_rugtown_profile','get_points_leaderboard','rt_capture_leaderboard_snapshot');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'leaderboard_period_snapshots' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles' AND column_name IN ('wallet_address','wallet_chain','onboarding_completed');
-- SELECT username, wallet_address, wallet_chain FROM public.profiles WHERE wallet_address IS NOT NULL ORDER BY username;

-- Phase 17b — require wallet before onboarding_completed, uniqueness by address+chain
-- Safe to re-run. Does not drop data.

-- One wallet+chain combination per player (Robinhood addresses are unique on 0x hex).
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_wallet_address_chain
  ON public.profiles (lower(wallet_address), wallet_chain)
  WHERE wallet_address IS NOT NULL AND length(trim(wallet_address)) > 0;

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
      false,
      'robinhood',
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      username             = EXCLUDED.username,
      username_normalized  = EXCLUDED.username_normalized,
      display_name         = coalesce(public.profiles.display_name, EXCLUDED.display_name),
      wallet_chain         = coalesce(public.profiles.wallet_chain, EXCLUDED.wallet_chain),
      authenticated_at     = coalesce(public.profiles.authenticated_at, EXCLUDED.authenticated_at),
      last_seen_at         = now(),
      onboarding_completed = CASE
        WHEN public.profiles.wallet_address IS NOT NULL THEN true
        ELSE false
      END
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

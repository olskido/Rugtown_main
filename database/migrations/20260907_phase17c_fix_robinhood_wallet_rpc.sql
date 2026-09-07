-- Phase 17c -- make the Robinhood wallet onboarding RPC live and strict.
-- Safe to re-run. Uses the existing public.profiles/authenticated-user model.

-- The existing Phase 17b index is retained; this statement also makes the
-- required normalized ownership guarantee explicit for databases where 17b
-- was not applied.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_wallet_address_chain
  ON public.profiles (lower(wallet_address), wallet_chain)
  WHERE wallet_address IS NOT NULL AND length(trim(wallet_address)) > 0;

CREATE OR REPLACE FUNCTION public.save_wallet_address(
  p_wallet_address text,
  p_wallet_chain text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id uuid := auth.uid();
  normalized_address text;
  existing_owner uuid;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- This release supports Robinhood Chain only. Do not silently accept a
  -- missing or alternate chain value from an RPC caller.
  IF p_wallet_chain IS DISTINCT FROM 'robinhood' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'unsupported_chain',
      'message', 'Unsupported wallet chain.'
    );
  END IF;

  normalized_address := lower(trim(coalesce(p_wallet_address, '')));

  IF normalized_address = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'wallet_address_empty',
      'message', 'Please enter your wallet address.'
    );
  END IF;

  IF normalized_address !~ '^0x[0-9a-f]{40}$' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_evm_address',
      'message', 'A Robinhood Chain address must start with 0x and be 42 characters long.'
    );
  END IF;

  -- The pre-check gives the client a stable error. The unique index below
  -- remains the authoritative protection when two claims race.
  SELECT id
    INTO existing_owner
    FROM public.profiles
   WHERE lower(wallet_address) = normalized_address
     AND wallet_chain = 'robinhood'
     AND id <> caller_id
   LIMIT 1;

  IF existing_owner IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'wallet_already_linked',
      'message', 'This wallet is already linked to another RugTown account.'
    );
  END IF;

  PERFORM public.rt_set_mutation_flag();

  BEGIN
    UPDATE public.profiles
       SET wallet_address = normalized_address,
           wallet_chain = 'robinhood',
           onboarding_completed = true,
           last_seen_at = now()
     WHERE id = caller_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'wallet_already_linked',
        'message', 'This wallet is already linked to another RugTown account.'
      );
  END;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'profile_not_found',
      'message', 'Profile not found. Please sign in again.'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'walletAddress', normalized_address,
    'walletChain', 'robinhood'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_wallet_address(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_wallet_address(text, text) TO authenticated;

-- Make the new/replace function visible to PostgREST without relying on a
-- schema reload as a substitute for applying the migration.
NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION public.save_wallet_address(text, text) IS
  'Robinhood-only authenticated wallet onboarding. Validates and persists a normalized EVM address on the caller profile, prevents duplicate ownership, and completes onboarding.';

-- Verification queries (run against the target Supabase project after apply):
-- SELECT n.nspname AS schema_name, p.proname, pg_get_function_arguments(p.oid) AS arguments,
--        pg_get_function_result(p.oid) AS return_type, p.prosecdef
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'save_wallet_address';
-- SELECT has_function_privilege('authenticated', 'public.save_wallet_address(text,text)', 'EXECUTE');
-- SELECT username, wallet_address, wallet_chain, onboarding_completed
--   FROM public.profiles WHERE wallet_address IS NOT NULL;

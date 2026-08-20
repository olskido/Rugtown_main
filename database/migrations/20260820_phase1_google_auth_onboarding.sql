-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 1 — Google Auth + Persistent Username
--
-- One real gap in the schema, found while fixing the client-side onboarding
-- race (see the Phase 1 completion report for the full client-side fix):
--
--   `handle_new_user()` (database/schema.sql) inserts a `profiles` row for
--   EVERY new `auth.users` row and never sets `onboarding_completed`, so it
--   always defaults to `false` (column default set in
--   20260813_phase15_prelaunch_wallet_guild_vault.sql). That is correct for
--   Google OAuth signups (Google never supplies a `username`, so the trigger
--   falls back to an auto-generated handle -- the player has NOT chosen
--   anything yet and SHOULD see the onboarding username screen).
--
--   It is WRONG for email/password signups made through this app's own
--   AuthPage.tsx signup form: that form always sends the player's typed
--   username via `supabase.auth.signUp({ options: { data: { username } } })`,
--   which lands in `raw_user_meta_data->>'username'`. That IS a deliberate
--   username choice -- treating it as "still needs onboarding" would show the
--   username picker a second time to someone who already chose one.
--
--   Fix: `handle_new_user()` now sets `onboarding_completed := true` when
--   the signup already supplied a real username via metadata, and leaves it
--   `false` (unchanged default) when it didn't -- which reliably distinguishes
--   Google OAuth (no `username` field ever present in Google's identity data)
--   from this app's own email signup form, with no new column needed.
--
-- This migration ONLY changes behavior for auth.users rows created AFTER it
-- is applied (a trigger function, not a backfill) -- it does not touch any
-- existing profile, and does not reset REP/XP/level/Points/missions/
-- achievements for any existing player. No new table, no dropped column, no
-- data migration.
--
-- Apply AFTER Phase 0.5 (20260820_phase0_5_security_hardening.sql).
-- Additive/behavioral-fix only. Safe to re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER            -- runs with the privileges of the function owner
SET search_path = public    -- prevent search_path injection
AS $$
DECLARE
  raw_username text;
  raw_display  text;
  base_name    text;
  candidate    text;
  final_name   text;
  attempt      int := 0;
  chose_username boolean;
BEGIN
  raw_username := NEW.raw_user_meta_data->>'username';
  raw_display  := NEW.raw_user_meta_data->>'display_name';

  -- Phase 1: a non-empty `username` in signup metadata means the player
  -- already made a deliberate choice on this app's own signup form (email
  -- path) -- Google/OAuth identities never populate this field. Onboarding
  -- is complete for that case; Google/OAuth signups still need it.
  chose_username := coalesce(nullif(trim(raw_username), ''), '') <> '';

  -- Sanitise the chosen username; fall back to the email prefix, then 'degen'.
  base_name := lower(regexp_replace(coalesce(raw_username, ''), '[^a-z0-9_]', '', 'g'));
  IF base_name = '' THEN
    base_name := lower(regexp_replace(split_part(NEW.email, '@', 1), '[^a-z0-9_]', '', 'g'));
  END IF;
  base_name := left(coalesce(nullif(base_name, ''), 'degen'), 24);

  -- Try the plain handle first, adding a short random suffix on collision.
  candidate := base_name;
  LOOP
    BEGIN
      INSERT INTO public.profiles (id, username, display_name, onboarding_completed)
      VALUES (
        NEW.id,
        candidate,
        coalesce(nullif(raw_display, ''), nullif(raw_username, ''), candidate),
        chose_username
      )
      ON CONFLICT (id) DO NOTHING;
      RETURN NEW;                        -- inserted, or id row already existed
    EXCEPTION WHEN unique_violation THEN  -- username already taken
      attempt := attempt + 1;
      IF attempt >= 5 THEN
        -- Last resort: append 8 hex chars from the UUID (guaranteed unique).
        final_name := left(base_name, 15) || '_' || substr(replace(NEW.id::text, '-', ''), 1, 8);
        INSERT INTO public.profiles (id, username, display_name, onboarding_completed)
        VALUES (NEW.id, final_name, coalesce(nullif(raw_display, ''), final_name), chose_username)
        ON CONFLICT (id) DO NOTHING;
        RETURN NEW;
      END IF;
      candidate := left(base_name, 18) || '_' || substr(md5(random()::text || NEW.id::text), 1, 5);
    END;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user IS
  'Auto-creates a profiles row on auth.users signup. Phase 1: onboarding_completed is seeded true only when the signup already supplied a real chosen username via metadata (this app''s own email signup form) -- Google OAuth identities never do, so those correctly still see /onboarding/username.';


-- ─── create_rugtown_profile: clean error on a genuine concurrent claim ──────
-- Unchanged behavior/signature/grants. The pre-check (`IF EXISTS ... RAISE
-- EXCEPTION 'username taken'`) has an inherent race window between two
-- concurrent callers; the actual guarantee that only one wins comes from the
-- UNIQUE index on username_normalized (uq_profiles_username_normalized_col,
-- 20260813_phase15_prelaunch_wallet_guild_vault.sql) and the equivalent
-- lower(trim(username)) index (uq_profiles_username_normalized,
-- 20260716_phase10j_social_identity_moderation.sql) -- that part was already
-- correct and is NOT changed here. This only wraps the INSERT so the loser
-- of a genuine race gets the same clean 'username taken' message as the
-- pre-check, instead of a raw Postgres unique_violation error string.

CREATE OR REPLACE FUNCTION public.create_rugtown_profile(p_username text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  n text := public.rt_normalize_username(p_username);
  w text;
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

  w := public.rt_resolve_auth_wallet(uid);
  PERFORM public.rt_set_mutation_flag();

  BEGIN
    INSERT INTO public.profiles (
      id, username, username_normalized, display_name,
      onboarding_completed, wallet_address, wallet_chain, authenticated_at
    ) VALUES (
      uid, p_username, n, p_username,
      true, w, 'solana', now()
    )
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      username_normalized = EXCLUDED.username_normalized,
      display_name = coalesce(public.profiles.display_name, EXCLUDED.display_name),
      onboarding_completed = true,
      wallet_address = coalesce(public.profiles.wallet_address, EXCLUDED.wallet_address),
      wallet_chain = coalesce(public.profiles.wallet_chain, EXCLUDED.wallet_chain),
      authenticated_at = coalesce(public.profiles.authenticated_at, EXCLUDED.authenticated_at),
      last_seen_at = now()
    RETURNING * INTO prof;
  EXCEPTION WHEN unique_violation THEN
    -- Phase 1: a different uid won a simultaneous claim of the same
    -- normalized username between the pre-check above and this INSERT.
    -- Surface the same clean message the pre-check would have given.
    RAISE EXCEPTION 'username taken';
  END;

  PERFORM public.rt_ensure_progression(uid);

  RETURN jsonb_build_object(
    'ok', true,
    'profile', to_jsonb(prof),
    'onboardingCompleted', true,
    'walletLinked', prof.wallet_address IS NOT NULL
  );
END;
$$;

-- Grants unchanged from phase15_prelaunch (REVOKE ALL FROM PUBLIC + GRANT
-- authenticated) -- CREATE OR REPLACE preserves them, restated here only for
-- self-documentation.
REVOKE ALL ON FUNCTION public.create_rugtown_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rugtown_profile(text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification queries (informational only, safe to run after applying)
-- ═══════════════════════════════════════════════════════════════════════════
--   -- A fresh row with no metadata username (simulating Google OAuth) should
--   -- default to onboarding_completed = false. This can only be exercised by
--   -- an actual signup (trigger fires on auth.users INSERT); there is no
--   -- direct SQL simulation without inserting into auth.users, which this
--   -- migration does not do. Verify via the live-Supabase test matrix in the
--   -- Phase 1 completion report instead.
--
--   -- Confirm the function compiled and is callable:
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'handle_new_user';
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'create_rugtown_profile';
-- ═══════════════════════════════════════════════════════════════════════════

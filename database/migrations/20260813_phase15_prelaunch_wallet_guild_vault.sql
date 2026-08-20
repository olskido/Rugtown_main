-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 15 — Prelaunch wallet onboarding, guild contracts/vault,
-- holder-aware reward epochs, and profile state RPCs.
--
-- Apply AFTER Phase 14 (gameplay completion). Additive only — no DROP of user
-- data. Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- GENERATED FOR MANUAL REVIEW — not applied remotely by this repository.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Profile extensions (wallet + onboarding) ────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS wallet_address text,
  ADD COLUMN IF NOT EXISTS wallet_chain text DEFAULT 'solana',
  ADD COLUMN IF NOT EXISTS username_normalized text,
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS authenticated_at timestamptz;

COMMENT ON COLUMN public.profiles.wallet_address IS
  'Primary linked wallet; set by onboarding RPC or verified wallet flow.';
COMMENT ON COLUMN public.profiles.wallet_chain IS
  'Chain identifier for wallet_address (default solana).';
COMMENT ON COLUMN public.profiles.username_normalized IS
  'Lowercase normalized username for case-insensitive uniqueness checks.';
COMMENT ON COLUMN public.profiles.onboarding_completed IS
  'True once the player has completed RugTown username onboarding.';
COMMENT ON COLUMN public.profiles.authenticated_at IS
  'First successful wallet/session authentication timestamp.';

UPDATE public.profiles
SET username_normalized = lower(trim(username))
WHERE username_normalized IS NULL AND username IS NOT NULL;

UPDATE public.profiles
SET onboarding_completed = true
WHERE coalesce(onboarding_completed, false) = false
  AND username IS NOT NULL
  AND length(trim(username)) >= 3;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_username_normalized_col
  ON public.profiles (username_normalized)
  WHERE username_normalized IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_wallet_address
  ON public.profiles (wallet_address)
  WHERE wallet_address IS NOT NULL;

-- Extend reward-column protection (rep already guarded in Phase 10G).
CREATE OR REPLACE FUNCTION public.profiles_protect_reward_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.rt_allow_reward_mutation() THEN
    NEW.rep := OLD.rep;
    NEW.onboarding_completed := OLD.onboarding_completed;
    NEW.wallet_address := OLD.wallet_address;
    NEW.wallet_chain := OLD.wallet_chain;
    NEW.username_normalized := OLD.username_normalized;
    NEW.authenticated_at := OLD.authenticated_at;
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    NEW.username_normalized := lower(trim(NEW.username));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_protect_reward_columns ON public.profiles;
CREATE TRIGGER profiles_protect_reward_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_protect_reward_columns();

-- ─── 2. Guild catalog + player state ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guild_contract_definitions (
  id              text PRIMARY KEY,
  code            text NOT NULL UNIQUE,
  title           text NOT NULL,
  description     text NOT NULL,
  contract_type   text NOT NULL CHECK (contract_type IN ('daily', 'bounty')),
  difficulty      text NOT NULL DEFAULT 'easy'
                    CHECK (difficulty IN ('easy', 'medium', 'hard', 'legendary')),
  objective_type  text NOT NULL,
  target          integer NOT NULL CHECK (target > 0),
  objective_ref   text,
  rep_reward      integer NOT NULL DEFAULT 0 CHECK (rep_reward >= 0),
  min_level       integer NOT NULL DEFAULT 1 CHECK (min_level >= 1),
  enabled         boolean NOT NULL DEFAULT true
);

ALTER TABLE public.guild_contract_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "guild_contract_definitions: public read" ON public.guild_contract_definitions;
CREATE POLICY "guild_contract_definitions: public read"
  ON public.guild_contract_definitions FOR SELECT USING (enabled = true);

CREATE TABLE IF NOT EXISTS public.player_guild_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  definition_id   text NOT NULL REFERENCES public.guild_contract_definitions (id),
  period_key      text NOT NULL,
  contract_type   text NOT NULL CHECK (contract_type IN ('daily', 'bounty')),
  progress        integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  target          integer NOT NULL CHECK (target > 0),
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'claimed', 'expired')),
  rep_reward      integer NOT NULL DEFAULT 0 CHECK (rep_reward >= 0),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  completed_at    timestamptz,
  claimed_at      timestamptz,
  UNIQUE (user_id, definition_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_player_guild_contracts_user_period
  ON public.player_guild_contracts (user_id, contract_type, period_key);

ALTER TABLE public.player_guild_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "player_guild_contracts: owner read" ON public.player_guild_contracts;
CREATE POLICY "player_guild_contracts: owner read"
  ON public.player_guild_contracts FOR SELECT
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.guild_streaks (
  user_id              uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  current_streak       integer NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  longest_streak       integer NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  last_completed_day   text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guild_streaks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "guild_streaks: owner read" ON public.guild_streaks;
CREATE POLICY "guild_streaks: owner read"
  ON public.guild_streaks FOR SELECT
  USING (auth.uid() = user_id);

INSERT INTO public.guild_contract_definitions (
  id, code, title, description, contract_type, difficulty,
  objective_type, target, objective_ref, rep_reward, min_level, enabled
) VALUES
  ('guild_daily_explorer', 'guild_daily_explorer', 'Explorer', 'Visit 4 different RugTown districts.', 'daily', 'easy', 'visit_districts', 4, NULL, 80, 1, true),
  ('guild_daily_market_runner', 'guild_daily_market_runner', 'Market Runner', 'Complete 3 eligible missions in the Market district.', 'daily', 'medium', 'complete_missions', 3, 'market', 120, 2, true),
  ('guild_daily_social', 'guild_daily_social', 'Social Citizen', 'Interact meaningfully with 5 unique players.', 'daily', 'medium', 'meet_players', 5, NULL, 100, 1, true),
  ('guild_daily_mission_specialist', 'guild_daily_mission_specialist', 'Mission Specialist', 'Complete 4 normal missions.', 'daily', 'medium', 'complete_missions', 4, NULL, 120, 1, true),
  ('guild_daily_city_walker', 'guild_daily_city_walker', 'City Walker', 'Visit 5 landmarks.', 'daily', 'easy', 'discover_landmarks', 5, NULL, 75, 1, true),
  ('guild_daily_event', 'guild_daily_event', 'Event Participant', 'Participate in one qualifying city event.', 'daily', 'medium', 'join_event', 1, NULL, 150, 1, true),
  ('guild_bounty_district_master', 'guild_bounty_district_master', 'District Master', 'Complete missions in 4 different districts.', 'bounty', 'medium', 'complete_missions', 4, 'multi_district', 200, 1, true),
  ('guild_bounty_socialite', 'guild_bounty_socialite', 'Socialite', 'Qualifying interactions with 10 unique players.', 'bounty', 'hard', 'meet_players', 10, NULL, 350, 1, true),
  ('guild_bounty_marathon', 'guild_bounty_marathon', 'Mission Marathon', 'Complete 8 eligible missions.', 'bounty', 'hard', 'complete_missions', 8, NULL, 400, 1, true),
  ('guild_bounty_explorer', 'guild_bounty_explorer', 'RugTown Explorer', 'Visit every major district.', 'bounty', 'hard', 'visit_districts', 5, NULL, 450, 1, true),
  ('guild_bounty_event_hunter', 'guild_bounty_event_hunter', 'Event Hunter', 'Participate in 3 qualifying city events.', 'bounty', 'medium', 'join_events', 3, NULL, 280, 1, true),
  ('guild_bounty_legend', 'guild_bounty_legend', 'Guild Legend', 'Complete all daily contracts and one bounty this week.', 'bounty', 'legendary', 'complete_missions', 1, 'guild_legend', 750, 5, true)
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  contract_type = EXCLUDED.contract_type,
  difficulty = EXCLUDED.difficulty,
  objective_type = EXCLUDED.objective_type,
  target = EXCLUDED.target,
  objective_ref = EXCLUDED.objective_ref,
  rep_reward = EXCLUDED.rep_reward,
  min_level = EXCLUDED.min_level,
  enabled = EXCLUDED.enabled;

-- ─── 3. Reward epoch + holder status ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reward_epochs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_key               text NOT NULL UNIQUE,
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  token_pool_base_units    bigint NOT NULL DEFAULT 0 CHECK (token_pool_base_units >= 0),
  total_effective_points   bigint NOT NULL DEFAULT 0 CHECK (total_effective_points >= 0),
  status                   text NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'finalized', 'closed'))
);

ALTER TABLE public.reward_epochs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reward_epochs: authenticated read" ON public.reward_epochs;
CREATE POLICY "reward_epochs: authenticated read"
  ON public.reward_epochs FOR SELECT
  TO authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS public.player_epoch_rewards (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id                uuid NOT NULL REFERENCES public.reward_epochs (id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  effective_points        bigint NOT NULL DEFAULT 0 CHECK (effective_points >= 0),
  token_amount_base_units bigint NOT NULL DEFAULT 0 CHECK (token_amount_base_units >= 0),
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'claimable', 'processing', 'confirmed', 'failed')),
  transaction_signature   text,
  claimed_at              timestamptz,
  UNIQUE (epoch_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_player_epoch_rewards_user
  ON public.player_epoch_rewards (user_id, status);

ALTER TABLE public.player_epoch_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "player_epoch_rewards: owner read" ON public.player_epoch_rewards;
CREATE POLICY "player_epoch_rewards: owner read"
  ON public.player_epoch_rewards FOR SELECT
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.reward_point_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  source_type      text NOT NULL,
  source_id        text NOT NULL,
  base_points      integer NOT NULL CHECK (base_points >= 0),
  multiplier       numeric(8, 4) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  effective_points integer NOT NULL CHECK (effective_points >= 0),
  epoch_id         uuid REFERENCES public.reward_epochs (id) ON DELETE SET NULL,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_point_ledger_user_created
  ON public.reward_point_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_point_ledger_epoch
  ON public.reward_point_ledger (epoch_id, user_id);

ALTER TABLE public.reward_point_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reward_point_ledger: owner read" ON public.reward_point_ledger;
CREATE POLICY "reward_point_ledger: owner read"
  ON public.reward_point_ledger FOR SELECT
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.holder_status (
  user_id                  uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  wallet_address           text,
  token_balance_base_units bigint NOT NULL DEFAULT 0 CHECK (token_balance_base_units >= 0),
  holder_tier              text NOT NULL DEFAULT 'none',
  rp_multiplier            numeric(8, 4) NOT NULL DEFAULT 1 CHECK (rp_multiplier > 0),
  last_checked_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.holder_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "holder_status: owner read" ON public.holder_status;
CREATE POLICY "holder_status: owner read"
  ON public.holder_status FOR SELECT
  USING (auth.uid() = user_id);

-- ─── 4. Internal helpers (match src/config/rewardConfig.ts) ─────────────────
CREATE OR REPLACE FUNCTION public.rt_settlement_mode()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(nullif(current_setting('app.settlement_mode', true), ''), 'disabled');
$$;

COMMENT ON FUNCTION public.rt_settlement_mode() IS
  'Reads app.settlement_mode GUC (default disabled). Production chain settlement uses edge functions.';

CREATE OR REPLACE FUNCTION public.rt_holder_tier_from_balance(p_balance bigint)
RETURNS TABLE (
  holder_tier text,
  rp_multiplier numeric
)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT v.tier, v.mult
  FROM (VALUES
    ('whale',  1.5,  250000000000::bigint),
    ('gold',   1.25,  50000000000::bigint),
    ('silver', 1.1,  10000000000::bigint),
    ('holder', 1.05,   1000000000::bigint),
    ('none',   1.0,              0::bigint)
  ) AS v(tier, mult, min_bal)
  WHERE p_balance >= v.min_bal
  ORDER BY v.min_bal DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rt_guild_streak_bonus(p_streak integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce((
    SELECT bonus FROM (VALUES
      (30, 250),
      (14, 120),
      (7, 60),
      (3, 25)
    ) AS t(threshold, bonus)
    WHERE p_streak >= t.threshold
    ORDER BY t.threshold DESC
    LIMIT 1
  ), 0);
$$;

CREATE OR REPLACE FUNCTION public.rt_resolve_auth_wallet(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w text;
BEGIN
  SELECT wallet_address INTO w
  FROM public.profiles
  WHERE id = p_user_id AND wallet_address IS NOT NULL;

  IF w IS NOT NULL THEN
    RETURN w;
  END IF;

  IF to_regclass('public.verified_wallets') IS NOT NULL THEN
    SELECT vw.wallet_address INTO w
    FROM public.verified_wallets vw
    WHERE vw.player_id = p_user_id
      AND vw.revoked_at IS NULL
    ORDER BY vw.is_primary DESC, vw.verified_at DESC
    LIMIT 1;
    IF w IS NOT NULL THEN
      RETURN w;
    END IF;
  END IF;

  SELECT coalesce(
    i.identity_data->>'sub',
    i.identity_data->>'address',
    i.identity_data->>'wallet_address'
  ) INTO w
  FROM auth.identities i
  WHERE i.user_id = p_user_id
    AND i.provider IN ('web3', 'solana', 'wallet')
  ORDER BY i.last_sign_in_at DESC NULLS LAST
  LIMIT 1;

  IF w IS NOT NULL THEN
    RETURN w;
  END IF;

  SELECT coalesce(
    u.raw_user_meta_data->>'wallet_address',
    u.raw_app_meta_data->>'wallet_address'
  ) INTO w
  FROM auth.users u
  WHERE u.id = p_user_id;

  RETURN nullif(trim(w), '');
END;
$$;

CREATE OR REPLACE FUNCTION public.rt_ensure_open_reward_epoch()
RETURNS public.reward_epochs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row public.reward_epochs;
  day_key text := public.rt_utc_daily_key(now());
  day_start timestamptz := (day_key::date AT TIME ZONE 'UTC');
  day_end timestamptz := day_start + interval '1 day';
  pool bigint := 10000000000000; -- 10_000 tokens @ 6 decimals (rewardConfig dev default)
BEGIN
  INSERT INTO public.reward_epochs (
    period_key, starts_at, ends_at, token_pool_base_units, status
  ) VALUES (
    day_key, day_start, day_end, pool, 'open'
  )
  ON CONFLICT (period_key) DO NOTHING;

  SELECT * INTO row FROM public.reward_epochs WHERE period_key = day_key;

  IF row.status = 'open' AND now() >= row.ends_at THEN
    UPDATE public.reward_epochs
    SET status = 'finalized'
    WHERE id = row.id AND status = 'open'
    RETURNING * INTO row;
    PERFORM public.rt_finalize_reward_epoch(row.id);
  END IF;

  RETURN row;
END;
$$;

CREATE OR REPLACE FUNCTION public.rt_finalize_reward_epoch(p_epoch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ep public.reward_epochs;
  rec RECORD;
  alloc bigint;
  min_claim bigint := 1000000; -- 1 token @ 6 decimals
BEGIN
  SELECT * INTO ep FROM public.reward_epochs WHERE id = p_epoch_id FOR UPDATE;
  IF NOT FOUND OR ep.status NOT IN ('open', 'finalized') THEN
    RETURN;
  END IF;

  UPDATE public.reward_epochs SET status = 'finalized' WHERE id = ep.id;

  IF ep.total_effective_points <= 0 THEN
    UPDATE public.reward_epochs SET status = 'closed' WHERE id = ep.id;
    RETURN;
  END IF;

  FOR rec IN
    SELECT user_id, sum(effective_points)::bigint AS pts
    FROM public.reward_point_ledger
    WHERE epoch_id = ep.id
    GROUP BY user_id
  LOOP
    alloc := floor(ep.token_pool_base_units::numeric * rec.pts / ep.total_effective_points)::bigint;
    IF alloc < min_claim THEN
      CONTINUE;
    END IF;
    INSERT INTO public.player_epoch_rewards (
      epoch_id, user_id, effective_points, token_amount_base_units, status
    ) VALUES (
      ep.id, rec.user_id, rec.pts, alloc,
      CASE WHEN public.rt_settlement_mode() = 'disabled' THEN 'claimable' ELSE 'pending' END
    )
    ON CONFLICT (epoch_id, user_id) DO UPDATE SET
      effective_points = EXCLUDED.effective_points,
      token_amount_base_units = EXCLUDED.token_amount_base_units,
      status = CASE
        WHEN player_epoch_rewards.status IN ('confirmed', 'processing') THEN player_epoch_rewards.status
        WHEN public.rt_settlement_mode() = 'disabled' THEN 'claimable'
        ELSE player_epoch_rewards.status
      END;
  END LOOP;

  UPDATE public.reward_epochs SET status = 'closed' WHERE id = ep.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rt_is_username_reserved(p_normalized text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_normalized IS NOT NULL AND (
    p_normalized = ANY(ARRAY[
      'admin','administrator','moderator','support','official','rugtown',
      'system','treasury','developer','mod','staff'
    ])
    OR p_normalized LIKE 'admin%'
    OR p_normalized LIKE 'mod\_%' ESCAPE '\'
  );
$$;

-- ─── 5. Profile + onboarding RPCs ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_rugtown_profile_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  prof public.profiles;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO prof FROM public.profiles WHERE id = uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'profile', to_jsonb(prof),
    'onboardingCompleted', coalesce(prof.onboarding_completed, false)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_username_available(p_username text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  n text := public.rt_normalize_username(p_username);
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF n IS NULL OR char_length(n) < 3 OR char_length(n) > 16 THEN
    RETURN false;
  END IF;
  IF n !~ '^[a-z0-9_]+$' THEN
    RETURN false;
  END IF;
  IF public.rt_is_username_reserved(n) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE username_normalized = n AND id <> uid
  );
END;
$$;

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

  PERFORM public.rt_ensure_progression(uid);

  RETURN jsonb_build_object(
    'ok', true,
    'profile', to_jsonb(prof),
    'onboardingCompleted', true,
    'walletLinked', prof.wallet_address IS NOT NULL
  );
END;
$$;

-- ─── 6. Guild RPCs ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_daily_guild_contracts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_period_key text := public.rt_utc_daily_key(now());
  player_level integer := 1;
  def RECORD;
  assigned integer := 0;
  day_end timestamptz := ((v_period_key::date + 1) AT TIME ZONE 'UTC');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  PERFORM public.rt_ensure_progression(uid);

  SELECT coalesce(level, 1) INTO player_level
  FROM public.player_progression WHERE player_id = uid;

  FOR def IN
    SELECT *
    FROM public.guild_contract_definitions
    WHERE contract_type = 'daily' AND enabled = true AND min_level <= player_level
    ORDER BY md5(id || uid::text || v_period_key)
    LIMIT 3
  LOOP
    INSERT INTO public.player_guild_contracts (
      user_id, definition_id, period_key, contract_type,
      progress, target, status, rep_reward, expires_at
    ) VALUES (
      uid, def.id, v_period_key, 'daily',
      0, def.target, 'active', def.rep_reward, day_end
    ) ON CONFLICT (user_id, definition_id, period_key) DO NOTHING;
    assigned := assigned + 1;
  END LOOP;

  UPDATE public.player_guild_contracts c
  SET status = 'expired'
  WHERE c.user_id = uid
    AND c.contract_type = 'daily'
    AND c.period_key < v_period_key
    AND c.status IN ('active', 'completed');

  RETURN jsonb_build_object(
    'periodKey', v_period_key,
    'assigned', assigned,
    'contracts', coalesce((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.assigned_at)
      FROM public.player_guild_contracts c
      WHERE c.user_id = uid AND c.contract_type = 'daily' AND c.period_key = v_period_key
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_guild_bounties()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  period_key text := public.rt_utc_weekly_key(now());
  player_level integer := 1;
  def RECORD;
  assigned integer := 0;
  week_end timestamptz := (
    date_trunc('week', now() AT TIME ZONE 'UTC') + interval '1 week'
  ) AT TIME ZONE 'UTC';
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  PERFORM public.rt_ensure_progression(uid);

  SELECT coalesce(level, 1) INTO player_level
  FROM public.player_progression WHERE player_id = uid;

  FOR def IN
    SELECT *
    FROM public.guild_contract_definitions
    WHERE contract_type = 'bounty' AND enabled = true AND min_level <= player_level
    ORDER BY md5(id || uid::text || period_key)
    LIMIT 3
  LOOP
    INSERT INTO public.player_guild_contracts (
      user_id, definition_id, period_key, contract_type,
      progress, target, status, rep_reward, expires_at
    ) VALUES (
      uid, def.id, period_key, 'bounty',
      0, def.target, 'active', def.rep_reward, week_end
    ) ON CONFLICT (user_id, definition_id, period_key) DO NOTHING;
    assigned := assigned + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'periodKey', period_key,
    'assigned', assigned,
    'contracts', coalesce((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.assigned_at)
      FROM public.player_guild_contracts c
      WHERE c.user_id = uid AND c.contract_type = 'bounty' AND c.period_key = period_key
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_guild_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  daily_key text := public.rt_utc_daily_key(now());
  weekly_key text := public.rt_utc_weekly_key(now());
  streak public.guild_streaks;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  PERFORM public.assign_daily_guild_contracts();
  PERFORM public.assign_guild_bounties();

  SELECT * INTO streak FROM public.guild_streaks WHERE user_id = uid;

  RETURN jsonb_build_object(
    'dailyPeriodKey', daily_key,
    'bountyPeriodKey', weekly_key,
    'dailyContracts', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'definition_id', c.definition_id,
          'code', d.code,
          'title', d.title,
          'description', d.description,
          'contract_type', c.contract_type,
          'difficulty', d.difficulty,
          'progress', c.progress,
          'target', c.target,
          'status', c.status,
          'rep_reward', c.rep_reward
        ) ORDER BY c.assigned_at
      )
      FROM public.player_guild_contracts c
      JOIN public.guild_contract_definitions d ON d.id = c.definition_id
      WHERE c.user_id = uid AND c.contract_type = 'daily' AND c.period_key = daily_key
    ), '[]'::jsonb),
    'bounties', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'definition_id', c.definition_id,
          'code', d.code,
          'title', d.title,
          'description', d.description,
          'contract_type', c.contract_type,
          'difficulty', d.difficulty,
          'progress', c.progress,
          'target', c.target,
          'status', c.status,
          'rep_reward', c.rep_reward
        ) ORDER BY c.assigned_at
      )
      FROM public.player_guild_contracts c
      JOIN public.guild_contract_definitions d ON d.id = c.definition_id
      WHERE c.user_id = uid AND c.contract_type = 'bounty' AND c.period_key = weekly_key
    ), '[]'::jsonb),
    'streak', CASE WHEN streak.user_id IS NULL THEN NULL ELSE to_jsonb(streak) END,
    'allDailiesComplete', coalesce((
      SELECT count(*) FILTER (WHERE c.status IN ('completed', 'claimed')) >= 3
      FROM public.player_guild_contracts c
      WHERE c.user_id = uid AND c.contract_type = 'daily' AND c.period_key = daily_key
    ), false),
    'dailyCompletionBonusRep', 250
  );
END;
$$;

CREATE TABLE IF NOT EXISTS public.guild_progress_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  contract_id     uuid NOT NULL REFERENCES public.player_guild_contracts (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_guild_progress_events_contract
  ON public.guild_progress_events (contract_id);

ALTER TABLE public.guild_progress_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "guild_progress_events: owner read" ON public.guild_progress_events;
CREATE POLICY "guild_progress_events: owner read"
  ON public.guild_progress_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.report_guild_gameplay_event(
  p_event_type text,
  p_ref text DEFAULT NULL,
  p_counterpart_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  daily_key text := public.rt_utc_daily_key(now());
  weekly_key text := public.rt_utc_weekly_key(now());
  c RECORD;
  def public.guild_contract_definitions;
  event_key text := coalesce(nullif(trim(p_idempotency_key), ''), gen_random_uuid()::text);
  updated_count integer := 0;
  districts_seen integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_event_type IS NULL OR length(trim(p_event_type)) < 2 THEN
    RAISE EXCEPTION 'invalid event type';
  END IF;
  IF p_counterpart_id IS NOT NULL AND p_counterpart_id = uid THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'self_interaction');
  END IF;

  FOR c IN
    SELECT pg.*
    FROM public.player_guild_contracts pg
    WHERE pg.user_id = uid
      AND pg.status = 'active'
      AND (
        (pg.contract_type = 'daily' AND pg.period_key = daily_key)
        OR (pg.contract_type = 'bounty' AND pg.period_key = weekly_key)
      )
    FOR UPDATE
  LOOP
    SELECT * INTO def FROM public.guild_contract_definitions WHERE id = c.definition_id;
    IF NOT FOUND OR NOT def.enabled THEN CONTINUE; END IF;

    IF def.objective_type = 'visit_districts' AND p_event_type = 'visit_district' THEN
      NULL;
    ELSIF def.objective_type = 'complete_missions' AND p_event_type = 'complete_mission' THEN
      IF def.objective_ref IS NOT NULL AND def.objective_ref <> 'multi_district' THEN
        IF coalesce(p_ref, '') <> def.objective_ref THEN CONTINUE; END IF;
      END IF;
    ELSIF def.objective_type = 'meet_players' AND p_event_type = 'meet_player' THEN
      IF p_counterpart_id IS NULL THEN CONTINUE; END IF;
    ELSIF def.objective_type = 'discover_landmarks' AND p_event_type = 'discover_landmark' THEN
      NULL;
    ELSIF def.objective_type = 'join_event' AND p_event_type = 'join_event' THEN
      NULL;
    ELSIF def.objective_type = 'join_events' AND p_event_type = 'join_event' THEN
      NULL;
    ELSIF def.objective_type = 'visit_all_districts' AND p_event_type = 'visit_district' THEN
      NULL;
    ELSE
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.guild_progress_events (user_id, contract_id, idempotency_key)
      VALUES (
        uid,
        c.id,
        event_key || ':' || c.id::text
      );
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;

    UPDATE public.player_guild_contracts SET
      progress = least(target, progress + 1),
      status = CASE WHEN least(target, progress + 1) >= target THEN 'completed' ELSE status END,
      completed_at = CASE WHEN least(target, progress + 1) >= target THEN now() ELSE completed_at END
    WHERE id = c.id
      AND status = 'active';

    IF FOUND THEN updated_count := updated_count + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('updated', updated_count > 0, 'contractsUpdated', updated_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_guild_progress(
  p_contract_id uuid,
  p_delta integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  c public.player_guild_contracts;
  daily_key text := public.rt_utc_daily_key(now());
  weekly_key text := public.rt_utc_weekly_key(now());
  delta integer := coalesce(p_delta, 0);
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF delta <= 0 OR delta > 100 THEN
    RAISE EXCEPTION 'invalid progress delta';
  END IF;

  SELECT * INTO c
  FROM public.player_guild_contracts
  WHERE id = p_contract_id AND user_id = uid
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found'; END IF;
  IF c.status <> 'active' THEN
    RETURN jsonb_build_object('updated', false, 'contract', to_jsonb(c));
  END IF;

  IF (c.contract_type = 'daily' AND c.period_key <> daily_key)
     OR (c.contract_type = 'bounty' AND c.period_key <> weekly_key) THEN
    UPDATE public.player_guild_contracts SET status = 'expired' WHERE id = c.id
    RETURNING * INTO c;
    RETURN jsonb_build_object('updated', false, 'expired', true, 'contract', to_jsonb(c));
  END IF;

  c.progress := least(c.target, c.progress + delta);
  IF c.progress >= c.target THEN
    c.status := 'completed';
    c.completed_at := now();
  END IF;

  UPDATE public.player_guild_contracts SET
    progress = c.progress,
    status = c.status,
    completed_at = c.completed_at
  WHERE id = c.id
  RETURNING * INTO c;

  RETURN jsonb_build_object('updated', true, 'contract', to_jsonb(c));
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_guild_contract(p_contract_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  c public.player_guild_contracts;
  prog public.player_progression;
  receipt_key text;
  new_rep integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO c
  FROM public.player_guild_contracts
  WHERE id = p_contract_id AND user_id = uid
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found'; END IF;
  IF c.status = 'claimed' THEN
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'contract', to_jsonb(c));
  END IF;
  IF c.status <> 'completed' THEN
    RAISE EXCEPTION 'contract not completed';
  END IF;

  receipt_key := 'guild_claim:' || c.id::text;
  PERFORM public.rt_ensure_progression(uid);
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.reward_ledger
    WHERE player_id = uid AND idempotency_key = receipt_key || ':REP'
  ) THEN
    UPDATE public.player_guild_contracts
    SET status = 'claimed', claimed_at = coalesce(claimed_at, now())
    WHERE id = c.id
    RETURNING * INTO c;
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'contract', to_jsonb(c));
  END IF;

  PERFORM public.rt_set_mutation_flag();

  INSERT INTO public.reward_ledger (
    player_id, reward_type, amount, reason, source_type, source_id,
    idempotency_key, metadata
  ) VALUES (
    uid, 'REP', c.rep_reward, 'guild_contract', 'guild_contract', c.definition_id,
    receipt_key || ':REP',
    jsonb_build_object('contractId', c.id, 'contractType', c.contract_type, 'periodKey', c.period_key)
  ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;

  new_rep := prog.rep + c.rep_reward;

  UPDATE public.player_progression SET
    rep = new_rep,
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  UPDATE public.player_guild_contracts
  SET status = 'claimed', claimed_at = now()
  WHERE id = c.id
  RETURNING * INTO c;

  RETURN jsonb_build_object(
    'claimed', true,
    'duplicate', false,
    'repAwarded', c.rep_reward,
    'contract', to_jsonb(c),
    'progression', to_jsonb(prog)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_guild_day()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_period_key text := public.rt_utc_daily_key(now());
  claimed_count integer;
  prog public.player_progression;
  streak public.guild_streaks;
  receipt_key text;
  base_rep integer := 250;
  streak_bonus integer;
  total_rep integer;
  yesterday text := public.rt_utc_daily_key(now() - interval '1 day');
  new_streak integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT count(*) INTO claimed_count
  FROM public.player_guild_contracts c
  WHERE c.user_id = uid
    AND c.contract_type = 'daily'
    AND c.period_key = v_period_key
    AND c.status = 'claimed';

  IF claimed_count < 3 THEN
    RAISE EXCEPTION 'not all daily guild contracts claimed (% of 3)', claimed_count;
  END IF;

  receipt_key := 'guild_day_bonus:' || v_period_key;
  PERFORM public.rt_ensure_progression(uid);
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.reward_ledger
    WHERE player_id = uid AND idempotency_key = receipt_key || ':REP'
  ) THEN
    SELECT * INTO streak FROM public.guild_streaks WHERE user_id = uid;
    RETURN jsonb_build_object(
      'completed', false, 'duplicate', true,
      'periodKey', v_period_key,
      'streak', streak
    );
  END IF;

  INSERT INTO public.guild_streaks (user_id, current_streak, longest_streak, last_completed_day)
  VALUES (uid, 0, 0, NULL)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO streak FROM public.guild_streaks WHERE user_id = uid FOR UPDATE;

  IF streak.last_completed_day = v_period_key THEN
    RETURN jsonb_build_object('completed', false, 'duplicate', true, 'periodKey', v_period_key);
  END IF;

  new_streak := CASE
    WHEN streak.last_completed_day = yesterday THEN streak.current_streak + 1
    ELSE 1
  END;

  streak_bonus := public.rt_guild_streak_bonus(new_streak);
  total_rep := base_rep + streak_bonus;

  PERFORM public.rt_set_mutation_flag();

  INSERT INTO public.reward_ledger (
    player_id, reward_type, amount, reason, source_type, source_id,
    idempotency_key, metadata
  ) VALUES (
    uid, 'REP', total_rep, 'guild_daily_completion', 'guild_daily_bonus', v_period_key,
    receipt_key || ':REP',
    jsonb_build_object(
      'periodKey', v_period_key,
      'baseRep', base_rep,
      'streakBonus', streak_bonus,
      'streakDay', new_streak
    )
  ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;

  UPDATE public.player_progression SET
    rep = rep + total_rep,
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = prog.rep, last_seen_at = now() WHERE id = uid;

  UPDATE public.guild_streaks SET
    current_streak = new_streak,
    longest_streak = greatest(longest_streak, new_streak),
    last_completed_day = v_period_key,
    updated_at = now()
  WHERE user_id = uid
  RETURNING * INTO streak;

  RETURN jsonb_build_object(
    'completed', true,
    'duplicate', false,
    'periodKey', v_period_key,
    'repAwarded', total_rep,
    'baseRep', base_rep,
    'streakBonus', streak_bonus,
    'streak', streak,
    'progression', to_jsonb(prog)
  );
END;
$$;

-- ─── 7. Reward vault RPCs ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_holder_status(p_balance_base_units bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal bigint := greatest(coalesce(p_balance_base_units, 0), 0);
  tier_rec RECORD;
  row public.holder_status;
  w text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  -- DEV ONLY: trusts client-reported balance. Production must verify on-chain
  -- via edge function (verify-wallet / token account read) before writing here.
  SELECT * INTO tier_rec FROM public.rt_holder_tier_from_balance(bal);
  w := public.rt_resolve_auth_wallet(uid);

  INSERT INTO public.holder_status (
    user_id, wallet_address, token_balance_base_units,
    holder_tier, rp_multiplier, last_checked_at
  ) VALUES (
    uid, w, bal, tier_rec.holder_tier, tier_rec.rp_multiplier, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    wallet_address = coalesce(EXCLUDED.wallet_address, holder_status.wallet_address),
    token_balance_base_units = EXCLUDED.token_balance_base_units,
    holder_tier = EXCLUDED.holder_tier,
    rp_multiplier = EXCLUDED.rp_multiplier,
    last_checked_at = now()
  RETURNING * INTO row;

  RETURN jsonb_build_object('ok', true, 'holderStatus', to_jsonb(row));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_reward_points(
  p_source_type text,
  p_source_id text,
  p_base_points integer,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  base_pts integer := greatest(coalesce(p_base_points, 0), 0);
  mult numeric(8, 4) := 1;
  eff integer;
  ep public.reward_epochs;
  inserted public.reward_point_ledger;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 3 THEN
    RAISE EXCEPTION 'invalid idempotency key';
  END IF;
  IF base_pts <= 0 THEN
    RAISE EXCEPTION 'base points must be positive';
  END IF;

  SELECT coalesce(hs.rp_multiplier, 1) INTO mult
  FROM public.holder_status hs
  WHERE hs.user_id = uid;

  eff := floor(base_pts * mult)::integer;
  ep := public.rt_ensure_open_reward_epoch();

  IF ep.status <> 'open' THEN
    RAISE EXCEPTION 'reward epoch not open';
  END IF;

  INSERT INTO public.reward_point_ledger (
    user_id, source_type, source_id, base_points, multiplier,
    effective_points, epoch_id, idempotency_key
  ) VALUES (
    uid, p_source_type, p_source_id, base_pts, mult,
    eff, ep.id, p_idempotency_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO inserted;

  IF inserted.id IS NULL THEN
    SELECT * INTO inserted FROM public.reward_point_ledger WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('recorded', false, 'duplicate', true, 'ledger', to_jsonb(inserted));
  END IF;

  UPDATE public.reward_epochs
  SET total_effective_points = total_effective_points + eff
  WHERE id = ep.id;

  RETURN jsonb_build_object(
    'recorded', true,
    'duplicate', false,
    'ledger', to_jsonb(inserted),
    'epochId', ep.id,
    'periodKey', ep.period_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_reward_vault_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  hs public.holder_status;
  ep public.reward_epochs;
  epoch_points bigint := 0;
  projected bigint := 0;
  claimable jsonb;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO hs FROM public.holder_status WHERE user_id = uid;
  ep := public.rt_ensure_open_reward_epoch();

  SELECT coalesce(sum(effective_points), 0) INTO epoch_points
  FROM public.reward_point_ledger
  WHERE user_id = uid AND epoch_id = ep.id;

  IF ep.total_effective_points > 0 THEN
    projected := floor(
      ep.token_pool_base_units::numeric * epoch_points / ep.total_effective_points
    )::bigint;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.claimed_at NULLS FIRST), '[]'::jsonb)
  INTO claimable
  FROM public.player_epoch_rewards r
  WHERE r.user_id = uid AND r.status IN ('claimable', 'processing');

  RETURN jsonb_build_object(
    'holderStatus', CASE WHEN hs.user_id IS NULL THEN NULL ELSE to_jsonb(hs) END,
    'currentEpoch', to_jsonb(ep),
    'epochEffectivePoints', epoch_points,
    'projectedTokenBaseUnits', projected,
    'claimableRewards', claimable,
    'settlementMode', public.rt_settlement_mode()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_epoch_reward(p_epoch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  reward public.player_epoch_rewards;
  ep public.reward_epochs;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO ep FROM public.reward_epochs WHERE id = p_epoch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'epoch not found'; END IF;

  IF ep.status = 'open' AND now() >= ep.ends_at THEN
    PERFORM public.rt_finalize_reward_epoch(ep.id);
    SELECT * INTO ep FROM public.reward_epochs WHERE id = p_epoch_id;
  END IF;

  SELECT * INTO reward
  FROM public.player_epoch_rewards
  WHERE epoch_id = p_epoch_id AND user_id = uid
  FOR UPDATE;

  IF NOT FOUND THEN
    IF ep.status IN ('finalized', 'closed') THEN
      PERFORM public.rt_finalize_reward_epoch(ep.id);
      SELECT * INTO reward
      FROM public.player_epoch_rewards
      WHERE epoch_id = p_epoch_id AND user_id = uid
      FOR UPDATE;
    END IF;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'no_allocation');
  END IF;

  IF reward.status = 'confirmed' THEN
    RETURN jsonb_build_object(
      'claimed', false, 'duplicate', true,
      'reward', to_jsonb(reward)
    );
  END IF;

  IF reward.status = 'failed' THEN
    RAISE EXCEPTION 'claim failed — contact support';
  END IF;

  IF reward.status = 'pending' AND public.rt_settlement_mode() <> 'disabled' THEN
    UPDATE public.player_epoch_rewards
    SET status = 'claimable'
    WHERE id = reward.id AND status = 'pending'
    RETURNING * INTO reward;
  END IF;

  IF reward.status NOT IN ('claimable', 'processing', 'pending') THEN
    RAISE EXCEPTION 'reward not claimable (status %)', reward.status;
  END IF;

  IF public.rt_settlement_mode() = 'disabled' THEN
    UPDATE public.player_epoch_rewards
    SET status = 'confirmed',
        claimed_at = now(),
        transaction_signature = coalesce(transaction_signature, 'dev:settlement_disabled')
    WHERE id = reward.id
    RETURNING * INTO reward;

    RETURN jsonb_build_object(
      'claimed', true,
      'devMode', true,
      'reward', to_jsonb(reward)
    );
  END IF;

  UPDATE public.player_epoch_rewards
  SET status = 'processing'
  WHERE id = reward.id AND status IN ('claimable', 'pending')
  RETURNING * INTO reward;

  RETURN jsonb_build_object(
    'claimed', false,
    'processing', true,
    'reward', to_jsonb(reward),
    'message', 'Settlement requires edge function when SETTLEMENT_MODE is enabled'
  );
END;
$$;

-- ─── 8. Grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_rugtown_profile_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rugtown_profile_state() TO authenticated;

REVOKE ALL ON FUNCTION public.check_username_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_username_available(text) TO authenticated;

REVOKE ALL ON FUNCTION public.create_rugtown_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rugtown_profile(text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_guild_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guild_state() TO authenticated;

REVOKE ALL ON FUNCTION public.assign_daily_guild_contracts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_daily_guild_contracts() TO authenticated;

REVOKE ALL ON FUNCTION public.assign_guild_bounties() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_guild_bounties() TO authenticated;

REVOKE ALL ON FUNCTION public.record_guild_progress(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_guild_progress(uuid, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.report_guild_gameplay_event(text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_guild_gameplay_event(text, text, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.claim_guild_contract(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_guild_contract(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.complete_guild_day() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_guild_day() TO authenticated;

REVOKE ALL ON FUNCTION public.get_reward_vault_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reward_vault_state() TO authenticated;

REVOKE ALL ON FUNCTION public.refresh_holder_status(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_holder_status(bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.record_reward_points(text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_reward_points(text, text, integer, text) TO authenticated;

REVOKE ALL ON FUNCTION public.claim_epoch_reward(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_epoch_reward(uuid) TO authenticated;

-- Internal helpers: no client execute
REVOKE ALL ON FUNCTION public.rt_ensure_open_reward_epoch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_finalize_reward_epoch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_resolve_auth_wallet(uuid) FROM PUBLIC;

-- ─── Verification (read-only) ───────────────────────────────────────────────
SELECT count(*) AS guild_daily_defs
FROM public.guild_contract_definitions
WHERE contract_type = 'daily' AND enabled = true;

SELECT count(*) AS guild_bounty_defs
FROM public.guild_contract_definitions
WHERE contract_type = 'bounty' AND enabled = true;

SELECT public.rt_holder_tier_from_balance(50000000000) AS gold_tier_check;

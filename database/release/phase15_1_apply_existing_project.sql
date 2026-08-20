-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 15.1 — Production hardening
-- Apply AFTER phase15_prelaunch_wallet_guild_vault.sql
-- Additive only. Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Schema extensions ───────────────────────────────────────────────────
ALTER TABLE public.holder_status
  ADD COLUMN IF NOT EXISTS is_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refresh_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_refresh_error text;

ALTER TABLE public.player_epoch_rewards
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_message text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS destination_wallet text;

ALTER TABLE public.reward_epochs
  ADD COLUMN IF NOT EXISTS allocated_total_base_units bigint NOT NULL DEFAULT 0 CHECK (allocated_total_base_units >= 0),
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

-- Prevent direct client writes to holder_status
DROP POLICY IF EXISTS "holder_status: owner read" ON public.holder_status;
CREATE POLICY "holder_status: owner read"
  ON public.holder_status FOR SELECT
  USING (auth.uid() = user_id);

-- ─── 2. Disable untrackable launch contracts ────────────────────────────────
-- guild_daily_market_runner: mission complete does not emit district ref yet
-- guild_bounty_district_master: multi_district mission tracking not implemented
-- guild_bounty_legend: guild_legend ref untrackable
UPDATE public.guild_contract_definitions
SET enabled = false
WHERE id IN (
  'guild_daily_market_runner',
  'guild_bounty_district_master',
  'guild_bounty_legend'
);

-- ─── 3. Service-role gate helper ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rt_is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  ) = 'service_role';
$$;

-- ─── 4. Holder status — server-verified writes only ─────────────────────────
CREATE OR REPLACE FUNCTION public.apply_verified_holder_status(
  p_user_id uuid,
  p_wallet_address text,
  p_balance_base_units bigint,
  p_is_stale boolean DEFAULT false,
  p_refresh_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tier_rec RECORD;
  row public.holder_status;
  bal bigint := greatest(coalesce(p_balance_base_units, 0), 0);
BEGIN
  IF NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden: service role required';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user required';
  END IF;

  SELECT * INTO tier_rec FROM public.rt_holder_tier_from_balance(bal);

  INSERT INTO public.holder_status (
    user_id, wallet_address, token_balance_base_units,
    holder_tier, rp_multiplier, last_checked_at,
    is_stale, refresh_failed_at, last_refresh_error
  ) VALUES (
    p_user_id, nullif(trim(p_wallet_address), ''), bal,
    tier_rec.holder_tier, tier_rec.rp_multiplier, now(),
    coalesce(p_is_stale, false),
    CASE WHEN p_refresh_error IS NOT NULL THEN now() ELSE NULL END,
    nullif(left(trim(p_refresh_error), 500), '')
  )
  ON CONFLICT (user_id) DO UPDATE SET
    wallet_address = coalesce(nullif(trim(EXCLUDED.wallet_address), ''), holder_status.wallet_address),
    token_balance_base_units = CASE
      WHEN coalesce(p_is_stale, false) AND EXCLUDED.token_balance_base_units = 0
        THEN holder_status.token_balance_base_units
      ELSE EXCLUDED.token_balance_base_units
    END,
    holder_tier = CASE
      WHEN coalesce(p_is_stale, false) AND EXCLUDED.token_balance_base_units = 0
        THEN holder_status.holder_tier
      ELSE EXCLUDED.holder_tier
    END,
    rp_multiplier = CASE
      WHEN coalesce(p_is_stale, false) AND EXCLUDED.token_balance_base_units = 0
        THEN holder_status.rp_multiplier
      ELSE EXCLUDED.rp_multiplier
    END,
    last_checked_at = now(),
    is_stale = coalesce(p_is_stale, false),
    refresh_failed_at = CASE WHEN p_refresh_error IS NOT NULL THEN now() ELSE holder_status.refresh_failed_at END,
    last_refresh_error = coalesce(nullif(left(trim(p_refresh_error), 500), ''), holder_status.last_refresh_error)
  RETURNING * INTO row;

  RETURN jsonb_build_object('ok', true, 'holderStatus', to_jsonb(row));
END;
$$;

-- Replace client-trusted refresh — reject balance parameter from browser
CREATE OR REPLACE FUNCTION public.refresh_holder_status(p_balance_base_units bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  row public.holder_status;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO row FROM public.holder_status WHERE user_id = uid;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'holderStatus', to_jsonb(row),
      'cached', true,
      'message', 'Use refresh-holder-status edge function for on-chain verification'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'no_holder_status',
    'message', 'Call refresh-holder-status edge function'
  );
END;
$$;

-- ─── 5. Epoch finalization with deterministic remainder ─────────────────────
-- Remainder policy: after floor allocation, distribute +1 base unit each to
-- players sorted by effective_points DESC, user_id ASC until pool exhausted.
CREATE OR REPLACE FUNCTION public.rt_finalize_reward_epoch(p_epoch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ep public.reward_epochs;
  rec RECORD;
  alloc bigint;
  min_claim bigint := 1000000;
  total_allocated bigint := 0;
  remainder bigint;
  rem_rec RECORD;
BEGIN
  SELECT * INTO ep FROM public.reward_epochs WHERE id = p_epoch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'not_found');
  END IF;
  IF ep.status = 'closed' THEN
    RETURN jsonb_build_object('finalized', false, 'duplicate', true, 'epochId', ep.id);
  END IF;

  UPDATE public.reward_epochs
  SET status = 'finalized', finalized_at = coalesce(finalized_at, now())
  WHERE id = ep.id;

  IF ep.total_effective_points <= 0 THEN
    UPDATE public.reward_epochs SET status = 'closed', allocated_total_base_units = 0 WHERE id = ep.id;
    RETURN jsonb_build_object('finalized', true, 'participants', 0, 'allocated', 0);
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _epoch_alloc (
    user_id uuid PRIMARY KEY,
    effective_points bigint NOT NULL,
    token_amount_base_units bigint NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  TRUNCATE _epoch_alloc;

  INSERT INTO _epoch_alloc (user_id, effective_points, token_amount_base_units)
  SELECT user_id, sum(effective_points)::bigint AS pts,
         floor(ep.token_pool_base_units::numeric * sum(effective_points) / ep.total_effective_points)::bigint
  FROM public.reward_point_ledger
  WHERE epoch_id = ep.id
  GROUP BY user_id;

  SELECT coalesce(sum(token_amount_base_units), 0) INTO total_allocated FROM _epoch_alloc;
  remainder := ep.token_pool_base_units - total_allocated;

  FOR rem_rec IN
    SELECT user_id FROM _epoch_alloc
    WHERE token_amount_base_units >= min_claim
    ORDER BY effective_points DESC, user_id ASC
  LOOP
    EXIT WHEN remainder <= 0;
    UPDATE _epoch_alloc
    SET token_amount_base_units = token_amount_base_units + 1
    WHERE user_id = rem_rec.user_id;
    remainder := remainder - 1;
    total_allocated := total_allocated + 1;
  END LOOP;

  FOR rec IN SELECT * FROM _epoch_alloc LOOP
    IF rec.token_amount_base_units < min_claim THEN
      CONTINUE;
    END IF;
    INSERT INTO public.player_epoch_rewards (
      epoch_id, user_id, effective_points, token_amount_base_units, status
    ) VALUES (
      ep.id, rec.user_id, rec.effective_points, rec.token_amount_base_units,
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

  UPDATE public.reward_epochs
  SET status = 'closed', allocated_total_base_units = total_allocated
  WHERE id = ep.id;

  RETURN jsonb_build_object(
    'finalized', true,
    'epochId', ep.id,
    'allocated', total_allocated,
    'pool', ep.token_pool_base_units,
    'remainderDistributed', ep.token_pool_base_units - total_allocated
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.run_reward_epoch_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ep RECORD;
  finalized jsonb;
  finalized_count integer := 0;
  day_key text := public.rt_utc_daily_key(now());
  day_start timestamptz := (day_key::date AT TIME ZONE 'UTC');
  day_end timestamptz := day_start + interval '1 day';
  pool bigint := 10000000000000;
  new_epoch public.reward_epochs;
BEGIN
  IF NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden: service role required';
  END IF;

  FOR ep IN
    SELECT * FROM public.reward_epochs
    WHERE status = 'open' AND now() >= ends_at
    ORDER BY ends_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    finalized := public.rt_finalize_reward_epoch(ep.id);
    IF (finalized->>'finalized')::boolean THEN
      finalized_count := finalized_count + 1;
    END IF;
  END LOOP;

  INSERT INTO public.reward_epochs (
    period_key, starts_at, ends_at, token_pool_base_units, status
  ) VALUES (
    day_key, day_start, day_end, pool, 'open'
  )
  ON CONFLICT (period_key) DO NOTHING;

  SELECT * INTO new_epoch FROM public.reward_epochs WHERE period_key = day_key;

  RETURN jsonb_build_object(
    'ok', true,
    'finalizedCount', finalized_count,
    'currentEpochId', new_epoch.id,
    'currentPeriodKey', day_key
  );
END;
$$;

-- ─── 6. Claim coordination RPCs ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.begin_epoch_reward_claim(p_epoch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  reward public.player_epoch_rewards;
  ep public.reward_epochs;
  w text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO ep FROM public.reward_epochs WHERE id = p_epoch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'epoch not found'; END IF;

  IF ep.status = 'open' AND now() >= ep.ends_at THEN
    PERFORM public.rt_finalize_reward_epoch(ep.id);
  END IF;

  SELECT * INTO reward
  FROM public.player_epoch_rewards
  WHERE epoch_id = p_epoch_id AND user_id = uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_allocation');
  END IF;

  IF reward.status = 'confirmed' THEN
    RETURN jsonb_build_object('ok', false, 'duplicate', true, 'reward', to_jsonb(reward));
  END IF;

  IF reward.status = 'processing' AND reward.transaction_signature IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'recover', true,
      'reward', to_jsonb(reward),
      'transactionSignature', reward.transaction_signature
    );
  END IF;

  IF reward.status = 'failed' THEN
    IF reward.attempt_count >= 5 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'max_attempts', 'reward', to_jsonb(reward));
    END IF;
  ELSIF reward.status NOT IN ('claimable', 'pending', 'failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_claimable', 'status', reward.status);
  END IF;

  w := public.rt_resolve_auth_wallet(uid);
  IF w IS NULL OR length(trim(w)) < 32 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_wallet');
  END IF;

  UPDATE public.player_epoch_rewards SET
    status = 'processing',
    destination_wallet = w,
    attempt_count = attempt_count + 1,
    last_attempt_at = now(),
    failure_code = NULL,
    failure_message = NULL
  WHERE id = reward.id AND status IN ('claimable', 'pending', 'failed')
  RETURNING * INTO reward;

  IF NOT FOUND THEN
    SELECT * INTO reward FROM public.player_epoch_rewards WHERE id = reward.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'claim_in_progress', 'reward', to_jsonb(reward));
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reward', to_jsonb(reward),
    'walletAddress', w,
    'tokenAmountBaseUnits', reward.token_amount_base_units
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_epoch_reward_claim(
  p_reward_id uuid,
  p_transaction_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reward public.player_epoch_rewards;
BEGIN
  IF NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden: service role required';
  END IF;

  SELECT * INTO reward FROM public.player_epoch_rewards WHERE id = p_reward_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reward not found'; END IF;

  IF reward.status = 'confirmed' THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'reward', to_jsonb(reward));
  END IF;

  UPDATE public.player_epoch_rewards SET
    status = 'confirmed',
    transaction_signature = coalesce(nullif(trim(p_transaction_signature), ''), transaction_signature),
    claimed_at = now(),
    failure_code = NULL,
    failure_message = NULL
  WHERE id = p_reward_id
  RETURNING * INTO reward;

  RETURN jsonb_build_object('ok', true, 'reward', to_jsonb(reward));
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_epoch_reward_claim(
  p_reward_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_transaction_signature text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reward public.player_epoch_rewards;
BEGIN
  IF NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden: service role required';
  END IF;

  SELECT * INTO reward FROM public.player_epoch_rewards WHERE id = p_reward_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reward not found'; END IF;

  IF reward.status = 'confirmed' THEN
    RETURN jsonb_build_object('ok', false, 'duplicate', true, 'reward', to_jsonb(reward));
  END IF;

  UPDATE public.player_epoch_rewards SET
    status = CASE WHEN attempt_count >= 5 THEN 'failed' ELSE 'claimable' END,
    failure_code = nullif(left(trim(p_failure_code), 80), ''),
    failure_message = nullif(left(trim(p_failure_message), 500), ''),
    transaction_signature = coalesce(nullif(trim(p_transaction_signature), ''), transaction_signature),
    last_attempt_at = now()
  WHERE id = p_reward_id
  RETURNING * INTO reward;

  RETURN jsonb_build_object('ok', true, 'reward', to_jsonb(reward));
END;
$$;

CREATE OR REPLACE FUNCTION public.store_epoch_reward_signature(
  p_reward_id uuid,
  p_transaction_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reward public.player_epoch_rewards;
BEGIN
  IF NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden: service role required';
  END IF;

  UPDATE public.player_epoch_rewards SET
    transaction_signature = nullif(trim(p_transaction_signature), ''),
    status = CASE WHEN status = 'claimable' THEN 'processing' ELSE status END
  WHERE id = p_reward_id
  RETURNING * INTO reward;

  IF NOT FOUND THEN RAISE EXCEPTION 'reward not found'; END IF;
  RETURN jsonb_build_object('ok', true, 'reward', to_jsonb(reward));
END;
$$;

-- Dev-only direct claim when settlement disabled
CREATE OR REPLACE FUNCTION public.claim_epoch_reward(p_epoch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  begin_result jsonb;
  reward public.player_epoch_rewards;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  IF public.rt_settlement_mode() <> 'disabled' THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'requiresEdgeFunction', true,
      'message', 'Production claims use claim-rugtown-reward edge function'
    );
  END IF;

  begin_result := public.begin_epoch_reward_claim(p_epoch_id);
  IF coalesce((begin_result->>'ok')::boolean, false) = false THEN
    RETURN jsonb_build_object('claimed', false, 'begin', begin_result);
  END IF;

  reward := (begin_result->'reward')::jsonb;
  PERFORM public.complete_epoch_reward_claim(
    ((begin_result->'reward')->>'id')::uuid,
    'dev:settlement_disabled'
  );

  SELECT * INTO reward FROM public.player_epoch_rewards
  WHERE epoch_id = p_epoch_id AND user_id = uid;

  RETURN jsonb_build_object('claimed', true, 'devMode', true, 'reward', to_jsonb(reward));
END;
$$;

-- ─── 7. Auto daily guild completion after third claim ───────────────────────
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
  claimed_count integer;
  day_result jsonb;
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

  UPDATE public.player_progression SET rep = new_rep, updated_at = now()
  WHERE player_id = uid RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  UPDATE public.player_guild_contracts
  SET status = 'claimed', claimed_at = now()
  WHERE id = c.id
  RETURNING * INTO c;

  day_result := NULL;
  IF c.contract_type = 'daily' THEN
    SELECT count(*) INTO claimed_count
    FROM public.player_guild_contracts pg
    WHERE pg.user_id = uid
      AND pg.contract_type = 'daily'
      AND pg.period_key = c.period_key
      AND pg.status = 'claimed';

    IF claimed_count >= 3 THEN
      day_result := public.complete_guild_day();
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'duplicate', false,
    'repAwarded', c.rep_reward,
    'contract', to_jsonb(c),
    'progression', to_jsonb(prog),
    'dailyCompletion', day_result
  );
END;
$$;

-- ─── 8. Vault state — lifetime claimed ──────────────────────────────────────
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
  lifetime bigint := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO hs FROM public.holder_status WHERE user_id = uid;
  ep := public.rt_ensure_open_reward_epoch();

  SELECT coalesce(sum(effective_points), 0) INTO epoch_points
  FROM public.reward_point_ledger
  WHERE user_id = uid AND epoch_id = ep.id;

  SELECT coalesce(sum(token_amount_base_units), 0) INTO lifetime
  FROM public.player_epoch_rewards
  WHERE user_id = uid AND status = 'confirmed';

  IF ep.total_effective_points > 0 THEN
    projected := floor(
      ep.token_pool_base_units::numeric * epoch_points / ep.total_effective_points
    )::bigint;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.claimed_at NULLS FIRST), '[]'::jsonb)
  INTO claimable
  FROM public.player_epoch_rewards r
  WHERE r.user_id = uid AND r.status IN ('claimable', 'processing', 'pending', 'failed');

  RETURN jsonb_build_object(
    'holderStatus', CASE WHEN hs.user_id IS NULL THEN NULL ELSE to_jsonb(hs) END,
    'currentEpoch', to_jsonb(ep),
    'epochEffectivePoints', epoch_points,
    'projectedTokenBaseUnits', projected,
    'lifetimeClaimedBaseUnits', lifetime,
    'claimableRewards', claimable,
    'settlementMode', public.rt_settlement_mode()
  );
END;
$$;

-- ─── 9. Grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.apply_verified_holder_status(uuid, text, bigint, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_verified_holder_status(uuid, text, bigint, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.run_reward_epoch_maintenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_reward_epoch_maintenance() TO service_role;

REVOKE ALL ON FUNCTION public.begin_epoch_reward_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_epoch_reward_claim(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.complete_epoch_reward_claim(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_epoch_reward_claim(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.fail_epoch_reward_claim(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_epoch_reward_claim(uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.store_epoch_reward_signature(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_epoch_reward_signature(uuid, text) TO service_role;

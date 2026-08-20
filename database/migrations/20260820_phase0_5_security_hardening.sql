-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 0.5 — Security Hardening
--
-- Scope: RugTown Claude Takeover Report §17 (RPC/function security sweep) plus
-- the table-level RLS gaps in §7/§16. This migration does NOT touch gameplay,
-- auth flow, progression design, missions, or leaderboards — those are later
-- phases. Everything here is either:
--   (a) an explicit REVOKE/GRANT tightening execution privileges, or
--   (b) a CREATE OR REPLACE that adds an authorization check to an existing
--       function without changing its legitimate behavior, or
--   (c) a CREATE OR REPLACE that closes a client-trust gap with a bounded,
--       minimal change (push_progression_snapshot).
--
-- Every function this migration touches was read in full from the actual
-- migration files (not assumed) before being modified, and every legitimate
-- caller (client code, Edge Functions, other RPCs) was traced via grep across
-- src/, supabase/functions/, and database/migrations/ before changing its
-- authorization, specifically to avoid breaking real functionality.
--
-- Correction to the takeover report: independent re-verification during this
-- migration found that rt_finalize_reward_epoch and rt_resolve_auth_wallet
-- are ALREADY `REVOKE ALL ... FROM PUBLIC` in
-- 20260813_phase15_prelaunch_wallet_guild_vault.sql (lines 1386-1388, commented
-- "Internal helpers: no client execute"), and CREATE OR REPLACE FUNCTION does
-- NOT reset privileges in PostgreSQL — so that REVOKE persists across
-- phase15_1's later redefinition of rt_finalize_reward_epoch. As written in
-- the repository, assuming both Phase 15 files are applied (in either order —
-- see the analysis in the completion report), neither function is actually
-- PUBLIC-executable today. This migration still hardens both with an internal
-- auth check as defense-in-depth (belt-and-suspenders against a future
-- accidental GRANT, which this codebase has already done once via Phase 13C's
-- blanket table grant), and re-states the REVOKE explicitly so the safe state
-- is self-documenting here rather than depending on a reader finding it 1,300
-- lines into a different file.
--
-- Apply AFTER Phase 16 (20260817_phase16_100level_progression.sql).
-- Additive/tightening only — no DROP TABLE, no data loss, no gameplay changes.
-- Safe to re-run: every REVOKE/GRANT/CREATE OR REPLACE here is idempotent.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — rt_finalize_reward_epoch: defense-in-depth (already REVOKEd)
-- ═══════════════════════════════════════════════════════════════════════════
-- Verified callers: only run_reward_epoch_maintenance() (phase15_1), which
-- already requires rt_is_service_role() before calling this. No client code
-- calls it. Body otherwise unchanged from the phase15_1 (live, applied-last)
-- version — only the guard at the top is new.

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
  -- Phase 0.5: explicit internal guard. Previously this function relied
  -- entirely on the caller-side REVOKE ALL FROM PUBLIC in
  -- phase15_prelaunch_wallet_guild_vault.sql — correct today, but fragile if
  -- a future migration ever adds a GRANT without re-checking this file.
  IF NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden: service role required';
  END IF;

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

-- Idempotent re-statement of the existing safe state (see header note).
REVOKE ALL ON FUNCTION public.rt_finalize_reward_epoch(uuid) FROM PUBLIC;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — rt_resolve_auth_wallet: defense-in-depth (already REVOKEd)
-- ═══════════════════════════════════════════════════════════════════════════
-- Verified callers: create_rugtown_profile (phase15_prelaunch:536) and
-- refresh_holder_status (both versions) — all three call it as
-- rt_resolve_auth_wallet(uid) where uid := auth.uid(), i.e. always resolving
-- the CALLER'S OWN wallet. Adding a self-or-service-role guard matches every
-- existing call site exactly and closes the theoretical arbitrary-p_user_id
-- info-disclosure path for good, not just via the caller-side REVOKE.

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
  -- Phase 0.5: only the wallet owner (matched via auth.uid()) or a
  -- service-role caller may resolve a wallet address. Every current caller
  -- already passes auth.uid() as p_user_id, so this is a no-op for
  -- legitimate use and closes the arbitrary-lookup path.
  IF p_user_id IS DISTINCT FROM auth.uid() AND NOT public.rt_is_service_role() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

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

REVOKE ALL ON FUNCTION public.rt_resolve_auth_wallet(uuid) FROM PUBLIC;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — rt_grant_title: close the open gap (CONFIRMED exploitable)
-- ═══════════════════════════════════════════════════════════════════════════
-- Unlike Section 1/2, this one genuinely has no REVOKE anywhere in the
-- codebase — verified by grep across all 16 migration files. New functions
-- default to PUBLIC EXECUTE in Postgres, and anon/authenticated have schema
-- USAGE (granted in Phase 13C), so this was directly callable by any client
-- with `supabase.rpc('rt_grant_title', {...})`.
--
-- All 3 legitimate callers (evaluate_player_achievements, line 926;
-- claim_season_pass_reward, line 1267; operator_grant_title, line 1482 — all
-- in phase10i_achievements_season_pass_analytics.sql) are themselves
-- SECURITY DEFINER functions that already validate eligibility/ownership/
-- operator-role before calling this. None of them need PUBLIC/anon/
-- authenticated execute on rt_grant_title itself — a SECURITY DEFINER
-- function's internal calls run with the function owner's privileges, which
-- always retains access to functions it owns regardless of REVOKE ALL FROM
-- PUBLIC. This REVOKE has zero functional impact on any legitimate flow.

REVOKE ALL ON FUNCTION public.rt_grant_title(uuid, text, text, text) FROM PUBLIC;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4 — push_progression_snapshot: close the client-trust gap
-- ═══════════════════════════════════════════════════════════════════════════
-- Grants were already correct (REVOKE ALL FROM PUBLIC + GRANT authenticated);
-- the problem is purely behavioral. The original accepted client-declared
-- XP/REP/Points and did an unconditional greatest(server, client) merge with
-- only a non-negative check — a single call could set any of these fields to
-- an arbitrary large number.
--
-- Per the Phase 0.5 brief, this is the MINIMUM SAFE CHANGE, not a redesign:
--   1. Each field's per-call delta is capped to a generous bound that easily
--      covers a real 10-second gameplay burst (the client debounces sync
--      calls to at most once per 10s) but rejects an arbitrary-value
--      injection in a single call.
--   2. A minimum interval between accepted syncs (5 seconds) is enforced
--      using player_progression.updated_at as the natural anchor, bounding
--      how fast an attacker could stack capped deltas even with a scripted
--      client.
-- A full receipt-correlated/event-sourced progression rework (verifying each
-- XP/REP/Points grant against an actual server-recorded gameplay event) is
-- out of scope here and is called out for Phase 1/3 progression work.

CREATE OR REPLACE FUNCTION public.push_progression_snapshot(
  p_lifetime_xp   bigint,
  p_rep           integer,
  p_points_daily  integer,
  p_points_weekly integer,
  p_points_lifetime integer,
  p_streak_current  integer DEFAULT NULL,
  p_streak_longest  integer DEFAULT NULL,
  p_streak_date     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid           uuid    := auth.uid();
  prog          public.player_progression;
  today         text    := public.rt_utc_daily_key(now());
  this_week     text    := public.rt_utc_weekly_key(now());
  new_xp        bigint;
  new_rep       integer;
  new_level     integer;
  new_daily     integer;
  new_weekly    integer;
  new_lifetime  integer;
  active_season text;
  -- Phase 0.5: bounded per-call deltas (belt-and-suspenders anti-cheat cap,
  -- not a full redesign — see section header comment).
  MAX_XP_DELTA_PER_CALL     CONSTANT bigint  := 5000;
  MAX_REP_DELTA_PER_CALL    CONSTANT integer := 500;
  MAX_POINTS_DELTA_PER_CALL CONSTANT integer := 2000;
  MIN_SYNC_INTERVAL         CONSTANT interval := interval '5 seconds';
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  -- Validate inputs — reject negative or absurd values (anti-cheat boundary).
  IF coalesce(p_lifetime_xp, 0)    < 0 THEN RAISE EXCEPTION 'invalid xp';          END IF;
  IF coalesce(p_rep, 0)            < 0 THEN RAISE EXCEPTION 'invalid rep';          END IF;
  IF coalesce(p_points_daily, 0)   < 0 THEN RAISE EXCEPTION 'invalid daily points'; END IF;
  IF coalesce(p_points_weekly, 0)  < 0 THEN RAISE EXCEPTION 'invalid weekly points';END IF;
  IF coalesce(p_points_lifetime, 0)< 0 THEN RAISE EXCEPTION 'invalid lifetime points';END IF;

  prog := public.rt_ensure_progression(uid);

  -- Phase 0.5: rate-limit — reject calls faster than MIN_SYNC_INTERVAL apart.
  -- Uses updated_at as a natural per-player anchor; no new table needed.
  IF prog.updated_at IS NOT NULL AND now() - prog.updated_at < MIN_SYNC_INTERVAL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'rate_limited',
      'progression', to_jsonb(prog)
    );
  END IF;

  -- Run period resets before merging so stale client buckets can't un-reset.
  PERFORM public.rt_reset_period_points_if_needed(uid);
  -- Re-read after potential reset.
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;

  -- Server wins on XP and REP: take max (never allow client to decrease
  -- them), but cap the accepted increase per call (Phase 0.5).
  new_xp  := least(
    greatest(prog.lifetime_xp, coalesce(p_lifetime_xp, 0)),
    prog.lifetime_xp + MAX_XP_DELTA_PER_CALL
  );
  new_rep := least(
    greatest(prog.rep, coalesce(p_rep, 0)),
    prog.rep + MAX_REP_DELTA_PER_CALL
  );
  new_level := public.rt_recompute_level(new_xp, 4);

  -- Points: accept client value only if the period is still current, capped
  -- to the same per-call delta bound (Phase 0.5).
  new_daily   := CASE
    WHEN coalesce(prog.daily_points_date, '') = today
    THEN least(
      greatest(prog.daily_points, coalesce(p_points_daily, 0)),
      prog.daily_points + MAX_POINTS_DELTA_PER_CALL
    )
    ELSE prog.daily_points   -- server already reset; ignore stale client value
  END;
  new_weekly  := CASE
    WHEN coalesce(prog.weekly_points_week, '') = this_week
    THEN least(
      greatest(prog.weekly_points, coalesce(p_points_weekly, 0)),
      prog.weekly_points + MAX_POINTS_DELTA_PER_CALL
    )
    ELSE prog.weekly_points
  END;
  -- Lifetime points (rug_points) only go up, same per-call cap.
  new_lifetime := least(
    greatest(prog.rug_points, coalesce(p_points_lifetime, 0)),
    prog.rug_points + MAX_POINTS_DELTA_PER_CALL
  );

  SELECT id INTO active_season
  FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC LIMIT 1;

  PERFORM public.rt_set_mutation_flag();

  UPDATE public.player_progression
  SET lifetime_xp          = new_xp,
      level                = new_level,
      rep                  = new_rep,
      rug_points           = new_lifetime,
      daily_points         = new_daily,
      daily_points_date    = today,
      weekly_points        = new_weekly,
      weekly_points_week   = this_week,
      progression_curve_version = 4,
      updated_at           = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  -- Keep profiles.rep in sync.
  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  RETURN jsonb_build_object(
    'ok',           true,
    'level',        prog.level,
    'lifetime_xp',  prog.lifetime_xp,
    'rep',          prog.rep,
    'rug_points',   prog.rug_points,
    'daily_points', prog.daily_points,
    'weekly_points',prog.weekly_points,
    'progression',  to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.push_progression_snapshot(bigint, integer, integer, integer, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.push_progression_snapshot(bigint, integer, integer, integer, integer, integer, integer, text) TO authenticated;

COMMENT ON FUNCTION public.push_progression_snapshot IS
  'Client -> server progression sync. Server wins on XP/REP (max-wins, capped at 5000 XP / 500 REP / 2000 Points per call, minimum 5s between accepted calls). Points accept client value only if the period has not been server-reset. Curve v4, level cap 100. Phase 0.5: bounded deltas are a stopgap, not a full anti-cheat redesign -- see Phase 1/3 progression work for a receipt-correlated replacement.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5 — NULL-bypass authorization fixes (fail closed on NULL)
-- ═══════════════════════════════════════════════════════════════════════════
-- Five functions used the pattern:
--   IF auth.uid() IS NOT NULL AND auth.uid() <> target AND NOT operator THEN
--     RAISE EXCEPTION ...
--   END IF;
-- When auth.uid() IS NULL the whole condition is false and the check is
-- silently skipped instead of rejecting. All five are already
-- `GRANT ... TO authenticated` only (not anon), so a normal PostgREST/browser
-- caller always has a non-null auth.uid() and was never able to exploit this
-- directly -- but the logic is wrong regardless (any future service-role or
-- anon grant would instantly reopen it), so it's fixed here on principle,
-- exactly as instructed. Fixed form: reject NULL explicitly, then check
-- ownership/operator for everyone else. Bodies are otherwise byte-for-byte
-- unchanged from their live (most-recent) versions.

CREATE OR REPLACE FUNCTION public.enqueue_achievement_evaluation(
  p_player_id uuid,
  p_event_type text,
  p_event_id text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  key text := coalesce(p_idempotency_key, p_player_id::text || ':' || p_event_type || ':' || coalesce(p_event_id, gen_random_uuid()::text));
  row_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF auth.uid() <> p_player_id AND NOT public.rt_is_operator('operator') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  INSERT INTO public.achievement_evaluation_queue (player_id, event_type, event_id, event_payload, idempotency_key)
  VALUES (p_player_id, p_event_type, p_event_id, p_payload, key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO row_id;
  RETURN jsonb_build_object('queued', row_id IS NOT NULL, 'id', row_id, 'key', key, 'idempotent', row_id IS NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_achievement_evaluation(uuid,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_achievement_evaluation(uuid,text,text,jsonb,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.evaluate_player_achievements(p_player_id uuid DEFAULT NULL, p_event_type text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := coalesce(p_player_id, auth.uid());
  rec RECORD;
  value integer;
  prow public.player_achievement_progress;
  unlock_id uuid;
  unlocked integer := 0;
  progressed integer := 0;
  lvl_before integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF auth.uid() <> uid AND NOT public.rt_is_operator('operator') THEN RAISE EXCEPTION 'not authorized'; END IF;
-- Local ensure (evaluate already authorizes; avoids nested auth.uid checks)
  INSERT INTO public.player_progression (player_id)
  VALUES (uid) ON CONFLICT (player_id) DO NOTHING;
  SELECT level INTO lvl_before FROM public.player_progression WHERE player_id = uid FOR UPDATE;

  FOR rec IN
    SELECT d.*, r.id AS rule_id, r.progress_target, r.reward_xp, r.reward_rep, r.reward_rug_points, r.reward_season_points
    FROM public.achievement_definitions d
    JOIN public.achievement_rule_versions r ON r.achievement_id = d.id AND r.is_active
    WHERE d.status = 'active' AND (d.starts_at IS NULL OR d.starts_at <= now()) AND (d.ends_at IS NULL OR d.ends_at >= now())
  LOOP
    IF NOT rec.is_repeatable AND EXISTS (
      SELECT 1 FROM public.player_achievements WHERE player_id = uid AND achievement_id = rec.id AND verification_status <> 'revoked'
    ) THEN CONTINUE; END IF;

    value := public.rt_rule_value(uid, rec.rule_id);
    INSERT INTO public.player_achievement_progress
      (player_id, achievement_id, rule_version_id, current_value, target_value, status, first_progress_at, last_progress_at)
    VALUES
      (uid, rec.id, rec.rule_id, value, rec.progress_target,
       CASE WHEN value >= rec.progress_target THEN 'completed' ELSE 'tracking' END,
       CASE WHEN value > 0 THEN now() ELSE NULL END,
       CASE WHEN value > 0 THEN now() ELSE NULL END)
    ON CONFLICT (player_id, achievement_id, rule_version_id) DO UPDATE SET
      current_value = GREATEST(public.player_achievement_progress.current_value, EXCLUDED.current_value),
      status = CASE
        WHEN public.player_achievement_progress.status IN ('claimed','revoked') THEN public.player_achievement_progress.status
        WHEN GREATEST(public.player_achievement_progress.current_value, EXCLUDED.current_value) >= rec.progress_target THEN 'completed'
        ELSE 'tracking' END,
      last_progress_at = CASE WHEN EXCLUDED.current_value > public.player_achievement_progress.current_value THEN now() ELSE public.player_achievement_progress.last_progress_at END,
      updated_at = now()
    RETURNING * INTO prow;
    progressed := progressed + 1;

    IF prow.status = 'completed' AND NOT EXISTS (
      SELECT 1 FROM public.player_achievements WHERE player_id = uid AND achievement_id = rec.id AND verification_status <> 'revoked'
    ) THEN
      INSERT INTO public.player_achievements (player_id, achievement_id, rule_version_id, completion_number, reward_claimed_at)
      VALUES (uid, rec.id, rec.rule_id, 1, now())
      ON CONFLICT (player_id, achievement_id, completion_number) DO NOTHING
      RETURNING id INTO unlock_id;
      IF unlock_id IS NOT NULL THEN
        UPDATE public.player_achievement_progress SET status = 'claimed', completed_at = now() WHERE id = prow.id;
        PERFORM public.rt_set_mutation_flag();
        UPDATE public.player_progression SET
          lifetime_xp = lifetime_xp + rec.reward_xp,
          rep = rep + rec.reward_rep,
          rug_points = rug_points + rec.reward_rug_points,
          season_points = season_points + rec.reward_season_points,
          level = public.rt_recompute_level(lifetime_xp + rec.reward_xp),
          claimed_reward_keys = claimed_reward_keys || jsonb_build_array('achievement:' || rec.id || ':reward')
        WHERE player_id = uid AND NOT (claimed_reward_keys ? ('achievement:' || rec.id || ':reward'));
        IF rec.reward_xp > 0 THEN
          INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key, metadata)
          VALUES (uid, 'XP', rec.reward_xp, 'Achievement unlock', 'achievement', rec.id, 'achievement:' || rec.id || ':xp',
            jsonb_build_object('rep', rec.reward_rep, 'rugPoints', rec.reward_rug_points, 'seasonPoints', rec.reward_season_points))
          ON CONFLICT (player_id, idempotency_key) DO NOTHING;
        END IF;
        IF rec.reward_rep > 0 THEN
          INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
          VALUES (uid, 'REP', rec.reward_rep, 'Achievement unlock', 'achievement', rec.id, 'achievement:' || rec.id || ':rep')
          ON CONFLICT (player_id, idempotency_key) DO NOTHING;
        END IF;
        -- mutation flag is transaction-local; no clear needed
        PERFORM public.rt_grant_title(uid, rec.title_unlock_id, 'achievement', rec.id);
        PERFORM public.rt_notify(uid, 'achievement_unlocked', 'Achievement unlocked', rec.name, 'achievement', jsonb_build_object('achievementId', rec.id));
        PERFORM public.rt_prog_history(uid, 'achievement_unlocked', rec.reward_xp, rec.reward_rep, rec.reward_rug_points, rec.reward_season_points, 0,
          lvl_before, (SELECT level FROM public.player_progression WHERE player_id = uid), rec.title_unlock_id, rec.id);
        PERFORM public.rt_analytics_event(uid, 'achievement_unlocked', 'evaluation', unlock_id::text, rec.id);
        unlocked := unlocked + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('playerId', uid, 'progressed', progressed, 'unlocked', unlocked, 'eventType', p_event_type);
END;
$$;
REVOKE ALL ON FUNCTION public.evaluate_player_achievements(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_player_achievements(uuid,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.evaluate_season_pass_progress(p_player_id uuid DEFAULT NULL, p_pass_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := coalesce(p_player_id, auth.uid());
  pass public.season_passes;
  psp public.player_season_pass;
  new_tier integer;
  old_tier integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  -- Phase 0.5: this function previously had NO ownership/operator check at
  -- all (only the uid IS NULL guard above). Any authenticated user could
  -- force recomputation/notification against any other player's season pass.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF auth.uid() <> uid AND NOT public.rt_is_operator('operator') THEN RAISE EXCEPTION 'not authorized'; END IF;

  SELECT * INTO pass FROM public.season_passes
  WHERE id = coalesce(p_pass_id, id) AND status = 'active'
  ORDER BY starts_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_active_pass'); END IF;
  IF pass.status = 'finalized' THEN RETURN jsonb_build_object('ok', false, 'reason', 'finalized'); END IF;

  INSERT INTO public.player_season_pass (player_id, season_pass_id)
  VALUES (uid, pass.id) ON CONFLICT (player_id, season_pass_id) DO NOTHING;

  SELECT * INTO psp FROM public.player_season_pass WHERE player_id=uid AND season_pass_id=pass.id FOR UPDATE;
  old_tier := psp.current_tier;
  -- Derive tier from points (server-side only)
  SELECT coalesce(max(tier_number), 0) INTO new_tier
  FROM public.season_pass_tiers
  WHERE season_pass_id = pass.id AND points_required <= psp.season_pass_points;

  IF new_tier > old_tier THEN
    UPDATE public.player_season_pass SET current_tier = new_tier, last_progress_at = now(),
      completed_at = CASE WHEN new_tier >= pass.max_tier THEN now() ELSE completed_at END,
      updated_at = now()
    WHERE id = psp.id;
    PERFORM public.rt_notify(uid, 'season_pass_tier', 'Season Pass tier reached',
      'You reached tier ' || new_tier::text, 'pass', jsonb_build_object('tier', new_tier, 'passId', pass.id));
    PERFORM public.rt_prog_history(uid, 'season_pass_tier', 0,0,0,0,0, NULL,NULL, NULL, NULL,
      jsonb_build_object('tier', new_tier, 'passId', pass.id));
    PERFORM public.rt_analytics_event(uid, 'season_pass_tier_reached', 'season_pass', pass.id, NULL, new_tier);
  END IF;
  RETURN jsonb_build_object('ok', true, 'passId', pass.id, 'points', psp.season_pass_points, 'tier', GREATEST(old_tier, new_tier));
END; $$;
REVOKE ALL ON FUNCTION public.evaluate_season_pass_progress(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_season_pass_progress(uuid,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.grant_season_pass_points(
  p_player_id uuid, p_pass_id text, p_points integer, p_idempotency_key text, p_source text DEFAULT 'system'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pass public.season_passes; psp public.player_season_pass;
BEGIN
  IF p_points <= 0 THEN RAISE EXCEPTION 'invalid points'; END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF auth.uid() <> p_player_id AND NOT public.rt_is_operator('operator') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT * INTO pass FROM public.season_passes WHERE id = p_pass_id FOR UPDATE;
  IF NOT FOUND OR pass.status <> 'active' THEN RAISE EXCEPTION 'pass not active'; END IF;

  -- Idempotency via analytics event uniqueness on source
  IF EXISTS (
    SELECT 1 FROM public.reward_analytics_events
    WHERE player_id = p_player_id AND event_type = 'season_pass_points' AND source_id = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;

  INSERT INTO public.player_season_pass (player_id, season_pass_id)
  VALUES (p_player_id, p_pass_id) ON CONFLICT (player_id, season_pass_id) DO NOTHING;

  UPDATE public.player_season_pass
  SET season_pass_points = season_pass_points + p_points, last_progress_at = now(), updated_at = now()
  WHERE player_id = p_player_id AND season_pass_id = p_pass_id
  RETURNING * INTO psp;

  UPDATE public.player_progression
  SET season_pass_points = season_pass_points + p_points WHERE player_id = p_player_id;

  PERFORM public.rt_analytics_event(p_player_id, 'season_pass_points', p_source, p_idempotency_key, NULL, p_points);
  PERFORM public.evaluate_season_pass_progress(p_player_id, p_pass_id);
  RETURN jsonb_build_object('ok', true, 'points', psp.season_pass_points, 'tier', psp.current_tier);
END; $$;
REVOKE ALL ON FUNCTION public.grant_season_pass_points(uuid,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_season_pass_points(uuid,text,integer,text,text) TO authenticated;


CREATE OR REPLACE FUNCTION public.evaluate_party_shared_mission(p_mission_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.party_shared_missions; d public.party_mission_definitions; contributors integer; members integer; review boolean:=false;
BEGIN
 SELECT * INTO m FROM public.party_shared_missions WHERE id=p_mission_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'mission not found'; END IF;
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
 IF public.rt_active_party_id(auth.uid()) IS DISTINCT FROM m.party_id THEN RAISE EXCEPTION 'not a party member'; END IF;
 SELECT * INTO d FROM public.party_mission_definitions WHERE id=m.mission_definition_id;
 SELECT count(*),count(*) FILTER (WHERE contribution_value>0) INTO members,contributors FROM public.party_mission_members WHERE party_shared_mission_id=m.id AND left_at IS NULL AND eligibility_status='eligible';
 review := (members>=2 AND contributors<=1 AND d.min_contribution_per_member>0) OR (m.progress_target>=4 AND now()-m.started_at<interval '30 seconds' AND m.progress_value>=m.progress_target);
 IF review THEN UPDATE public.party_shared_missions SET status='under_review',risk_outcome='review',updated_at=now() WHERE id=m.id AND status='active'; END IF;
 RETURN jsonb_build_object('ok',true,'complete',m.progress_value>=m.progress_target,'underReview',review,'eligibleContributors',contributors);
END; $$;
-- (grants for this function are unchanged from phase10k — body-only fix)


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6 — Maintenance/batch RPCs: require service-role OR operator
-- ═══════════════════════════════════════════════════════════════════════════
-- These three are called both by a scheduled Edge Function
-- (supabase/functions/process-achievement-queue/index.ts, which uses
-- SUPABASE_SERVICE_ROLE_KEY -- i.e. genuinely service_role) and, for
-- run_progression_maintenance, by src/components/RewardOperationsPanel.tsx
-- (a UI gated client-side on rewardService.isOperator(), whose own comment
-- says "Access is enforced server-side" -- meaning THIS check is the actual
-- boundary the panel was always meant to rely on). Both were previously
-- `GRANT ... TO authenticated` with NO internal role check at all -- any
-- logged-in player could trigger batch achievement evaluation and
-- economy-snapshot generation at will. The fix adds the check the comments
-- already implied should exist, without changing behavior for either
-- legitimate caller.

CREATE OR REPLACE FUNCTION public.process_achievement_evaluation_queue(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE job uuid; q public.achievement_evaluation_queue; processed integer := 0; failed integer := 0;
BEGIN
  IF NOT (public.rt_is_service_role() OR public.rt_is_operator('operator')) THEN
    RAISE EXCEPTION 'forbidden: operator or service role required';
  END IF;
  INSERT INTO public.analytics_job_runs (job_name, status) VALUES ('process_achievement_evaluation_queue', 'running') RETURNING id INTO job;
  FOR q IN SELECT * FROM public.achievement_evaluation_queue WHERE status = 'pending' AND available_at <= now()
           ORDER BY available_at ASC LIMIT least(greatest(coalesce(p_limit,50),1),200) FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      UPDATE public.achievement_evaluation_queue SET status='processing', started_at=now(), attempt_count=attempt_count+1 WHERE id=q.id;
      PERFORM public.evaluate_player_achievements(q.player_id, q.event_type);
      UPDATE public.achievement_evaluation_queue SET status='completed', completed_at=now() WHERE id=q.id;
      processed := processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.achievement_evaluation_queue SET status=CASE WHEN attempt_count>=5 THEN 'dead_letter' ELSE 'failed' END,
        failed_at=now(), error_code='eval_error', error_message_safe=left(SQLERRM,200), available_at=now()+interval '5 minutes' WHERE id=q.id;
      failed := failed + 1;
    END;
  END LOOP;
  UPDATE public.analytics_job_runs SET status='completed', completed_at=now(), rows_processed=processed, metadata=jsonb_build_object('failed',failed) WHERE id=job;
  RETURN jsonb_build_object('processed',processed,'failed',failed,'jobId',job);
END; $$;
REVOKE ALL ON FUNCTION public.process_achievement_evaluation_queue(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_achievement_evaluation_queue(integer) TO authenticated;


CREATE OR REPLACE FUNCTION public.generate_economy_daily_snapshot(p_date date DEFAULT (CURRENT_DATE - 1))
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE job uuid; snap public.economy_daily_snapshots;
BEGIN
  IF NOT (public.rt_is_service_role() OR public.rt_is_operator('operator')) THEN
    RAISE EXCEPTION 'forbidden: operator or service role required';
  END IF;
  INSERT INTO public.analytics_job_runs (job_name, status, metadata)
  VALUES ('generate_economy_daily_snapshot', 'running', jsonb_build_object('date', p_date))
  RETURNING id INTO job;

  INSERT INTO public.economy_daily_snapshots AS s (
    snapshot_date, authenticated_players, xp_emitted, rep_emitted, rug_points_emitted,
    season_points_emitted, season_pass_points_emitted, rewards_claimed, rewards_pending,
    claim_failures, settlements_completed, achievement_unlock_count, mission_completion_count,
    wallet_verification_count
  )
  SELECT
    p_date,
    (SELECT count(*) FROM public.player_progression WHERE updated_at::date = p_date),
    coalesce((SELECT sum(amount) FROM public.reward_ledger WHERE reward_type='XP' AND created_at::date=p_date),0),
    coalesce((SELECT sum(amount) FROM public.reward_ledger WHERE reward_type='REP' AND created_at::date=p_date),0),
    coalesce((SELECT sum(amount) FROM public.reward_ledger WHERE reward_type='RUG_POINTS' AND created_at::date=p_date),0),
    coalesce((SELECT sum(amount) FROM public.reward_ledger WHERE reward_type='SEASON_POINTS' AND created_at::date=p_date),0),
    coalesce((SELECT sum(amount) FROM public.reward_analytics_events WHERE event_type='season_pass_points' AND occurred_at::date=p_date),0),
    (SELECT count(*) FROM public.claimable_rewards WHERE status='completed' AND claimed_at::date=p_date),
    (SELECT count(*) FROM public.claimable_rewards WHERE status NOT IN ('completed','failed','cancelled','expired')),
    (SELECT count(*) FROM public.claimable_rewards WHERE status='failed' AND created_at::date=p_date),
    (SELECT count(*) FROM public.reward_settlements WHERE status='finalized' AND finalized_at::date=p_date),
    (SELECT count(*) FROM public.player_achievements WHERE unlocked_at::date=p_date),
    coalesce((SELECT count(*) FROM public.reward_analytics_events WHERE event_type='mission_completed' AND occurred_at::date=p_date),0),
    (SELECT count(*) FROM public.verified_wallets WHERE verified_at::date=p_date)
  ON CONFLICT (snapshot_date) DO UPDATE SET
    authenticated_players = EXCLUDED.authenticated_players,
    xp_emitted = EXCLUDED.xp_emitted,
    rep_emitted = EXCLUDED.rep_emitted,
    rug_points_emitted = EXCLUDED.rug_points_emitted,
    season_points_emitted = EXCLUDED.season_points_emitted,
    season_pass_points_emitted = EXCLUDED.season_pass_points_emitted,
    rewards_claimed = EXCLUDED.rewards_claimed,
    rewards_pending = EXCLUDED.rewards_pending,
    claim_failures = EXCLUDED.claim_failures,
    settlements_completed = EXCLUDED.settlements_completed,
    achievement_unlock_count = EXCLUDED.achievement_unlock_count,
    mission_completion_count = EXCLUDED.mission_completion_count,
    wallet_verification_count = EXCLUDED.wallet_verification_count
  RETURNING * INTO snap;

  UPDATE public.analytics_job_runs SET status='completed', completed_at=now(), rows_processed=1 WHERE id=job;
  RETURN to_jsonb(snap);
END; $$;
REVOKE ALL ON FUNCTION public.generate_economy_daily_snapshot(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_economy_daily_snapshot(date) TO authenticated;


CREATE OR REPLACE FUNCTION public.run_progression_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job uuid;
  queue_result jsonb;
  pending integer;
  failed integer;
  snapshot jsonb;
BEGIN
  IF NOT (public.rt_is_service_role() OR public.rt_is_operator('operator')) THEN
    RAISE EXCEPTION 'forbidden: operator or service role required';
  END IF;
  INSERT INTO public.analytics_job_runs (job_name, status) VALUES ('run_progression_maintenance', 'running') RETURNING id INTO job;

  -- Process evaluation queue
  queue_result := public.process_achievement_evaluation_queue(100);

  SELECT count(*) INTO pending FROM public.achievement_evaluation_queue WHERE status='pending';
  SELECT count(*) INTO failed FROM public.achievement_evaluation_queue WHERE status IN ('failed','dead_letter');
  IF pending > 200 THEN
    PERFORM public.rt_raise_alert('warning','achievements','eval_backlog','Achievement evaluation backlog',
      'Pending evaluations exceed 200', 'queue', NULL);
  END IF;
  IF failed > 20 THEN
    PERFORM public.rt_raise_alert('high','achievements','eval_failures','Repeated evaluation failures',
      'Failed/dead-letter evaluations exceed 20', 'queue', NULL);
  END IF;

  snapshot := public.generate_economy_daily_snapshot(CURRENT_DATE - 1);

  -- Detect stuck claims (eligible > 7 days)
  IF EXISTS (
    SELECT 1 FROM public.claimable_rewards
    WHERE status IN ('eligible','reserved') AND created_at < now() - interval '7 days'
  ) THEN
    PERFORM public.rt_raise_alert('warning','claims','stuck_claims','Stuck claims detected',
      'Claims eligible/reserved for more than 7 days', 'claims', NULL);
  END IF;

  UPDATE public.analytics_job_runs SET status='completed', completed_at=now(),
    metadata = jsonb_build_object('queue', queue_result, 'pending', pending, 'failed', failed)
  WHERE id = job;

  RETURN jsonb_build_object('ok', true, 'queue', queue_result, 'pending', pending, 'failed', failed, 'jobId', job);
END; $$;
REVOKE ALL ON FUNCTION public.run_progression_maintenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_progression_maintenance() TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7 — REVOKE PUBLIC from ungated internal helpers
-- ═══════════════════════════════════════════════════════════════════════════
-- All 12 below were verified via grep to have (a) no REVOKE anywhere in any
-- migration, and (b) zero direct callers in src/ or supabase/functions/ --
-- every call site is another SECURITY DEFINER function calling them
-- internally. This matches the safe pattern already used correctly elsewhere
-- in this same codebase for equivalent internal helpers (e.g. phase10k's
-- rt_party_audit/rt_party_analytics/rt_active_party_id, which are already
-- REVOKEd from PUBLIC with no functional issue). No function bodies change;
-- only execution privileges.

REVOKE ALL ON FUNCTION public.rt_analytics_event(uuid, text, text, text, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_prog_history(uuid, text, integer, integer, integer, integer, integer, integer, integer, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_rule_value(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_seed_achievement(text, text, text, text, public.achievement_category, public.achievement_rarity, public.achievement_rule_type, integer, jsonb, integer, integer, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_raise_alert(public.alert_severity, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_social_restricted(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_social_audit(uuid, uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_social_analytics(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_check_rate_limit(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_ensure_profile_settings(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_is_blocked(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rt_are_friends(uuid, uuid) FROM PUBLIC;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 8 — migrate_local_progression: fix curve-version drift
-- ═══════════════════════════════════════════════════════════════════════════
-- rt_recompute_level(bigint) was redefined 4 times (v1 -> v2 -> v3 -> v4) as
-- the XP curve advanced; every other award path was migrated to route through
-- the 2-arg rt_recompute_level(xp, curve_version) dispatcher, EXCEPT this
-- function, which still hardcodes rt_recompute_level_v2 and stamps
-- progression_curve_version = 2. A guest-to-authenticated migration running
-- today computes the grandfathered level on the OLD v2 curve while every
-- other reward path is on v4 -- fixed here to use the current dispatcher.
-- Body is otherwise byte-for-byte unchanged.

CREATE OR REPLACE FUNCTION public.migrate_local_progression(
  p_guest_identity text,
  p_idempotency_key text,
  p_local jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  prog public.player_progression;
  existing public.guest_migrations;
  local_xp bigint;
  local_rep integer;
  merged_xp bigint;
  merged_rep integer;
  merged_keys jsonb;
  merged_titles jsonb;
  summary jsonb;
  mid text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_idempotency_key IS NULL OR p_guest_identity IS NULL THEN
    RAISE EXCEPTION 'invalid migration request';
  END IF;

  SELECT * INTO existing FROM public.guest_migrations
  WHERE idempotency_key = p_idempotency_key
     OR (auth_player_id = uid AND guest_identity = p_guest_identity);
  IF FOUND THEN
    prog := public.rt_ensure_progression(uid);
    PERFORM public.rt_sync_chapter_mission_state(uid);
    RETURN jsonb_build_object(
      'merged', false, 'duplicate', true,
      'progression', to_jsonb(prog), 'summary', existing.summary
    );
  END IF;

  prog := public.rt_ensure_progression(uid);

  IF prog.migrated_from_local THEN
    PERFORM public.rt_sync_chapter_mission_state(uid);
    RETURN jsonb_build_object(
      'merged', false, 'duplicate', false, 'refused', true,
      'reason', 'server already authoritative', 'progression', to_jsonb(prog)
    );
  END IF;

  local_xp := greatest(0, coalesce((p_local->>'lifetimeXp')::bigint, 0));
  local_rep := greatest(0, coalesce((p_local->>'rep')::integer, 0));
  merged_xp := greatest(prog.lifetime_xp, local_xp);
  merged_rep := greatest(prog.rep, local_rep);
  merged_keys := coalesce(prog.claimed_reward_keys, '[]'::jsonb)
    || coalesce(p_local->'claimedRewardKeys', '[]'::jsonb);
  merged_titles := coalesce(prog.unlocked_titles, '[]'::jsonb)
    || coalesce(p_local->'unlockedTitleIds', '[]'::jsonb);

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.player_progression SET
    lifetime_xp = merged_xp,
    -- Phase 0.5: was hardcoded rt_recompute_level_v2(merged_xp) / curve 2.
    -- Now routes through the current dispatcher (v4) like every other RPC.
    level = greatest(prog.level, public.rt_recompute_level(merged_xp, 4)),
    rep = merged_rep,
    progression_curve_version = 4,
    claimed_reward_keys = (
      SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
      FROM jsonb_array_elements_text(merged_keys) AS value
    ),
    unlocked_titles = (
      SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
      FROM jsonb_array_elements_text(merged_titles) AS value
    ),
    discoveries = coalesce(discoveries, '{}'::jsonb) || coalesce(p_local->'discoveries', '{}'::jsonb),
    achievement_progress = coalesce(achievement_progress, '{}'::jsonb)
      || coalesce(p_local->'achievementProgress', '{}'::jsonb),
    migrated_from_local = true,
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = merged_rep WHERE id = uid;

  -- Sync chapter rows from guest completedMissions array (no duplicate rewards).
  IF jsonb_typeof(p_local->'completedMissions') = 'array' THEN
    FOR mid IN
      SELECT value FROM jsonb_array_elements_text(p_local->'completedMissions') AS value
      WHERE value LIKE 'ch1_%'
    LOOP
      PERFORM public.rt_sync_chapter_mission_state(uid);
      -- Only advance state; rewards must still go through complete_chapter_mission.
      UPDATE public.chapter_mission_state
      SET status = 'completed',
          completed_at = coalesce(completed_at, now()),
          updated_at = now()
      WHERE user_id = uid AND mission_id = mid AND reward_claimed_at IS NULL;
    END LOOP;
    PERFORM public.rt_sync_chapter_mission_state(uid);
  END IF;

  summary := jsonb_build_object(
    'guestIdentity', p_guest_identity,
    'guestXp', local_xp,
    'mergedXp', merged_xp,
    'guestRep', local_rep,
    'mergedRep', merged_rep
  );

  INSERT INTO public.guest_migrations (auth_player_id, guest_identity, idempotency_key, summary)
  VALUES (uid, p_guest_identity, p_idempotency_key, summary);

  RETURN jsonb_build_object('merged', true, 'duplicate', false, 'progression', to_jsonb(prog), 'summary', summary);
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_local_progression(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_local_progression(text, text, jsonb) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 9 — Table-level RLS gaps (report §7/§16)
-- ═══════════════════════════════════════════════════════════════════════════

-- 9a. profiles.holder_tier -- verified ZERO legitimate RPC writers anywhere
-- in the codebase (apply_verified_holder_status only writes holder_status,
-- a separate correctly-gated table). Safe to protect with no functional
-- impact. Adding to the existing reward-column trigger allowlist.
--
-- 9b. profiles.social_restricted_until / username_changed_at -- DO have
-- legitimate writers (apply_moderation_action, run_social_maintenance,
-- update_player_username) that do not currently call
-- rt_set_mutation_flag(). Those three are updated below (bodies otherwise
-- unchanged) to call it before writing, so they keep working once these
-- columns are added to the protected list.

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
    -- Phase 0.5 additions:
    NEW.holder_tier := OLD.holder_tier;
    NEW.social_restricted_until := OLD.social_restricted_until;
    NEW.username_changed_at := OLD.username_changed_at;
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    NEW.username_normalized := lower(trim(NEW.username));
  END IF;
  RETURN NEW;
END;
$$;
-- Trigger definition (DROP/CREATE) already exists from phase15_prelaunch and
-- points at this function by name -- no re-creation needed, CREATE OR REPLACE
-- above is sufficient since the trigger just calls the function by name.

-- 9c. Legitimate writer: update_player_username (self-service rename).
-- Adds rt_set_mutation_flag() before its profiles UPDATE. Body otherwise
-- unchanged.
CREATE OR REPLACE FUNCTION public.update_player_username(p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  n text;
  check_res jsonb;
  old_name text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF public.rt_social_restricted(uid) THEN RAISE EXCEPTION 'social restricted'; END IF;
  check_res := public.check_username_availability(p_username);
  IF NOT coalesce((check_res->>'available')::boolean, false) THEN
    RETURN check_res || jsonb_build_object('ok', false);
  END IF;
  n := check_res->>'normalized';

  SELECT username INTO old_name FROM public.profiles WHERE id = uid FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = uid AND username_changed_at IS NOT NULL AND username_changed_at > now() - interval '14 days'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cooldown');
  END IF;

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.profiles SET username = p_username, username_changed_at = now() WHERE id = uid;
  INSERT INTO public.username_history (player_id, username, normalized, changed_by)
  VALUES (uid, p_username, n, uid);
  PERFORM public.rt_social_audit(uid, uid, 'username_changed', 'profile', n, jsonb_build_object('from', old_name, 'to', p_username));
  RETURN jsonb_build_object('ok', true, 'username', p_username);
END; $$;
REVOKE ALL ON FUNCTION public.update_player_username(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_player_username(text) TO authenticated;

-- 9d. Legitimate writer: apply_moderation_action (moderator-gated already).
-- Adds rt_set_mutation_flag() before its profiles UPDATE. Body otherwise
-- unchanged.
CREATE OR REPLACE FUNCTION public.apply_moderation_action(
  p_target uuid, p_action_type text, p_reason_code text, p_reason_safe text,
  p_case_id uuid DEFAULT NULL, p_duration_hours integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); aid uuid;
BEGIN
  IF NOT public.rt_is_social_operator('moderator') THEN RAISE EXCEPTION 'moderator authorization required'; END IF;
  IF p_reason_safe IS NULL OR length(trim(p_reason_safe)) < 3 THEN RAISE EXCEPTION 'reason required'; END IF;

  INSERT INTO public.moderation_actions (case_id, target_player_id, action_type, reason_code, reason_safe, created_by, ends_at)
  VALUES (p_case_id, p_target, p_action_type, p_reason_code, p_reason_safe, uid,
    CASE WHEN p_duration_hours IS NOT NULL THEN now() + (p_duration_hours || ' hours')::interval ELSE NULL END)
  RETURNING id INTO aid;

  IF p_action_type IN ('direct_message_restriction','social_suspension','chat_mute') THEN
    PERFORM public.rt_set_mutation_flag();
    UPDATE public.profiles SET social_restricted_until = coalesce(
      now() + (coalesce(p_duration_hours, 24) || ' hours')::interval, social_restricted_until
    ) WHERE id = p_target;
  END IF;

  IF p_action_type = 'message_removal' AND p_case_id IS NOT NULL THEN
    -- Soft-remove linked message if evidence points to one
    NULL;
  END IF;

  PERFORM public.rt_notify(p_target, 'moderation_warning', 'Account notice', p_reason_safe, 'mod',
    jsonb_build_object('action', p_action_type));
  PERFORM public.rt_social_audit(uid, p_target, 'moderation_action', p_action_type, aid::text,
    jsonb_build_object('reasonCode', p_reason_code));
  RETURN jsonb_build_object('ok', true, 'actionId', aid);
END; $$;
REVOKE ALL ON FUNCTION public.apply_moderation_action(uuid,text,text,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_moderation_action(uuid,text,text,text,uuid,integer) TO authenticated;

-- 9e. Legitimate writer: run_social_maintenance (moderator-gated already,
-- resets expired restrictions). Adds rt_set_mutation_flag() before its
-- profiles UPDATE. Body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.run_social_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE expired_fr integer; expired_mr integer; stale_presence integer; expired_restr integer;
BEGIN
  IF NOT public.rt_is_social_operator('moderator') THEN RAISE EXCEPTION 'moderator authorization required'; END IF;
  UPDATE public.friend_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < now();
  GET DIAGNOSTICS expired_fr = ROW_COUNT;
  UPDATE public.message_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < now();
  GET DIAGNOSTICS expired_mr = ROW_COUNT;
  UPDATE public.player_presence_state SET status = 'offline'
  WHERE status <> 'offline' AND last_heartbeat_at < now() - interval '2 minutes';
  GET DIAGNOSTICS stale_presence = ROW_COUNT;
  PERFORM public.rt_set_mutation_flag();
  UPDATE public.profiles SET social_restricted_until = NULL
  WHERE social_restricted_until IS NOT NULL AND social_restricted_until < now();
  GET DIAGNOSTICS expired_restr = ROW_COUNT;

  IF (SELECT count(*) FROM public.moderation_cases WHERE status IN ('open','triaged') AND opened_at < now() - interval '2 days') > 10 THEN
    INSERT INTO public.social_operational_alerts (severity, category, code, title, message_safe)
    VALUES ('warning','moderation','case_backlog','Moderation case backlog','Open cases older than 2 days exceed threshold')
    ON CONFLICT (code) WHERE status = 'open' DO UPDATE SET
      last_seen_at = now(), occurrence_count = public.social_operational_alerts.occurrence_count + 1;
  END IF;

  RETURN jsonb_build_object(
    'expiredFriendRequests', expired_fr,
    'expiredMessageRequests', expired_mr,
    'stalePresence', stale_presence,
    'expiredRestrictions', expired_restr
  );
END; $$;
REVOKE ALL ON FUNCTION public.run_social_maintenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_social_maintenance() TO authenticated;

-- 9f. player_daily_streaks: DROP the owner-UPDATE policy. Verified via grep
-- across src/ and all migrations that NOTHING writes to this table today --
-- no client code references it, no RPC updates or inserts into it. It is an
-- unused table with a dangerously permissive policy left over from Phase 14.
-- Converting to read-only (matching the "no client write policy" pattern
-- used everywhere else in this schema) has zero functional impact today and
-- closes the direct-client-write hole for whenever this table's real
-- server-side writer is eventually built (Phase 1/3 progression work).
DROP POLICY IF EXISTS "daily_streaks: owner update" ON public.player_daily_streaks;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 10 — Verification queries (informational only, safe to run)
-- ═══════════════════════════════════════════════════════════════════════════
-- After applying, run these manually in the Supabase SQL Editor to confirm:
--
--   -- Confirm no PUBLIC/anon execute remains on the hardened functions:
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN (
--     'rt_finalize_reward_epoch','rt_resolve_auth_wallet','rt_grant_title',
--     'rt_analytics_event','rt_prog_history','rt_rule_value','rt_seed_achievement',
--     'rt_raise_alert','rt_social_restricted','rt_social_audit','rt_social_analytics',
--     'rt_check_rate_limit','rt_ensure_profile_settings','rt_is_blocked','rt_are_friends'
--   );
--   -- Expect: anon_can_execute = false and authenticated_can_execute = false for all rows.
--
--   -- Confirm player_daily_streaks no longer allows client UPDATE:
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'public.player_daily_streaks'::regclass;
--   -- Expect: only the "daily_streaks: owner read" SELECT policy remains.
--
--   -- Confirm the reward-column trigger now protects the new columns
--   -- (requires a live test as an authenticated non-service caller):
--   --   UPDATE profiles SET holder_tier = 'Gold' WHERE id = auth.uid();
--   --   SELECT holder_tier FROM profiles WHERE id = auth.uid();
--   -- Expect: holder_tier unchanged from before the UPDATE.
-- ═══════════════════════════════════════════════════════════════════════════

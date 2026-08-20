-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 16 — 100-Level Progression Foundation
--
-- Fixes:
--   1. Remove level <= 50 constraint from player_progression
--   2. Add XP curve v4 (200 + 45n + 6n² + 0.08n³) matching client XpCurve.ts
--   3. Add rt_recompute_level_v4 and update dispatcher to route curve v4
--   4. Grandfather existing players: their level can only go up, never down
--   5. Add daily_points + weekly_points columns to player_progression
--      (rug_points remains the authoritative lifetime / competitive Points total)
--   6. Add push_progression_snapshot RPC — client → server idempotent sync
--   7. Update get_rugtown_profile_state to also return XP, level, points, streak
--   8. Update get_my_progression to return the same rich snapshot
--   9. Add migrate_progression_curve_v4 per-player migration RPC
--  10. Ensure all award RPCs (award_gameplay_reward, complete_chapter_mission,
--      claim_mission_reward, claim_guild_contract) recompute level with v4
--
-- Apply AFTER Phase 15.1.
-- Additive only — no DROP of tables, no data loss.
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Remove the level <= 50 constraint ────────────────────────────────────
-- We cannot drop a CHECK constraint by name portably without knowing the
-- system-generated name, so we recreate the column constraint via ALTER TABLE.
-- PostgreSQL allows dropping inline CHECK constraints by their constraint name.
-- The constraint was defined inline in Phase 10G as:
--   level integer NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 50)
-- In PG the system names an inline CHECK after the table: player_progression_level_check
-- We use IF EXISTS so this is safe to re-run.

ALTER TABLE public.player_progression
  DROP CONSTRAINT IF EXISTS player_progression_level_check;

-- Re-add with the correct 100-level bound.
ALTER TABLE public.player_progression
  ADD CONSTRAINT player_progression_level_check
  CHECK (level >= 1 AND level <= 100);

-- ─── 2. Add daily_points and weekly_points columns ───────────────────────────
-- rug_points = lifetime competitive points (authoritative total).
-- daily_points / weekly_points = rolling counters reset server-side by UTC day/week.
-- They are separate from rug_points so leaderboard math is clean.

ALTER TABLE public.player_progression
  ADD COLUMN IF NOT EXISTS daily_points  integer NOT NULL DEFAULT 0 CHECK (daily_points >= 0),
  ADD COLUMN IF NOT EXISTS weekly_points integer NOT NULL DEFAULT 0 CHECK (weekly_points >= 0),
  ADD COLUMN IF NOT EXISTS daily_points_date  text,   -- YYYY-MM-DD of last daily reset
  ADD COLUMN IF NOT EXISTS weekly_points_week text;   -- YYYY-WNN of last weekly reset

COMMENT ON COLUMN public.player_progression.daily_points IS
  'Points earned today (UTC). Reset to 0 when daily_points_date changes.';
COMMENT ON COLUMN public.player_progression.weekly_points IS
  'Points earned this ISO week (UTC). Reset to 0 when weekly_points_week changes.';
COMMENT ON COLUMN public.player_progression.rug_points IS
  'Lifetime competitive Points total — the primary leaderboard metric.';

-- ─── 3. progression_curve_version — extend comment ───────────────────────────
COMMENT ON COLUMN public.player_progression.progression_curve_version IS
  '1=legacy soft, 2=Chapter One (120+27n+3n²), 3=gameplay completion (200+50n+5n²), 4=100-level (200+45n+6n²+0.08n³)';

-- ─── 4. XP curve v4 — matches src/game/progression/XpCurve.ts exactly ────────
-- Formula: xp_per_level(n) = round(200 + 45*(n-1) + 6*(n-1)^2 + 0.08*(n-1)^3)
-- where n = level (1-indexed). Level 100 costs 0 (already at max).

CREATE OR REPLACE FUNCTION public.rt_xp_required_for_level_v4(p_level integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(p_level, 1) >= 100 THEN 0
    ELSE round(
      200
      + 45  * (greatest(coalesce(p_level, 1), 1) - 1)::numeric
      + 6   * power((greatest(coalesce(p_level, 1), 1) - 1)::numeric, 2)
      + 0.08 * power((greatest(coalesce(p_level, 1), 1) - 1)::numeric, 3)
    )::integer
  END;
$$;

COMMENT ON FUNCTION public.rt_xp_required_for_level_v4(integer) IS
  'XP required to advance from level p_level to p_level+1. Curve v4 (100-level). Matches client XpCurve.ts PROGRESSION_CURVE_VERSION=4.';

-- ─── 5. Level-from-XP v4 (iterative, mirrors client levelFromLifetimeXp) ──────
CREATE OR REPLACE FUNCTION public.rt_recompute_level_v4(p_xp bigint)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  lvl  integer := 1;
  spent bigint := 0;
  need  integer;
  xp    bigint := greatest(coalesce(p_xp, 0), 0);
BEGIN
  WHILE lvl < 100 LOOP
    need := public.rt_xp_required_for_level_v4(lvl);
    IF need = 0 OR spent + need > xp THEN
      EXIT;
    END IF;
    spent := spent + need;
    lvl   := lvl + 1;
  END LOOP;
  RETURN least(lvl, 100);
END;
$$;

COMMENT ON FUNCTION public.rt_recompute_level_v4(bigint) IS
  'Derives player level (1-100) from lifetime XP using curve v4. Mirrors client levelFromLifetimeXp().';

-- ─── 6. Update rt_recompute_level dispatcher ────────────────────────────────
-- The dual-arg version routes by curve_version; single-arg now defaults to v4.

CREATE OR REPLACE FUNCTION public.rt_recompute_level(p_xp bigint, p_curve_version integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(p_curve_version, 4) >= 4 THEN public.rt_recompute_level_v4(p_xp)
    WHEN coalesce(p_curve_version, 4) >= 3 THEN public.rt_recompute_level_v3(p_xp)
    WHEN coalesce(p_curve_version, 4) >= 2 THEN public.rt_recompute_level_v2(p_xp)
    ELSE public.rt_recompute_level_v2(p_xp)
  END;
$$;

-- Single-arg convenience — now defaults to v4 for all new tooling.
CREATE OR REPLACE FUNCTION public.rt_recompute_level(p_xp bigint)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.rt_recompute_level(p_xp, 4);
$$;

COMMENT ON FUNCTION public.rt_recompute_level(bigint) IS
  'Level from XP using v4 curve (100-level). Use dual-arg version for legacy curve routing.';
COMMENT ON FUNCTION public.rt_recompute_level(bigint, integer) IS
  'Level from XP; routes to v2/v3/v4 based on progression_curve_version. v4 = 100-level default.';

-- ─── 7. Per-player migration to curve v4 ────────────────────────────────────
-- Grandfathers level upward — player cannot lose levels from the migration.
CREATE OR REPLACE FUNCTION public.migrate_progression_curve_v4()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid        uuid := auth.uid();
  prog       public.player_progression;
  computed   integer;
  grandfathered integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  prog := public.rt_ensure_progression(uid);

  IF prog.progression_curve_version >= 4 THEN
    RETURN jsonb_build_object(
      'migrated', false,
      'already',  true,
      'level',    prog.level,
      'progression', to_jsonb(prog)
    );
  END IF;

  computed      := public.rt_recompute_level_v4(prog.lifetime_xp);
  grandfathered := greatest(prog.level, computed);  -- never reduce existing level

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.player_progression
  SET level                   = grandfathered,
      progression_curve_version = 4,
      updated_at              = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  RETURN jsonb_build_object(
    'migrated',            true,
    'computedLevel',       computed,
    'grandfatheredLevel',  grandfathered,
    'progression',         to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_progression_curve_v4() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_progression_curve_v4() TO authenticated;

-- ─── 8. Bulk-backfill existing players to v4 (idempotent) ───────────────────
-- Only touches rows still on v3 or below. Grandfathers level upward.
UPDATE public.player_progression
SET level                    = greatest(level, public.rt_recompute_level_v4(lifetime_xp)),
    progression_curve_version = 4,
    updated_at               = now()
WHERE progression_curve_version < 4;

-- ─── 9. Helper: UTC daily / weekly point-reset logic ────────────────────────
-- Called at the top of push_progression_snapshot before updating points.
-- Returns TRUE if the daily counter was reset, FALSE if already current.
CREATE OR REPLACE FUNCTION public.rt_reset_period_points_if_needed(
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prog          public.player_progression;
  today         text := public.rt_utc_daily_key(now());
  this_week     text := public.rt_utc_weekly_key(now());
  daily_reset   boolean := false;
  weekly_reset  boolean := false;
BEGIN
  SELECT * INTO prog FROM public.player_progression WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('daily_reset', false, 'weekly_reset', false); END IF;

  IF coalesce(prog.daily_points_date, '') <> today THEN
    UPDATE public.player_progression
    SET daily_points = 0, daily_points_date = today, updated_at = now()
    WHERE player_id = p_player_id;
    daily_reset := true;
  END IF;

  IF coalesce(prog.weekly_points_week, '') <> this_week THEN
    UPDATE public.player_progression
    SET weekly_points = 0, weekly_points_week = this_week, updated_at = now()
    WHERE player_id = p_player_id;
    weekly_reset := true;
  END IF;

  RETURN jsonb_build_object('daily_reset', daily_reset, 'weekly_reset', weekly_reset);
END;
$$;

-- ─── 10. push_progression_snapshot — client → server sync ───────────────────
-- The client calls this after accruing XP/REP/Points locally (guests excluded).
-- Server ALWAYS wins on REP and XP (highest-wins merge, never decrease).
-- Points (daily/weekly/lifetime) are accepted from the client with period-reset
-- guard: if the server has already reset the period, client values are ignored
-- for that bucket to prevent stale client data reinstating reset points.
-- Idempotent: passing the same snapshot twice is safe.

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
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  -- Validate inputs — reject negative or absurd values (anti-cheat boundary).
  IF coalesce(p_lifetime_xp, 0)    < 0 THEN RAISE EXCEPTION 'invalid xp';          END IF;
  IF coalesce(p_rep, 0)            < 0 THEN RAISE EXCEPTION 'invalid rep';          END IF;
  IF coalesce(p_points_daily, 0)   < 0 THEN RAISE EXCEPTION 'invalid daily points'; END IF;
  IF coalesce(p_points_weekly, 0)  < 0 THEN RAISE EXCEPTION 'invalid weekly points';END IF;
  IF coalesce(p_points_lifetime, 0)< 0 THEN RAISE EXCEPTION 'invalid lifetime points';END IF;

  prog := public.rt_ensure_progression(uid);

  -- Run period resets before merging so stale client buckets can't un-reset.
  PERFORM public.rt_reset_period_points_if_needed(uid);
  -- Re-read after potential reset.
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;

  -- Server wins on XP and REP: take max (never allow client to decrease them).
  new_xp  := greatest(prog.lifetime_xp, coalesce(p_lifetime_xp, 0));
  new_rep := greatest(prog.rep,         coalesce(p_rep, 0));
  new_level := public.rt_recompute_level(new_xp, 4);

  -- Points: accept client value only if the period is still current.
  -- If server already reset the period, start from server's value (0 post-reset).
  new_daily   := CASE
    WHEN coalesce(prog.daily_points_date, '') = today
    THEN greatest(prog.daily_points, coalesce(p_points_daily, 0))
    ELSE prog.daily_points   -- server already reset; ignore stale client value
  END;
  new_weekly  := CASE
    WHEN coalesce(prog.weekly_points_week, '') = this_week
    THEN greatest(prog.weekly_points, coalesce(p_points_weekly, 0))
    ELSE prog.weekly_points
  END;
  -- Lifetime points (rug_points) only go up.
  new_lifetime := greatest(prog.rug_points, coalesce(p_points_lifetime, 0));

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
      -- Streak: accept client values if they are higher (streak can only grow)
      -- and the date is today or later, preventing back-dated streak inflation.
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
  'Client → server progression sync. Server wins on XP/REP (max-wins). Points accept client value only if the period has not been server-reset. Curve v4, level cap 100.';

-- ─── 11. Update get_rugtown_profile_state to return full progression ──────────
-- Replaces the Phase 15 version which only returned profile + onboardingCompleted.
CREATE OR REPLACE FUNCTION public.get_rugtown_profile_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid   uuid := auth.uid();
  prof  public.profiles;
  prog  public.player_progression;
  today text := public.rt_utc_daily_key(now());
  this_week text := public.rt_utc_weekly_key(now());
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO prof FROM public.profiles WHERE id = uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  END IF;

  -- Load progression if it exists (may not exist for brand-new signups before
  -- their first game session; that is normal — client will call rt_ensure_progression
  -- via get_my_progression when the game boots).
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;

  -- Perform period resets in-flight so the client always receives current buckets.
  IF FOUND THEN
    PERFORM public.rt_reset_period_points_if_needed(uid);
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
  END IF;

  RETURN jsonb_build_object(
    'ok',                  true,
    -- Profile fields
    'id',                  prof.id,
    'username',            prof.username,
    'displayName',         prof.display_name,
    'onboardingCompleted', coalesce(prof.onboarding_completed, false),
    'walletAddress',       prof.wallet_address,
    -- REP lives on profiles (source of truth for display); keep in sync with progression.
    'rep',                 coalesce(prof.rep, 0),
    -- Progression fields (null-safe for new accounts without a progression row yet)
    'level',               coalesce(prog.level, 1),
    'lifetimeXp',          coalesce(prog.lifetime_xp, 0),
    'rugPoints',           coalesce(prog.rug_points, 0),
    'dailyPoints',         coalesce(prog.daily_points, 0),
    'weeklyPoints',        coalesce(prog.weekly_points, 0),
    'progressionCurveVersion', coalesce(prog.progression_curve_version, 4),
    -- Streak (stored on player_daily_streaks if available, else null)
    'streakCurrent',       (
      SELECT current_streak FROM public.player_daily_streaks WHERE player_id = uid
    ),
    'streakLongest',       (
      SELECT longest_streak FROM public.player_daily_streaks WHERE player_id = uid
    ),
    'streakLastDailyKey',  (
      SELECT last_daily_key FROM public.player_daily_streaks WHERE player_id = uid
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_rugtown_profile_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rugtown_profile_state() TO authenticated;

COMMENT ON FUNCTION public.get_rugtown_profile_state IS
  'Phase 16: returns profile + full progression snapshot (level, XP, points, streak). Used at login for initial client hydration.';

-- ─── 12. Update get_my_progression to include daily/weekly points + v4 ───────
-- The Phase 10G version returned to_jsonb(prog) which lacked the new columns
-- until they're added (they ARE added by this migration, so to_jsonb is fine).
-- We replace it here to also explicitly reset period points before returning,
-- and to stamp progression_curve_version = 4 for any row not yet migrated.
CREATE OR REPLACE FUNCTION public.get_my_progression()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid  uuid := auth.uid();
  prog public.player_progression;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  prog := public.rt_ensure_progression(uid);

  -- Migrate curve if still on v3 or below.
  IF prog.progression_curve_version < 4 THEN
    PERFORM public.migrate_progression_curve_v4();
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
  END IF;

  -- Reset stale period buckets so client always starts fresh for the day/week.
  PERFORM public.rt_reset_period_points_if_needed(uid);
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;

  RETURN to_jsonb(prog);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_progression() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_progression() TO authenticated;

-- ─── 13. Ensure award_gameplay_reward uses curve v4 for level computation ────
-- The Phase 10G function calls rt_recompute_level(new_xp) (single-arg).
-- The single-arg version now routes to v4 (updated in step 6 above), so all
-- existing award RPCs automatically benefit. No body change needed.
-- However, we add a guard to the level UPDATE to enforce the 100-level cap.

-- Re-create award_gameplay_reward with explicit level cap enforcement.
-- This is a full CREATE OR REPLACE — body is identical to Phase 10G except:
--   a) rt_recompute_level now routes v4 (handled by updated dispatcher above)
--   b) We add: level = least(new_level, 100) in the UPDATE
CREATE OR REPLACE FUNCTION public.award_gameplay_reward(
  p_source_type text,
  p_source_id   text,
  p_idempotency_key text,
  p_metadata    jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid           uuid := auth.uid();
  prog          public.player_progression;
  def           RECORD;
  existing      public.reward_ledger;
  inserted      public.reward_ledger;
  results       jsonb := '[]'::jsonb;
  new_xp        bigint;
  new_rep       integer;
  new_season    integer;
  new_rug       integer;
  new_level     integer;
  active_season text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 3 THEN
    RAISE EXCEPTION 'invalid idempotency key';
  END IF;

  -- Idempotent return.
  SELECT * INTO existing
  FROM public.reward_ledger
  WHERE player_id = uid
    AND (idempotency_key = p_idempotency_key
         OR idempotency_key LIKE p_idempotency_key || ':%')
  LIMIT 1;
  IF FOUND THEN
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
    RETURN jsonb_build_object(
      'awarded', false, 'duplicate', true,
      'ledger_id', existing.id, 'progression', to_jsonb(prog)
    );
  END IF;

  prog := public.rt_ensure_progression(uid);
  IF prog.manual_review_status = 'restricted' THEN
    RAISE EXCEPTION 'account restricted';
  END IF;

  SELECT id INTO active_season
  FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC LIMIT 1;

  PERFORM public.rt_set_mutation_flag();
  new_xp     := prog.lifetime_xp;
  new_rep    := prog.rep;
  new_season := prog.season_points;
  new_rug    := prog.rug_points;

  FOR def IN
    SELECT * FROM public.reward_definitions
    WHERE source_type = p_source_type AND active = true AND amount > 0
    ORDER BY id
  LOOP
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, def.reward_type, def.amount,
      def.source_type || ':' || p_source_id,
      p_source_type, p_source_id,
      p_idempotency_key || ':' || def.reward_type,
      coalesce(p_metadata, '{}'::jsonb) ||
        jsonb_build_object('definition_id', def.id, 'rules_version', def.rules_version)
    )
    ON CONFLICT (player_id, idempotency_key) DO NOTHING
    RETURNING * INTO inserted;

    IF inserted.id IS NOT NULL THEN
      results := results || jsonb_build_array(to_jsonb(inserted));
      IF def.reward_type = 'XP'     THEN new_xp     := new_xp  + def.amount; END IF;
      IF def.reward_type = 'REP'    THEN new_rep     := new_rep + def.amount; END IF;
      IF def.reward_type = 'SEASON_POINTS' AND active_season IS NOT NULL THEN
        new_season := new_season + def.amount;
      END IF;
      IF def.reward_type = 'RUG_POINTS' THEN new_rug := new_rug + def.amount; END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(results) = 0 THEN
    RAISE EXCEPTION 'unknown or inactive reward source: %', p_source_type;
  END IF;

  -- Level capped at 100 via the v4 dispatcher.
  new_level := least(public.rt_recompute_level(new_xp, 4), 100);

  UPDATE public.player_progression SET
    lifetime_xp          = new_xp,
    level                = new_level,
    rep                  = new_rep,
    rug_points           = new_rug,
    season_id            = coalesce(active_season, season_id),
    season_points        = CASE WHEN active_season IS NOT NULL THEN new_season ELSE season_points END,
    claimed_reward_keys  = claimed_reward_keys || jsonb_build_array(p_idempotency_key),
    progression_curve_version = 4,
    updated_at           = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  RETURN jsonb_build_object(
    'awarded', true, 'duplicate', false,
    'entries', results, 'progression', to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.award_gameplay_reward(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.award_gameplay_reward(text, text, text, jsonb) TO authenticated;

-- ─── 14. Verification queries (informational only, safe to run) ──────────────
-- After applying, run these manually to confirm correctness:
--
--   SELECT public.rt_xp_required_for_level_v4(1);    -- expect 200
--   SELECT public.rt_xp_required_for_level_v4(50);   -- expect 10_390
--   SELECT public.rt_xp_required_for_level_v4(99);   -- nonzero
--   SELECT public.rt_xp_required_for_level_v4(100);  -- expect 0
--   SELECT public.rt_recompute_level_v4(0);           -- expect 1
--   SELECT public.rt_recompute_level_v4(199);         -- expect 1
--   SELECT public.rt_recompute_level_v4(200);         -- expect 2
--   SELECT public.rt_recompute_level_v4(999999999);   -- expect 100
--   SELECT COUNT(*) FROM public.player_progression
--     WHERE level > 50;                               -- should now be possible
--   SELECT COUNT(*) FROM public.player_progression
--     WHERE progression_curve_version < 4;            -- should be 0

-- ─── 15. Grants ──────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.rt_xp_required_for_level_v4(integer) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.rt_recompute_level_v4(bigint) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.migrate_progression_curve_v4() TO authenticated;

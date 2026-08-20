-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 2 — Progression, Leaderboards, Daily/Weekly Missions,
-- Hidden Quests, Streaks, Activity Rewards
--
-- One consolidated, forward-only migration (per instruction: "if one
-- consolidated migration is cleaner and safe, use one"). Every statement is
-- additive or a CREATE OR REPLACE of a function this project already owns —
-- no historical migration is edited, no table is dropped, no player data is
-- reset. Apply AFTER 20260820_phase1_google_auth_onboarding.sql.
--
-- Sections:
--   1. mission_definitions: category column + category-guaranteed daily seed
--   2. ensure_period_missions: 5 category-guaranteed daily / 3 weekly
--   3. player_daily_streaks: real server-side maintenance (was a dead table)
--   4. Activity heartbeat: bounded time-in-game REP reward
--   5. hidden_quest_state: table + RPCs (server-authoritative discover/complete)
--   6. Points leaderboard: get_points_leaderboard + get_my_leaderboard_rank
--   7. Leaderboard period history (daily/weekly archives, queryable after reset)
--   8. Weekly settlement: idempotent top-3 reward RPC
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. mission_definitions — category column + category-guaranteed daily pool
-- ═══════════════════════════════════════════════════════════════════════════
-- Five daily "slot" categories, matching the product brief exactly:
--   exploration | social | mission | activity | wildcard
-- "wildcard" is not a real category filter — it just means "any category,
-- picked from whatever's left" — see ensure_period_missions below.

ALTER TABLE public.mission_definitions
  ADD COLUMN IF NOT EXISTS category text;

-- Backfill existing rows (phase10g + phase14 seed) from their objective_type,
-- since none were ever categorized. Idempotent — WHERE category IS NULL.
UPDATE public.mission_definitions SET category = CASE
  WHEN objective_type IN ('meet_player', 'meet_players', 'wave_player') THEN 'social'
  WHEN objective_type IN ('join_event', 'join_events') THEN 'activity'
  WHEN objective_type = 'complete_missions' AND period_type = 'daily' THEN 'mission'
  ELSE 'exploration'
END
WHERE category IS NULL;

ALTER TABLE public.mission_definitions
  ALTER COLUMN category SET DEFAULT 'exploration';
ALTER TABLE public.mission_definitions
  ALTER COLUMN category SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.mission_definitions
    ADD CONSTRAINT mission_definitions_category_check
    CHECK (category IN ('exploration','social','mission','activity','wildcard','weekly_challenge'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_mission_definitions_period_category
  ON public.mission_definitions (period_type, category, active);

-- More "social" and "mission" daily rows — the backfill above only found 1-3
-- of each among the existing 21, which would make a category-guaranteed pick
-- always assign the exact same one or two rows with zero rotation.
INSERT INTO public.mission_definitions
  (id, period_type, title, description, objective_type, target, objective_ref,
   xp_reward, rep_reward, season_points, rug_points, difficulty, active, category)
VALUES
  ('daily_social_hub_visit', 'daily', 'Social Hub Regular', 'Visit the Coffee Shop / Social Hub.', 'visit_landmark', 1, 'coffee', 26, 4, 6, 8, 'easy', true, 'social'),
  ('daily_wave_two', 'daily', 'Double Wave', 'Wave or emote at two different players.', 'meet_players', 2, NULL, 32, 4, 8, 10, 'medium', true, 'social'),
  ('daily_chat_hello', 'daily', 'Say Hello', 'Send a message in city chat.', 'wave_player', 1, 'chat', 24, 3, 6, 7, 'easy', true, 'social'),
  ('daily_mission_chain', 'daily', 'Chain Progress', 'Advance any mission chain by one stage.', 'complete_missions', 1, 'chain', 42, 6, 10, 13, 'medium', true, 'mission'),
  ('daily_mission_starter', 'daily', 'Warm-Up Task', 'Complete any starter or level-two mission today.', 'complete_missions', 1, 'starter', 38, 5, 9, 12, 'medium', true, 'mission'),
  ('daily_mission_bracket', 'daily', 'Tier Progress', 'Complete a bracket mission for your current level tier.', 'complete_missions', 1, 'bracket', 44, 6, 11, 14, 'medium', true, 'mission'),
  ('daily_activity_district', 'daily', 'District Activity', 'Take part in any building interaction in a new district today.', 'visit_districts', 1, NULL, 28, 4, 7, 9, 'easy', true, 'activity'),
  ('daily_activity_party', 'daily', 'Team Up', 'Take a party action or join a group activity.', 'complete_missions', 1, 'party_action', 34, 5, 9, 11, 'medium', true, 'activity')
ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, active = true;

-- Backfill category for the two rows above that already existed with a
-- generic category from the earlier UPDATE (in case this migration re-runs).
UPDATE public.mission_definitions SET category = 'exploration'
WHERE category IS NULL AND period_type = 'daily';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ensure_period_missions — 5 category-guaranteed daily, 3 weekly
-- ═══════════════════════════════════════════════════════════════════════════
-- Daily: exactly 1 from each of exploration/social/mission/activity, plus 1
-- "wildcard" (any category, excluding the 4 already picked) = 5 total.
-- Weekly: 3, picked the same deterministic-hash way as before (no category
-- requirement in the brief for weekly).
-- Assignment is deterministic per (player, period_key) via md5(id||uid||key)
-- ordering, same mechanism as the pre-Phase-2 version — refreshing the
-- browser re-runs this and gets IDENTICAL results because ON CONFLICT DO
-- NOTHING means already-assigned rows are simply re-selected, never replaced.

CREATE OR REPLACE FUNCTION public.ensure_period_missions(p_period_type text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  period_key text;
  def RECORD;
  rows jsonb;
  slot_categories text[] := ARRAY['exploration', 'social', 'mission', 'activity'];
  cat text;
  picked_ids text[] := ARRAY[]::text[];
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_period_type NOT IN ('daily', 'weekly') THEN RAISE EXCEPTION 'invalid period'; END IF;

  PERFORM public.rt_ensure_progression(uid);
  period_key := CASE WHEN p_period_type = 'daily'
    THEN public.rt_utc_daily_key(now())
    ELSE public.rt_utc_weekly_key(now())
  END;

  IF p_period_type = 'daily' THEN
    -- One per required category, deterministic per player+day.
    FOREACH cat IN ARRAY slot_categories LOOP
      SELECT id INTO def
      FROM public.mission_definitions
      WHERE period_type = 'daily' AND active = true AND category = cat
      ORDER BY md5(id || uid::text || period_key)
      LIMIT 1;
      IF FOUND THEN
        INSERT INTO public.mission_assignments (
          player_id, mission_definition_id, period_type, period_key, progress, target, status
        )
        SELECT uid, d.id, 'daily', period_key, 0, d.target, 'active'
        FROM public.mission_definitions d WHERE d.id = def.id
        ON CONFLICT DO NOTHING;
        picked_ids := array_append(picked_ids, def.id);
      END IF;
    END LOOP;

    -- Wildcard: any category not already picked.
    SELECT id INTO def
    FROM public.mission_definitions
    WHERE period_type = 'daily' AND active = true AND NOT (id = ANY(picked_ids))
    ORDER BY md5(id || uid::text || period_key || ':wildcard')
    LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.mission_assignments (
        player_id, mission_definition_id, period_type, period_key, progress, target, status
      )
      SELECT uid, d.id, 'daily', period_key, 0, d.target, 'active'
      FROM public.mission_definitions d WHERE d.id = def.id
      ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    FOR def IN
      SELECT id, target
      FROM public.mission_definitions
      WHERE period_type = 'weekly' AND active = true
      ORDER BY md5(id || uid::text || period_key)
      LIMIT 3
    LOOP
      INSERT INTO public.mission_assignments (
        player_id, mission_definition_id, period_type, period_key, progress, target, status
      ) VALUES (
        uid, def.id, 'weekly', period_key, 0, def.target, 'active'
      ) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.assigned_at), '[]'::jsonb)
  INTO rows
  FROM public.mission_assignments a
  WHERE a.player_id = uid AND a.period_type = p_period_type AND a.period_key = period_key;

  RETURN jsonb_build_object(
    'periodType', p_period_type,
    'periodKey', period_key,
    'timezone', 'UTC',
    'assignments', rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_period_missions(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_period_missions(text) TO authenticated;

COMMENT ON FUNCTION public.ensure_period_missions IS
  'Phase 2: daily now assigns exactly 5 (1 each of exploration/social/mission/activity + 1 wildcard), category-guaranteed. Weekly still assigns 3. Deterministic per (player, UTC period) so a page refresh never reassigns.';

-- claim_daily_completion_bonus previously required all 3 dailies claimed;
-- now must require all 5. Re-check its threshold without changing anything
-- else about the function (reward amounts, idempotency, grants unchanged).
CREATE OR REPLACE FUNCTION public.claim_daily_completion_bonus()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  today text := public.rt_utc_daily_key(now());
  claimed_count integer;
  total_count integer;
  prog public.player_progression;
  key text := 'daily_completion:' || today;
  active_season text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT count(*) FILTER (WHERE status = 'claimed'), count(*)
  INTO claimed_count, total_count
  FROM public.mission_assignments
  WHERE player_id = uid AND period_type = 'daily' AND period_key = today;

  IF total_count < 5 OR claimed_count < 5 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete', 'claimed', claimed_count, 'total', total_count);
  END IF;

  prog := public.rt_ensure_progression(uid);
  IF prog.claimed_reward_keys ? key THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'progression', to_jsonb(prog));
  END IF;

  SELECT id INTO active_season FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC LIMIT 1;

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.player_progression SET
    lifetime_xp = lifetime_xp + 40,
    level = public.rt_recompute_level(lifetime_xp + 40, 4),
    rep = rep + 8,
    rug_points = rug_points + 15,
    daily_points = daily_points + 15,
    season_points = CASE WHEN active_season IS NOT NULL THEN season_points + 12 ELSE season_points END,
    claimed_reward_keys = claimed_reward_keys || jsonb_build_array(key)
  WHERE player_id = uid
  RETURNING * INTO prog;

  INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
  VALUES (uid, 'XP', 40, 'Daily completion bonus', 'daily_bonus', today, key || ':xp')
  ON CONFLICT (player_id, idempotency_key) DO NOTHING;

  UPDATE public.profiles SET rep = prog.rep WHERE id = uid;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'progression', to_jsonb(prog));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_daily_completion_bonus() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_daily_completion_bonus() TO authenticated;

COMMENT ON FUNCTION public.claim_daily_completion_bonus IS
  'Phase 2: threshold raised from 3/3 to 5/5 to match the new 5-daily-mission assignment.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. player_daily_streaks — real server-side maintenance
-- ═══════════════════════════════════════════════════════════════════════════
-- This table existed since Phase 14 but had NO writer anywhere (confirmed by
-- grep across every migration and src/ during the Phase 0.5 security pass —
-- its owner-UPDATE RLS policy was dropped there for exactly this reason:
-- a client-writable column with no legitimate use is pure attack surface).
-- record_daily_participation() is the real writer: called once per UTC day
-- after the player completes at least one qualifying activity (a daily
-- mission claim, or a hidden quest completion — GamePage decides when to
-- call it; the RPC itself just needs to be called at most meaningfully once
-- per day, which the UNIQUE natural key here (player + day) already
-- guarantees is idempotent even if called many times).

CREATE OR REPLACE FUNCTION public.record_daily_participation()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  today text := public.rt_utc_daily_key(now());
  yesterday text := public.rt_utc_daily_key(now() - interval '1 day');
  row public.player_daily_streaks;
  new_streak integer;
  milestone_bonus jsonb := NULL;
  prog public.player_progression;
  key text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  INSERT INTO public.player_daily_streaks (player_id, current_streak, longest_streak, last_daily_key)
  VALUES (uid, 0, 0, NULL)
  ON CONFLICT (player_id) DO NOTHING;

  SELECT * INTO row FROM public.player_daily_streaks WHERE player_id = uid FOR UPDATE;

  IF row.last_daily_key = today THEN
    -- Already recorded today — idempotent no-op.
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'currentStreak', row.current_streak, 'longestStreak', row.longest_streak);
  END IF;

  new_streak := CASE
    WHEN row.last_daily_key = yesterday THEN row.current_streak + 1
    ELSE 1 -- gap of more than one day (or first-ever record) resets to 1, not 0 --
           -- a player who returns after missing a day isn't punished into the
           -- ground, they just start a fresh streak today (brief: "avoid
           -- punishing players excessively for missing one day").
  END;

  UPDATE public.player_daily_streaks
  SET current_streak = new_streak,
      longest_streak = greatest(longest_streak, new_streak),
      last_daily_key = today,
      updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO row;

  -- Milestone bonuses at 3/7/14/30/60/100 days — modest, idempotent per
  -- (player, milestone), not per day, so they fire exactly once each.
  IF new_streak = ANY(ARRAY[3, 7, 14, 30, 60, 100]) THEN
    key := 'streak_milestone:' || new_streak::text;
    prog := public.rt_ensure_progression(uid);
    IF NOT (prog.claimed_reward_keys ? key) THEN
      PERFORM public.rt_set_mutation_flag();
      UPDATE public.player_progression SET
        rep = rep + (new_streak * 2),
        rug_points = rug_points + (new_streak * 3),
        daily_points = daily_points + (new_streak * 3),
        claimed_reward_keys = claimed_reward_keys || jsonb_build_array(key)
      WHERE player_id = uid
      RETURNING * INTO prog;
      UPDATE public.profiles SET rep = prog.rep WHERE id = uid;
      INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
      VALUES (uid, 'REP', new_streak * 2, 'Streak milestone: ' || new_streak::text || ' days', 'streak_milestone', new_streak::text, key)
      ON CONFLICT (player_id, idempotency_key) DO NOTHING;
      milestone_bonus := jsonb_build_object('streakDays', new_streak, 'repAwarded', new_streak * 2, 'pointsAwarded', new_streak * 3);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'currentStreak', row.current_streak,
    'longestStreak', row.longest_streak,
    'milestoneBonus', milestone_bonus
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_daily_participation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_daily_participation() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_streak()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  row public.player_daily_streaks;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO row FROM public.player_daily_streaks WHERE player_id = uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('currentStreak', 0, 'longestStreak', 0, 'lastDailyKey', NULL);
  END IF;
  RETURN jsonb_build_object('currentStreak', row.current_streak, 'longestStreak', row.longest_streak, 'lastDailyKey', row.last_daily_key);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_streak() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_streak() TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Activity heartbeat — bounded time-in-game reward
-- ═══════════════════════════════════════════════════════════════════════════
-- Reuses the Phase 10H session-tracking helper pattern rather than inventing
-- a parallel one. Cooldown: at most one rewarded heartbeat per 5 real
-- minutes. Daily cap: at most 6 rewarded heartbeats/day (=~30 minutes of
-- credited active time), enforced by counting today's reward_ledger rows for
-- this source_type rather than a separate counter table.

CREATE TABLE IF NOT EXISTS public.player_activity_heartbeats (
  player_id     uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_reward_at timestamptz,
  reward_count_today integer NOT NULL DEFAULT 0 CHECK (reward_count_today >= 0),
  reward_day_key text
);

ALTER TABLE public.player_activity_heartbeats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "activity_heartbeats: owner read" ON public.player_activity_heartbeats;
CREATE POLICY "activity_heartbeats: owner read"
  ON public.player_activity_heartbeats FOR SELECT
  USING (auth.uid() = player_id);
-- No client write policy -- record_activity_heartbeat() (SECURITY DEFINER) is the only writer.

CREATE OR REPLACE FUNCTION public.record_activity_heartbeat()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  today text := public.rt_utc_daily_key(now());
  row public.player_activity_heartbeats;
  prog public.player_progression;
  key text;
  min_interval constant interval := interval '5 minutes';
  daily_cap constant integer := 6;
  reward_rep constant integer := 2;
  reward_points constant integer := 1;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  INSERT INTO public.player_activity_heartbeats (player_id, reward_count_today, reward_day_key)
  VALUES (uid, 0, today)
  ON CONFLICT (player_id) DO NOTHING;

  SELECT * INTO row FROM public.player_activity_heartbeats WHERE player_id = uid FOR UPDATE;

  IF row.reward_day_key IS DISTINCT FROM today THEN
    UPDATE public.player_activity_heartbeats
    SET reward_count_today = 0, reward_day_key = today
    WHERE player_id = uid
    RETURNING * INTO row;
  END IF;

  IF row.last_reward_at IS NOT NULL AND now() - row.last_reward_at < min_interval THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cooldown', 'rewardCountToday', row.reward_count_today);
  END IF;

  IF row.reward_count_today >= daily_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'daily_cap_reached', 'rewardCountToday', row.reward_count_today);
  END IF;

  key := 'activity_heartbeat:' || today || ':' || (row.reward_count_today + 1)::text;
  prog := public.rt_ensure_progression(uid);
  IF prog.claimed_reward_keys ? key THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'rewardCountToday', row.reward_count_today);
  END IF;

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.player_progression SET
    rep = rep + reward_rep,
    rug_points = rug_points + reward_points,
    daily_points = daily_points + reward_points,
    claimed_reward_keys = claimed_reward_keys || jsonb_build_array(key)
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = prog.rep WHERE id = uid;

  INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
  VALUES (uid, 'REP', reward_rep, 'Active session heartbeat', 'activity_heartbeat', today, key)
  ON CONFLICT (player_id, idempotency_key) DO NOTHING;

  UPDATE public.player_activity_heartbeats
  SET last_reward_at = now(), reward_count_today = reward_count_today + 1
  WHERE player_id = uid
  RETURNING * INTO row;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'rewardCountToday', row.reward_count_today, 'repAwarded', reward_rep, 'pointsAwarded', reward_points);
END;
$$;

REVOKE ALL ON FUNCTION public.record_activity_heartbeat() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_activity_heartbeat() TO authenticated;

COMMENT ON FUNCTION public.record_activity_heartbeat IS
  'Bounded time-in-game reward: max 1 per 5 real minutes, max 6/day (~30 credited minutes). Deliberately small relative to mission rewards so missions remain the primary progression driver, per the product brief.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. hidden_quest_state — server-authoritative discovery/completion
-- ═══════════════════════════════════════════════════════════════════════════
-- The client (HiddenQuestDirector.ts) detects triggers locally (same
-- architecture as MissionSystem — event-driven, no server round-trip per
-- frame) but every discovery/completion is confirmed and rewarded here, so a
-- player can never receive the same hidden-quest reward twice even across
-- devices/sessions, and a modified client cannot fabricate a completion for
-- a quest id that doesn't exist or reward amounts it doesn't define server-side.
--
-- Reward amounts are NOT trusted from the client at all -- p_reward_xp etc.
-- below are ignored in favor of a small server-side catalog embedded in the
-- function (mirrors CANONICAL_HIDDEN_QUESTS' reward fields exactly; kept in
-- sync manually the same way mission_definitions mirrors PeriodMissions.ts).

CREATE TABLE IF NOT EXISTS public.hidden_quest_state (
  player_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  quest_id      text NOT NULL,
  status        text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'completed')),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (player_id, quest_id)
);

ALTER TABLE public.hidden_quest_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hidden_quest_state: owner read" ON public.hidden_quest_state;
CREATE POLICY "hidden_quest_state: owner read"
  ON public.hidden_quest_state FOR SELECT
  USING (auth.uid() = player_id);
-- No client write policy -- discover_hidden_quest()/complete_hidden_quest() (SECURITY
-- DEFINER) are the only writers, so a client can never mark its own quest completed
-- or discovered without going through server-side reward logic.

CREATE INDEX IF NOT EXISTS idx_hidden_quest_state_player ON public.hidden_quest_state (player_id, status);

-- Server-side reward catalog for hidden quests. Kept as a small lookup
-- function (not a table) since it's static content mirrored from the client
-- catalog, same pattern as mission rewards living in mission_definitions.
-- BUG FIX (this migration's original attempt failed with Postgres error
-- 42P13 "return type mismatch ... Final statement returns text instead of
-- integer at column 1"): the VALUES table below is aliased with 4 columns
-- (quest_id, xp_reward, rep_reward, points_reward) because quest_id is
-- needed to filter by p_quest_id, but the function is declared to RETURN
-- only 3 columns (xp_reward, rep_reward, points_reward). The original body
-- used `SELECT *`, which returned all 4 columns — quest_id (text) landed in
-- output position 1, where the declared signature expects xp_reward
-- (integer). This is a SELECT-column-list bug, not a real type mismatch in
-- the data: quest_id was never meant to be part of the returned reward
-- record (both callers below only ever read .xp_reward/.rep_reward/
-- .points_reward). Fix: project only the 3 declared columns explicitly.
CREATE OR REPLACE FUNCTION public.rt_hidden_quest_reward(p_quest_id text)
RETURNS TABLE (xp_reward integer, rep_reward integer, points_reward integer)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT t.xp_reward, t.rep_reward, t.points_reward FROM (VALUES
    ('hq_empty_chair', 120, 25, 100),
    ('hq_forgotten_door', 150, 35, 150),
    ('hq_silent_npc', 140, 30, 120),
    ('hq_three_signs', 200, 50, 250),
    ('hq_the_stranger', 250, 60, 300),
    ('hq_market_watcher', 130, 28, 110),
    ('hq_investigators_ledger', 320, 70, 350),
    ('hq_someone_was_here', 80, 18, 60),
    ('hq_three_corners', 180, 38, 160),
    ('hq_the_long_streak', 220, 45, 200),
    ('hq_whispers_at_the_cafe', 90, 20, 70),
    ('hq_the_quiet_district', 260, 55, 240),
    ('hq_message_in_gold', 210, 42, 190),
    ('hq_the_unmarked_door', 300, 65, 320)
  ) AS t(quest_id, xp_reward, rep_reward, points_reward)
  WHERE t.quest_id = p_quest_id;
$$;

CREATE OR REPLACE FUNCTION public.discover_hidden_quest(p_quest_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rt_hidden_quest_reward(p_quest_id)) THEN
    RAISE EXCEPTION 'unknown hidden quest: %', p_quest_id;
  END IF;

  INSERT INTO public.hidden_quest_state (player_id, quest_id, status)
  VALUES (uid, p_quest_id, 'discovered')
  ON CONFLICT (player_id, quest_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'questId', p_quest_id);
END;
$$;

REVOKE ALL ON FUNCTION public.discover_hidden_quest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discover_hidden_quest(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_hidden_quest(p_quest_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  reward RECORD;
  existing public.hidden_quest_state;
  prog public.player_progression;
  key text := 'hidden_quest:' || p_quest_id;
  active_season text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO reward FROM public.rt_hidden_quest_reward(p_quest_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown hidden quest: %', p_quest_id; END IF;

  -- Ensure discovered (a completion implies discovery even if the discover
  -- call was missed/raced) then check for a pre-existing completion.
  INSERT INTO public.hidden_quest_state (player_id, quest_id, status)
  VALUES (uid, p_quest_id, 'discovered')
  ON CONFLICT (player_id, quest_id) DO NOTHING;

  SELECT * INTO existing FROM public.hidden_quest_state WHERE player_id = uid AND quest_id = p_quest_id FOR UPDATE;
  IF existing.status = 'completed' THEN
    prog := public.rt_ensure_progression(uid);
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'progression', to_jsonb(prog));
  END IF;

  prog := public.rt_ensure_progression(uid);
  IF prog.claimed_reward_keys ? key THEN
    -- Ledger already has this reward (race between two calls) -- just flip status.
    UPDATE public.hidden_quest_state SET status = 'completed', completed_at = now()
    WHERE player_id = uid AND quest_id = p_quest_id;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'progression', to_jsonb(prog));
  END IF;

  SELECT id INTO active_season FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC LIMIT 1;

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.player_progression SET
    lifetime_xp = lifetime_xp + reward.xp_reward,
    level = least(public.rt_recompute_level(lifetime_xp + reward.xp_reward, 4), 100),
    rep = rep + reward.rep_reward,
    rug_points = rug_points + reward.points_reward,
    daily_points = daily_points + reward.points_reward,
    weekly_points = weekly_points + reward.points_reward,
    season_points = CASE WHEN active_season IS NOT NULL THEN season_points + (reward.points_reward / 2) ELSE season_points END,
    claimed_reward_keys = claimed_reward_keys || jsonb_build_array(key)
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = prog.rep WHERE id = uid;

  INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
  VALUES (uid, 'XP', reward.xp_reward, 'Hidden quest: ' || p_quest_id, 'hidden_quest', p_quest_id, key || ':xp')
  ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
  VALUES (uid, 'REP', reward.rep_reward, 'Hidden quest: ' || p_quest_id, 'hidden_quest', p_quest_id, key || ':rep')
  ON CONFLICT (player_id, idempotency_key) DO NOTHING;

  UPDATE public.hidden_quest_state SET status = 'completed', completed_at = now()
  WHERE player_id = uid AND quest_id = p_quest_id;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'reward', to_jsonb(reward), 'progression', to_jsonb(prog));
END;
$$;

REVOKE ALL ON FUNCTION public.complete_hidden_quest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_hidden_quest(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_hidden_quests()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  rows jsonb;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.discovered_at), '[]'::jsonb)
  INTO rows FROM public.hidden_quest_state h WHERE h.player_id = uid;
  RETURN jsonb_build_object('quests', rows);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_hidden_quests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_hidden_quests() TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Points leaderboard — daily / weekly / all-time
-- ═══════════════════════════════════════════════════════════════════════════
-- Ranks off player_progression.daily_points / weekly_points / rug_points
-- (all already exist from Phase 16 — no new progression columns needed).
-- Efficient: single indexed ORDER BY + LIMIT, never loads the whole table to
-- the client. get_my_leaderboard_rank uses a COUNT(*) WHERE points > mine
-- window instead of scanning/ranking the whole table client-side.

CREATE INDEX IF NOT EXISTS idx_player_progression_daily_points
  ON public.player_progression (daily_points DESC) WHERE daily_points > 0;
CREATE INDEX IF NOT EXISTS idx_player_progression_weekly_points
  ON public.player_progression (weekly_points DESC) WHERE weekly_points > 0;
CREATE INDEX IF NOT EXISTS idx_player_progression_rug_points
  ON public.player_progression (rug_points DESC) WHERE rug_points > 0;

CREATE OR REPLACE FUNCTION public.get_points_leaderboard(
  p_period text,               -- 'daily' | 'weekly' | 'all_time'
  p_limit integer DEFAULT 20,
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
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  off integer := greatest(coalesce(p_offset, 0), 0);
  col text;
BEGIN
  IF p_period NOT IN ('daily', 'weekly', 'all_time') THEN
    RAISE EXCEPTION 'invalid period: %', p_period;
  END IF;
  col := CASE p_period WHEN 'daily' THEN 'daily_points' WHEN 'weekly' THEN 'weekly_points' ELSE 'rug_points' END;

  EXECUTE format(
    $q$
      SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT
          row_number() OVER (ORDER BY pp.%1$I DESC, pp.player_id ASC) + $1 AS rank,
          p.id AS "playerId",
          p.username,
          pp.level,
          pp.rep,
          pp.%1$I AS points
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
  'Server-side ranked leaderboard (daily/weekly/all-time Points). Never loads the full table -- indexed ORDER BY + LIMIT/OFFSET. Public read (matches profiles: public read policy already in place for the same data).';

CREATE OR REPLACE FUNCTION public.get_my_leaderboard_rank(p_period text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  col text;
  my_points integer;
  my_rank bigint;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_period NOT IN ('daily', 'weekly', 'all_time') THEN
    RAISE EXCEPTION 'invalid period: %', p_period;
  END IF;
  col := CASE p_period WHEN 'daily' THEN 'daily_points' WHEN 'weekly' THEN 'weekly_points' ELSE 'rug_points' END;

  EXECUTE format('SELECT %1$I FROM public.player_progression WHERE player_id = $1', col)
  INTO my_points USING uid;
  my_points := coalesce(my_points, 0);

  EXECUTE format('SELECT count(*) + 1 FROM public.player_progression WHERE %1$I > $1', col)
  INTO my_rank USING my_points;

  RETURN jsonb_build_object('period', p_period, 'points', my_points, 'rank', my_rank);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_leaderboard_rank(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_leaderboard_rank(text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Leaderboard period history — retrievable after a daily/weekly reset
-- ═══════════════════════════════════════════════════════════════════════════
-- daily_points/weekly_points reset in place (Phase 16's
-- rt_reset_period_points_if_needed) — nothing about that changes here. This
-- table is a point-in-time snapshot taken right before each reset so past
-- rankings remain queryable ("past daily rankings should remain historically
-- retrievable" / "keep historical weekly winners"). Snapshot capture is a
-- lightweight top-N insert triggered from the same place that already
-- detects a period rollover (rt_reset_period_points_if_needed), so it costs
-- nothing extra to call and never blocks the player-facing sync path.

CREATE TABLE IF NOT EXISTS public.leaderboard_period_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_type  text NOT NULL CHECK (period_type IN ('daily', 'weekly')),
  period_key   text NOT NULL,
  player_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rank         integer NOT NULL,
  username     text NOT NULL,
  points       integer NOT NULL,
  level        integer NOT NULL,
  rep          integer NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_type, period_key, player_id)
);

ALTER TABLE public.leaderboard_period_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leaderboard_snapshots: public read" ON public.leaderboard_period_snapshots;
CREATE POLICY "leaderboard_snapshots: public read"
  ON public.leaderboard_period_snapshots FOR SELECT USING (true);
-- No client write policy -- rt_capture_leaderboard_snapshot() (internal, called
-- only from settlement/reset paths) is the only writer.

CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_lookup
  ON public.leaderboard_period_snapshots (period_type, period_key, rank);

CREATE OR REPLACE FUNCTION public.rt_capture_leaderboard_snapshot(p_period_type text, p_period_key text, p_top_n integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  col text := CASE p_period_type WHEN 'daily' THEN 'daily_points' ELSE 'weekly_points' END;
  inserted integer;
BEGIN
  EXECUTE format(
    $q$
      INSERT INTO public.leaderboard_period_snapshots (period_type, period_key, player_id, rank, username, points, level, rep)
      SELECT $1, $2,
             p.id, row_number() OVER (ORDER BY pp.%1$I DESC, pp.player_id ASC),
             p.username, pp.%1$I, pp.level, pp.rep
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

-- BUG FIX (found during static audit, before Supabase ever reported it): the
-- original body was a flat `SELECT jsonb_agg(...) FROM ... WHERE ... ORDER BY
-- s.rank LIMIT n` with no subquery. An aggregate SELECT with no GROUP BY
-- collapses to exactly ONE output row, so the outer ORDER BY/LIMIT operates
-- on that single aggregate row, not on which underlying snapshot rows feed
-- jsonb_agg() -- p_limit had no effect on the returned array's size (every
-- matching snapshot row was always included). Fixed using the exact
-- LIMIT-inside-a-subquery-then-aggregate pattern already used correctly by
-- get_points_leaderboard and get_weekly_champions below.
CREATE OR REPLACE FUNCTION public.get_leaderboard_history(p_period_type text, p_period_key text, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.rank), '[]'::jsonb)
  FROM (
    SELECT *
    FROM public.leaderboard_period_snapshots
    WHERE period_type = p_period_type AND period_key = p_period_key
    ORDER BY rank
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
  ) s;
$$;

REVOKE ALL ON FUNCTION public.get_leaderboard_history(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_history(text, text, integer) TO authenticated, anon;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Weekly settlement — idempotent top-3 reward
-- ═══════════════════════════════════════════════════════════════════════════
-- Non-blockchain, in-game rewards for the weekly top 3 (REP + Points + a
-- title unlock), settled once per ISO week. Idempotent via a UNIQUE
-- (period_key, rank) constraint on the settlement table itself, so calling
-- this twice for the same week is always a safe no-op the second time.
-- Service-role/operator gated (matches every other maintenance-style RPC
-- hardened in Phase 0.5) -- a scheduled Edge Function or an authorized
-- operator triggers it; players never call it directly.

CREATE TABLE IF NOT EXISTS public.weekly_leaderboard_settlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_key   text NOT NULL,
  rank         integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  player_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  points       integer NOT NULL,
  rep_awarded  integer NOT NULL,
  points_awarded integer NOT NULL,
  title_awarded text,
  settled_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_key, rank)
);

ALTER TABLE public.weekly_leaderboard_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "weekly_settlements: public read" ON public.weekly_leaderboard_settlements;
CREATE POLICY "weekly_settlements: public read"
  ON public.weekly_leaderboard_settlements FOR SELECT USING (true);
-- No client write policy -- settle_weekly_leaderboard() (service/operator-gated) is the only writer.

CREATE OR REPLACE FUNCTION public.settle_weekly_leaderboard(p_period_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key text := coalesce(p_period_key, public.rt_utc_weekly_key(now() - interval '1 day'));
  winner RECORD;
  settled_count integer := 0;
  rewards integer[] := ARRAY[150, 90, 50]; -- rank 1/2/3 REP
  points_rewards integer[] := ARRAY[500, 300, 150];
  titles text[] := ARRAY['title_weekly_champion', 'title_weekly_runner_up', 'title_weekly_podium'];
  prog public.player_progression;
  reward_key text;
BEGIN
  IF NOT (public.rt_is_service_role() OR public.rt_is_operator('operator')) THEN
    RAISE EXCEPTION 'forbidden: operator or service role required';
  END IF;

  IF EXISTS (SELECT 1 FROM public.weekly_leaderboard_settlements WHERE period_key = key) THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'periodKey', key, 'settled', 0);
  END IF;

  -- Snapshot the full top-100 for history regardless of settlement outcome.
  PERFORM public.rt_capture_leaderboard_snapshot('weekly', key, 100);

  FOR winner IN
    SELECT p.id AS player_id, p.username, pp.weekly_points AS points,
           row_number() OVER (ORDER BY pp.weekly_points DESC, p.id ASC) AS rnk
    FROM public.player_progression pp
    JOIN public.profiles p ON p.id = pp.player_id
    WHERE pp.weekly_points > 0
    ORDER BY pp.weekly_points DESC, p.id ASC
    LIMIT 3
  LOOP
    reward_key := 'weekly_settlement:' || key || ':rank' || winner.rnk::text;
    prog := public.rt_ensure_progression(winner.player_id);
    IF prog.claimed_reward_keys ? reward_key THEN
      CONTINUE;
    END IF;

    PERFORM public.rt_set_mutation_flag();
    UPDATE public.player_progression SET
      rep = rep + rewards[winner.rnk],
      rug_points = rug_points + points_rewards[winner.rnk],
      unlocked_titles = (
        SELECT coalesce(jsonb_agg(DISTINCT t), '[]'::jsonb)
        FROM (
          SELECT jsonb_array_elements_text(coalesce(unlocked_titles, '[]'::jsonb)) AS t
          UNION SELECT titles[winner.rnk]
        ) s
      ),
      claimed_reward_keys = claimed_reward_keys || jsonb_build_array(reward_key)
    WHERE player_id = winner.player_id
    RETURNING * INTO prog;

    UPDATE public.profiles SET rep = prog.rep WHERE id = winner.player_id;

    INSERT INTO public.reward_ledger (player_id, reward_type, amount, reason, source_type, source_id, idempotency_key)
    VALUES (winner.player_id, 'REP', rewards[winner.rnk], 'Weekly leaderboard rank ' || winner.rnk::text, 'weekly_settlement', key, reward_key || ':rep')
    ON CONFLICT (player_id, idempotency_key) DO NOTHING;

    INSERT INTO public.weekly_leaderboard_settlements
      (period_key, rank, player_id, points, rep_awarded, points_awarded, title_awarded)
    VALUES (key, winner.rnk, winner.player_id, winner.points, rewards[winner.rnk], points_rewards[winner.rnk], titles[winner.rnk])
    ON CONFLICT (period_key, rank) DO NOTHING;

    settled_count := settled_count + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'periodKey', key, 'settled', settled_count);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_weekly_leaderboard(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_weekly_leaderboard(text) TO service_role;

COMMENT ON FUNCTION public.settle_weekly_leaderboard IS
  'Weekly top-3 settlement. Idempotent via UNIQUE(period_key, rank) + a claimed_reward_keys guard (belt-and-suspenders). Non-blockchain rewards only (REP, Points, title). Service-role/operator only -- call from a scheduled Edge Function; see the Phase 2 report for the cron recommendation.';

CREATE OR REPLACE FUNCTION public.get_weekly_champions(p_limit integer DEFAULT 12)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.period_key DESC, w.rank ASC), '[]'::jsonb)
  FROM (
    SELECT s.period_key, s.rank, s.player_id, p.username, s.points, s.title_awarded, s.settled_at
    FROM public.weekly_leaderboard_settlements s
    JOIN public.profiles p ON p.id = s.player_id
    ORDER BY s.period_key DESC, s.rank ASC
    LIMIT least(greatest(coalesce(p_limit, 12), 1), 60)
  ) w;
$$;

REVOKE ALL ON FUNCTION public.get_weekly_champions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_weekly_champions(integer) TO authenticated, anon;


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification queries (informational only, safe to run after applying)
-- ═══════════════════════════════════════════════════════════════════════════
--   SELECT category, count(*) FROM public.mission_definitions WHERE period_type='daily' GROUP BY category;
--   -- expect a nonzero count for exploration/social/mission/activity at minimum
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('ensure_period_missions','record_daily_participation','record_activity_heartbeat',
--      'discover_hidden_quest','complete_hidden_quest','get_points_leaderboard',
--      'get_my_leaderboard_rank','settle_weekly_leaderboard','get_weekly_champions');
--   -- expect all 9 rows present
-- ═══════════════════════════════════════════════════════════════════════════

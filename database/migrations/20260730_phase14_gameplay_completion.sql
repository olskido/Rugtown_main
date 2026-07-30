-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 14 — Gameplay completion: chapter rewards refresh, XP curve v3,
-- expanded daily/weekly catalogs, streak/receipt tracking tables, party missions.
--
-- Apply AFTER Phase 13 (chapter missions, curve v2). Additive only — no DROP of
-- user data. Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- GENERATED FOR MANUAL REVIEW — not applied remotely by this repository.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Chapter One catalog — updated rewards/titles (same chain order) ─────
CREATE OR REPLACE FUNCTION public.rt_chapter_one_catalog(p_mission_id text DEFAULT NULL)
RETURNS TABLE (
  mission_id text,
  mission_order integer,
  xp_reward integer,
  rep_reward integer,
  next_mission_id text,
  title text
)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT *
  FROM (VALUES
    ('ch1_new_face',               1,  15,  2, 'ch1_water_before_rumours', 'Welcome to RugTown'),
    ('ch1_water_before_rumours',   2,  20,  3, 'ch1_empty_cart',           'Meet the Guide'),
    ('ch1_empty_cart',             3,  25,  4, 'ch1_milo_heard',           'Find Your Look'),
    ('ch1_milo_heard',             4,  25,  4, 'ch1_notice_never_posted',  'The Notice Board'),
    ('ch1_notice_never_posted',    5,  30,  5, 'ch1_proof_not_panic',      'Coffee and Conversation'),
    ('ch1_proof_not_panic',        6,  30,  5, 'ch1_patterns_in_ink',      'Market Watch'),
    ('ch1_patterns_in_ink',        7,  35,  6, 'ch1_bridge_keeps_count',   'Say Hello'),
    ('ch1_bridge_keeps_count',     8,  40,  7, 'ch1_whales_shadow',        'Rumours in the City'),
    ('ch1_whales_shadow',          9,  40,  7, 'ch1_missing_ledger',       'Form a Crew'),
    ('ch1_missing_ledger',        10,  60, 12, NULL,                       'Citizen of RugTown')
  ) AS v(mission_id, mission_order, xp_reward, rep_reward, next_mission_id, title)
  WHERE p_mission_id IS NULL OR v.mission_id = p_mission_id;
$$;

COMMENT ON FUNCTION public.rt_chapter_one_catalog(text) IS
  'Chapter One mission chain — Phase 14 reward/title refresh. mission_id and unlock order unchanged.';

-- ─── 2. XP curve v3 (match src/game/progression/XpCurve.ts) ─────────────────
CREATE OR REPLACE FUNCTION public.rt_xp_required_for_level_v3(p_level integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(p_level, 1) >= 50 THEN 0
    ELSE round(
      200
      + 50 * (greatest(coalesce(p_level, 1), 1) - 1)
      + 5 * (greatest(coalesce(p_level, 1), 1) - 1)
          * (greatest(coalesce(p_level, 1), 1) - 1)
    )::integer
  END;
$$;

CREATE OR REPLACE FUNCTION public.rt_recompute_level_v3(p_xp bigint)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  lvl integer := 1;
  spent bigint := 0;
  need integer;
  xp bigint := greatest(coalesce(p_xp, 0), 0);
BEGIN
  WHILE lvl < 50 LOOP
    need := public.rt_xp_required_for_level_v3(lvl);
    IF spent + need > xp THEN
      EXIT;
    END IF;
    spent := spent + need;
    lvl := lvl + 1;
  END LOOP;
  RETURN lvl;
END;
$$;

COMMENT ON COLUMN public.player_progression.progression_curve_version IS
  '1 = legacy, 2 = Chapter One curve (120+27n+3n²), 3 = gameplay completion (200+50n+5n²).';

-- Dispatcher: award paths pass the player''s progression_curve_version.
CREATE OR REPLACE FUNCTION public.rt_recompute_level(p_xp bigint, p_curve_version integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(p_curve_version, 2) >= 3 THEN public.rt_recompute_level_v3(p_xp)
    WHEN coalesce(p_curve_version, 2) >= 2 THEN public.rt_recompute_level_v2(p_xp)
    ELSE public.rt_recompute_level_v2(p_xp)
  END;
$$;

-- Single-arg convenience (defaults to v3 for new tooling / diagnostics).
CREATE OR REPLACE FUNCTION public.rt_recompute_level(p_xp bigint)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.rt_recompute_level(p_xp, 3);
$$;

COMMENT ON FUNCTION public.rt_recompute_level(bigint, integer) IS
  'Derives player level from lifetime XP using curve v2 or v3 based on progression_curve_version.';

-- Per-player migration RPC (grandfather level upward).
CREATE OR REPLACE FUNCTION public.migrate_progression_curve_v3()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  prog public.player_progression;
  computed integer;
  merged integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  prog := public.rt_ensure_progression(uid);
  IF prog.progression_curve_version >= 3 THEN
    RETURN jsonb_build_object('migrated', false, 'already', true, 'progression', to_jsonb(prog));
  END IF;

  computed := public.rt_recompute_level_v3(prog.lifetime_xp);
  merged := greatest(prog.level, computed);

  PERFORM public.rt_set_mutation_flag();
  UPDATE public.player_progression
  SET level = merged,
      progression_curve_version = 3,
      updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  RETURN jsonb_build_object(
    'migrated', true,
    'computedLevel', computed,
    'grandfatheredLevel', merged,
    'progression', to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_progression_curve_v3() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_progression_curve_v3() TO authenticated;

-- One-time backfill (idempotent).
UPDATE public.player_progression
SET level = greatest(level, public.rt_recompute_level_v3(lifetime_xp)),
    progression_curve_version = 3,
    updated_at = now()
WHERE progression_curve_version < 3;

-- ─── 3. Expanded daily (21) and weekly (15) mission_definitions ─────────────
INSERT INTO public.mission_definitions (
  id, period_type, title, description, objective_type, target, objective_ref,
  xp_reward, rep_reward, season_points, rug_points, difficulty, active
) VALUES
  ('daily_visit_spring', 'daily', 'Spring Visit', 'Interact with Spring Water.', 'visit_landmark', 1, 'fountain', 28, 4, 6, 8, 'easy', true),
  ('daily_visit_bridge', 'daily', 'Bridge Walk', 'Visit the Main Bridge.', 'visit_landmark', 1, 'bridge', 28, 4, 6, 8, 'easy', true),
  ('daily_three_landmarks', 'daily', 'Three Stops', 'Discover 3 landmarks today.', 'discover_landmarks', 3, NULL, 40, 6, 10, 12, 'medium', true),
  ('daily_enter_interior', 'daily', 'Step Inside', 'Enter any open interior.', 'enter_interior', 1, NULL, 32, 4, 8, 10, 'easy', true),
  ('daily_meet_player', 'daily', 'City Hello', 'Meet one unique real player (NPC fallback when alone).', 'meet_player', 1, NULL, 36, 5, 10, 12, 'medium', true),
  ('daily_wave', 'daily', 'Friendly Wave', 'Wave or emote at someone.', 'wave_player', 1, NULL, 22, 2, 5, 6, 'easy', true),
  ('daily_city_event', 'daily', 'Event Curious', 'Join one city event.', 'join_event', 1, NULL, 38, 5, 10, 12, 'medium', true),
  ('daily_two_districts', 'daily', 'District Hop', 'Visit 2 districts.', 'visit_districts', 2, NULL, 34, 5, 8, 10, 'easy', true),
  ('daily_notice_board', 'daily', 'Check the Board', 'Interact with the Notice Board.', 'visit_landmark', 1, 'notice', 26, 3, 6, 8, 'easy', true),
  ('daily_coffee', 'daily', 'Coffee Run', 'Visit the Coffee Shop.', 'visit_landmark', 1, 'coffee', 26, 3, 6, 8, 'easy', true),
  ('daily_meme_market', 'daily', 'Market Peek', 'Visit Meme Market.', 'visit_landmark', 1, 'market', 28, 4, 6, 8, 'easy', true),
  ('daily_hall_fame', 'daily', 'Hall Walk', 'Visit Hall of Fame.', 'visit_landmark', 1, 'fame', 28, 4, 6, 8, 'easy', true),
  ('daily_alpha', 'daily', 'Lounge Drop-In', 'Visit Alpha Lounge.', 'visit_landmark', 1, 'alpha', 30, 4, 7, 9, 'easy', true),
  ('daily_talk_npcs', 'daily', 'Street Talk', 'Talk to 4 citizens or guides.', 'meet_players', 4, NULL, 36, 5, 9, 11, 'medium', true),
  ('daily_join_party', 'daily', 'Find a Crew', 'Open party panel / join a party action.', 'complete_missions', 1, 'party_action', 34, 5, 9, 11, 'medium', true),
  ('daily_whale', 'daily', 'Whale Watch', 'Visit Whale Tower.', 'visit_landmark', 1, 'whale', 28, 4, 6, 8, 'easy', true),
  ('daily_government', 'daily', 'Civic Stop', 'Visit Government Quarter.', 'visit_landmark', 1, 'government', 26, 3, 6, 8, 'easy', true),
  ('daily_academy', 'daily', 'Study Hall', 'Visit Trading Academy.', 'visit_landmark', 1, 'trading_academy', 26, 3, 6, 8, 'easy', true),
  ('daily_park', 'daily', 'Park Air', 'Visit the Park Entrance.', 'visit_landmark', 1, 'park', 24, 3, 5, 7, 'easy', true),
  ('daily_complete_one', 'daily', 'One More Mission', 'Complete any other mission today.', 'complete_missions', 1, NULL, 40, 6, 10, 12, 'medium', true),
  ('daily_random_landmark', 'daily', 'Landmark of the Day', 'Interact with Observatory or Financial Office.', 'discover_landmarks', 1, 'research_observatory', 30, 4, 7, 9, 'easy', true),
  ('weekly_ten_missions', 'weekly', 'Mission Week', 'Complete 10 missions this week.', 'complete_missions', 10, NULL, 120, 20, 40, 50, 'hard', true),
  ('weekly_five_players', 'weekly', 'Social Circuit', 'Meet 5 unique real players.', 'meet_players', 5, NULL, 110, 16, 35, 45, 'hard', true),
  ('weekly_all_districts', 'weekly', 'Full Tour', 'Visit all five districts.', 'visit_districts', 5, NULL, 130, 20, 45, 55, 'hard', true),
  ('weekly_three_events', 'weekly', 'Event Regular', 'Join 3 city events.', 'join_events', 3, NULL, 100, 16, 32, 40, 'medium', true),
  ('weekly_five_interiors', 'weekly', 'Door Opener', 'Enter 5 different interiors.', 'enter_interiors', 5, NULL, 110, 16, 35, 45, 'medium', true),
  ('weekly_ten_dailies', 'weekly', 'Daily Grind', 'Complete 10 daily quests.', 'complete_missions', 10, 'daily', 140, 22, 50, 60, 'hard', true),
  ('weekly_five_city_events', 'weekly', 'Event Circuit', 'Complete 5 city events.', 'join_events', 5, NULL, 125, 18, 40, 50, 'hard', true),
  ('weekly_twelve_buildings', 'weekly', 'Building Tour', 'Interact with 12 distinct buildings.', 'discover_landmarks', 12, NULL, 135, 20, 45, 55, 'hard', true),
  ('weekly_twenty_npcs', 'weekly', 'Citizen Network', 'Talk to 20 NPCs.', 'meet_players', 20, NULL, 120, 18, 38, 48, 'hard', true),
  ('weekly_eight_missions', 'weekly', 'Quest Stack', 'Complete 8 story or onboarding missions.', 'complete_missions', 8, NULL, 130, 20, 42, 52, 'hard', true),
  ('weekly_party_three', 'weekly', 'Crew Week', 'Complete 3 party actions.', 'complete_missions', 3, 'party', 115, 18, 36, 46, 'medium', true),
  ('weekly_emote_variety', 'weekly', 'Express Yourself', 'Use emotes 8 times.', 'wave_player', 8, NULL, 90, 12, 28, 35, 'medium', true),
  ('weekly_market_events', 'weekly', 'Market Pulse', 'Join 2 market-linked events.', 'join_events', 2, 'market', 100, 15, 30, 40, 'medium', true),
  ('weekly_hard_challenge', 'weekly', 'City Challenge', 'Complete a hard story stage.', 'complete_missions', 1, 'story_hard', 150, 24, 55, 65, 'hard', true),
  ('weekly_exploration_landmarks', 'weekly', 'Explorer Chest', 'Visit every major district landmark list (8+).', 'discover_landmarks', 8, NULL, 140, 22, 48, 58, 'hard', true)
ON CONFLICT (id) DO UPDATE SET
  period_type = EXCLUDED.period_type,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  objective_type = EXCLUDED.objective_type,
  target = EXCLUDED.target,
  objective_ref = EXCLUDED.objective_ref,
  xp_reward = EXCLUDED.xp_reward,
  rep_reward = EXCLUDED.rep_reward,
  season_points = EXCLUDED.season_points,
  rug_points = EXCLUDED.rug_points,
  difficulty = EXCLUDED.difficulty,
  active = EXCLUDED.active;

-- ─── 4. Period mission assignment counts: daily=3, weekly=4 ────────────────
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
  assigned integer := 0;
  rows jsonb;
  pick_count integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_period_type NOT IN ('daily', 'weekly') THEN RAISE EXCEPTION 'invalid period'; END IF;

  PERFORM public.rt_ensure_progression(uid);
  PERFORM public.migrate_progression_curve_v3();
  period_key := CASE WHEN p_period_type = 'daily'
    THEN public.rt_utc_daily_key(now())
    ELSE public.rt_utc_weekly_key(now())
  END;
  pick_count := CASE WHEN p_period_type = 'daily' THEN 3 ELSE 4 END;

  FOR def IN
    SELECT *
    FROM public.mission_definitions
    WHERE period_type = p_period_type AND active = true
    ORDER BY md5(id || uid::text || period_key)
    LIMIT pick_count
  LOOP
    INSERT INTO public.mission_assignments (
      player_id, mission_definition_id, period_type, period_key, progress, target, status
    ) VALUES (
      uid, def.id, p_period_type, period_key, 0, def.target, 'active'
    ) ON CONFLICT DO NOTHING;
    assigned := assigned + 1;
  END LOOP;

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

-- ─── 5. Tracking tables ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.player_daily_streaks (
  player_id       uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_streak  integer NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  longest_streak  integer NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  last_daily_key  text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mission_action_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_key  text NOT NULL,
  mission_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, action_key)
);

CREATE INDEX IF NOT EXISTS idx_mission_action_receipts_player
  ON public.mission_action_receipts (player_id, mission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.player_building_interactions (
  player_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  building_id         text NOT NULL,
  interaction_count   integer NOT NULL DEFAULT 0 CHECK (interaction_count >= 0),
  last_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, building_id)
);

CREATE TABLE IF NOT EXISTS public.npc_interaction_progress (
  player_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  npc_id              text NOT NULL,
  interaction_count   integer NOT NULL DEFAULT 0 CHECK (interaction_count >= 0),
  last_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, npc_id)
);

ALTER TABLE public.player_daily_streaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_building_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.npc_interaction_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_streaks: owner read" ON public.player_daily_streaks;
CREATE POLICY "daily_streaks: owner read"
  ON public.player_daily_streaks FOR SELECT
  USING (auth.uid() = player_id);

DROP POLICY IF EXISTS "daily_streaks: owner update" ON public.player_daily_streaks;
CREATE POLICY "daily_streaks: owner update"
  ON public.player_daily_streaks FOR UPDATE
  USING (auth.uid() = player_id)
  WITH CHECK (auth.uid() = player_id);

DROP POLICY IF EXISTS "mission_action_receipts: owner read" ON public.mission_action_receipts;
CREATE POLICY "mission_action_receipts: owner read"
  ON public.mission_action_receipts FOR SELECT
  USING (auth.uid() = player_id);

DROP POLICY IF EXISTS "building_interactions: owner read" ON public.player_building_interactions;
CREATE POLICY "building_interactions: owner read"
  ON public.player_building_interactions FOR SELECT
  USING (auth.uid() = player_id);

DROP POLICY IF EXISTS "npc_interaction: owner read" ON public.npc_interaction_progress;
CREATE POLICY "npc_interaction: owner read"
  ON public.npc_interaction_progress FOR SELECT
  USING (auth.uid() = player_id);

COMMENT ON TABLE public.player_daily_streaks IS
  'Daily mission streak counters. Clients read/update own row; server RPCs may upsert.';

-- ─── 6. Party mission definitions (production catalog) ──────────────────────
INSERT INTO public.party_mission_definitions (
  id, title, description, mission_scope, contribution_method,
  min_party_size, max_party_size, progress_target, min_contribution_per_member,
  allocation_method, reward_xp, reward_rep, reward_rug, duration_minutes,
  join_cutoff_minutes, cooldown_hours, is_test, active, rules_version, metadata
) VALUES
  (
    'party_three_districts',
    'District Sweep',
    'As a crew, visit three distinct districts.',
    'party_required', 'unique_member_actions',
    2, 4, 3, 1,
    'equal_eligible', 80, 12, 0, 60,
    10, 20, false, true, '1',
    jsonb_build_object('objectiveType', 'visit_districts', 'target', 3, 'allowSoloFallback', true)
  ),
  (
    'party_city_event',
    'Event Together',
    'Complete one city event while party members are present.',
    'party_required', 'event_participation',
    2, 4, 1, 1,
    'equal_eligible', 70, 10, 0, 45,
    10, 20, false, true, '1',
    jsonb_build_object('objectiveType', 'join_event', 'target', 1, 'allowSoloFallback', true)
  ),
  (
    'party_spring_meet',
    'Meet at Spring Water',
    'Gather the party at Spring Water.',
    'party_required', 'synchronized_presence',
    2, 4, 2, 1,
    'equal_eligible', 50, 8, 0, 30,
    10, 20, false, true, '1',
    jsonb_build_object('objectiveType', 'visit_landmark', 'objectiveRef', 'fountain', 'target', 1, 'allowSoloFallback', true)
  ),
  (
    'party_multi_delivery',
    'City Delivery Run',
    'Interact with Notice Board, Coffee Shop, and Market as a party.',
    'party_required', 'unique_member_actions',
    2, 4, 3, 1,
    'equal_eligible', 90, 14, 0, 60,
    10, 20, false, true, '1',
    jsonb_build_object(
      'objectiveType', 'discover_landmarks', 'target', 3,
      'landmarks', jsonb_build_array('notice', 'coffee', 'market'),
      'allowSoloFallback', true
    )
  ),
  (
    'party_twin_landmarks',
    'Twin Landmark Dash',
    'Interact with Bridge and Whale Tower within the mission window.',
    'party_required', 'unique_member_actions',
    2, 4, 2, 1,
    'equal_eligible', 75, 11, 0, 45,
    10, 20, false, true, '1',
    jsonb_build_object(
      'objectiveType', 'discover_landmarks', 'target', 2,
      'landmarks', jsonb_build_array('bridge', 'whale'),
      'allowSoloFallback', true
    )
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  mission_scope = EXCLUDED.mission_scope,
  contribution_method = EXCLUDED.contribution_method,
  min_party_size = EXCLUDED.min_party_size,
  max_party_size = EXCLUDED.max_party_size,
  progress_target = EXCLUDED.progress_target,
  min_contribution_per_member = EXCLUDED.min_contribution_per_member,
  allocation_method = EXCLUDED.allocation_method,
  reward_xp = EXCLUDED.reward_xp,
  reward_rep = EXCLUDED.reward_rep,
  reward_rug = EXCLUDED.reward_rug,
  duration_minutes = EXCLUDED.duration_minutes,
  join_cutoff_minutes = EXCLUDED.join_cutoff_minutes,
  cooldown_hours = EXCLUDED.cooldown_hours,
  is_test = EXCLUDED.is_test,
  active = EXCLUDED.active,
  rules_version = EXCLUDED.rules_version,
  metadata = EXCLUDED.metadata;

-- ─── 7. Period completion bonus claim RPCs ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_daily_completion_bonus()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  period_key text := public.rt_utc_daily_key(now());
  required integer := 3;
  claimed_count integer;
  prog public.player_progression;
  receipt_key text;
  new_xp bigint;
  new_rep integer;
  new_season integer;
  new_rug integer;
  new_level integer;
  active_season text;
  bonus_xp integer := 40;
  bonus_rep integer := 8;
  bonus_season integer := 12;
  bonus_rug integer := 15;
  xp_inserted uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT count(*) INTO claimed_count
  FROM public.mission_assignments
  WHERE player_id = uid
    AND period_type = 'daily'
    AND period_key = period_key
    AND status = 'claimed';

  IF claimed_count < required THEN
    RAISE EXCEPTION 'not all daily missions claimed (% of %)', claimed_count, required;
  END IF;

  receipt_key := 'daily_bonus:' || period_key;
  PERFORM public.rt_ensure_progression(uid);
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;

  IF coalesce(prog.claimed_reward_keys, '[]'::jsonb) ? receipt_key
     OR EXISTS (
       SELECT 1 FROM public.reward_ledger
       WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
     ) THEN
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'periodKey', period_key);
  END IF;

  SELECT id INTO active_season
  FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC
  LIMIT 1;

  PERFORM public.rt_set_mutation_flag();

  INSERT INTO public.reward_ledger (
    player_id, reward_type, amount, reason, source_type, source_id,
    idempotency_key, metadata
  ) VALUES
    (uid, 'XP', bonus_xp, 'daily_completion_bonus', 'daily_bonus', period_key,
      receipt_key || ':XP', jsonb_build_object('periodKey', period_key)),
    (uid, 'REP', bonus_rep, 'daily_completion_bonus', 'daily_bonus', period_key,
      receipt_key || ':REP', jsonb_build_object('periodKey', period_key))
  ON CONFLICT (player_id, idempotency_key) DO NOTHING
  RETURNING id INTO xp_inserted;

  IF bonus_season > 0 AND active_season IS NOT NULL THEN
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, 'SEASON_POINTS', bonus_season, 'daily_completion_bonus', 'daily_bonus', period_key,
      receipt_key || ':SEASON_POINTS', jsonb_build_object('periodKey', period_key)
    ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  END IF;

  IF bonus_rug > 0 THEN
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, 'RUG_POINTS', bonus_rug, 'daily_completion_bonus', 'daily_bonus', period_key,
      receipt_key || ':RUG_POINTS', jsonb_build_object('periodKey', period_key)
    ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  END IF;

  IF xp_inserted IS NULL AND EXISTS (
    SELECT 1 FROM public.reward_ledger
    WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
  ) THEN
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'periodKey', period_key);
  END IF;

  new_xp := prog.lifetime_xp + bonus_xp;
  new_rep := prog.rep + bonus_rep;
  new_season := prog.season_points + CASE WHEN active_season IS NOT NULL THEN bonus_season ELSE 0 END;
  new_rug := prog.rug_points + bonus_rug;
  new_level := public.rt_recompute_level(new_xp, greatest(prog.progression_curve_version, 3));

  UPDATE public.player_progression SET
    lifetime_xp = new_xp,
    level = new_level,
    rep = new_rep,
    rug_points = new_rug,
    season_id = coalesce(active_season, season_id),
    season_points = CASE WHEN active_season IS NOT NULL THEN new_season ELSE season_points END,
    progression_curve_version = greatest(progression_curve_version, 3),
    claimed_reward_keys = (
      SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
      FROM jsonb_array_elements_text(
        coalesce(claimed_reward_keys, '[]'::jsonb) || jsonb_build_array(receipt_key)
      ) AS value
    ),
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  RETURN jsonb_build_object(
    'claimed', true,
    'duplicate', false,
    'periodKey', period_key,
    'xpAwarded', bonus_xp,
    'repAwarded', bonus_rep,
    'progression', to_jsonb(prog)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_weekly_completion_bonus()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  period_key text := public.rt_utc_weekly_key(now());
  required integer := 4;
  claimed_count integer;
  prog public.player_progression;
  receipt_key text;
  new_xp bigint;
  new_rep integer;
  new_season integer;
  new_rug integer;
  new_level integer;
  active_season text;
  bonus_xp integer := 120;
  bonus_rep integer := 25;
  bonus_season integer := 40;
  bonus_rug integer := 50;
  xp_inserted uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT count(*) INTO claimed_count
  FROM public.mission_assignments
  WHERE player_id = uid
    AND period_type = 'weekly'
    AND period_key = period_key
    AND status = 'claimed';

  IF claimed_count < required THEN
    RAISE EXCEPTION 'not all weekly missions claimed (% of %)', claimed_count, required;
  END IF;

  receipt_key := 'weekly_bonus:' || period_key;
  PERFORM public.rt_ensure_progression(uid);
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;

  IF coalesce(prog.claimed_reward_keys, '[]'::jsonb) ? receipt_key
     OR EXISTS (
       SELECT 1 FROM public.reward_ledger
       WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
     ) THEN
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'periodKey', period_key);
  END IF;

  SELECT id INTO active_season
  FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC
  LIMIT 1;

  PERFORM public.rt_set_mutation_flag();

  INSERT INTO public.reward_ledger (
    player_id, reward_type, amount, reason, source_type, source_id,
    idempotency_key, metadata
  ) VALUES
    (uid, 'XP', bonus_xp, 'weekly_completion_bonus', 'weekly_bonus', period_key,
      receipt_key || ':XP', jsonb_build_object('periodKey', period_key)),
    (uid, 'REP', bonus_rep, 'weekly_completion_bonus', 'weekly_bonus', period_key,
      receipt_key || ':REP', jsonb_build_object('periodKey', period_key))
  ON CONFLICT (player_id, idempotency_key) DO NOTHING
  RETURNING id INTO xp_inserted;

  IF bonus_season > 0 AND active_season IS NOT NULL THEN
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, 'SEASON_POINTS', bonus_season, 'weekly_completion_bonus', 'weekly_bonus', period_key,
      receipt_key || ':SEASON_POINTS', jsonb_build_object('periodKey', period_key)
    ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  END IF;

  IF bonus_rug > 0 THEN
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, 'RUG_POINTS', bonus_rug, 'weekly_completion_bonus', 'weekly_bonus', period_key,
      receipt_key || ':RUG_POINTS', jsonb_build_object('periodKey', period_key)
    ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  END IF;

  IF xp_inserted IS NULL AND EXISTS (
    SELECT 1 FROM public.reward_ledger
    WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
  ) THEN
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'periodKey', period_key);
  END IF;

  new_xp := prog.lifetime_xp + bonus_xp;
  new_rep := prog.rep + bonus_rep;
  new_season := prog.season_points + CASE WHEN active_season IS NOT NULL THEN bonus_season ELSE 0 END;
  new_rug := prog.rug_points + bonus_rug;
  new_level := public.rt_recompute_level(new_xp, greatest(prog.progression_curve_version, 3));

  UPDATE public.player_progression SET
    lifetime_xp = new_xp,
    level = new_level,
    rep = new_rep,
    rug_points = new_rug,
    season_id = coalesce(active_season, season_id),
    season_points = CASE WHEN active_season IS NOT NULL THEN new_season ELSE season_points END,
    progression_curve_version = greatest(progression_curve_version, 3),
    claimed_reward_keys = (
      SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
      FROM jsonb_array_elements_text(
        coalesce(claimed_reward_keys, '[]'::jsonb) || jsonb_build_array(receipt_key)
      ) AS value
    ),
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  RETURN jsonb_build_object(
    'claimed', true,
    'duplicate', false,
    'periodKey', period_key,
    'xpAwarded', bonus_xp,
    'repAwarded', bonus_rep,
    'progression', to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_daily_completion_bonus() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_daily_completion_bonus() TO authenticated;
REVOKE ALL ON FUNCTION public.claim_weekly_completion_bonus() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_completion_bonus() TO authenticated;

-- ─── 8. Patch award paths to respect curve version ──────────────────────────
CREATE OR REPLACE FUNCTION public.claim_mission_reward(p_assignment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  a public.mission_assignments;
  def public.mission_definitions;
  prog public.player_progression;
  receipt_key text;
  new_xp bigint;
  new_rep integer;
  new_season integer;
  new_rug integer;
  new_level integer;
  active_season text;
  xp_inserted uuid;
  curve_ver integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO a
  FROM public.mission_assignments
  WHERE id = p_assignment_id AND player_id = uid
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'assignment not found'; END IF;
  IF a.status = 'claimed' THEN
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'assignment', to_jsonb(a));
  END IF;
  IF a.status <> 'completed' THEN
    RAISE EXCEPTION 'mission not completed';
  END IF;

  SELECT * INTO def FROM public.mission_definitions WHERE id = a.mission_definition_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'mission definition not found'; END IF;

  receipt_key := 'mission_claim:' || a.id::text;

  PERFORM public.rt_ensure_progression(uid);
  PERFORM public.migrate_progression_curve_v3();
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;
  curve_ver := greatest(prog.progression_curve_version, 3);

  IF coalesce(prog.claimed_reward_keys, '[]'::jsonb) ? receipt_key
     OR EXISTS (
       SELECT 1 FROM public.reward_ledger
       WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
     ) THEN
    SELECT * INTO a FROM public.mission_assignments WHERE id = p_assignment_id;
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'assignment', to_jsonb(a));
  END IF;

  SELECT id INTO active_season
  FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC
  LIMIT 1;

  PERFORM public.rt_set_mutation_flag();

  INSERT INTO public.reward_ledger (
    player_id, reward_type, amount, reason, source_type, source_id,
    idempotency_key, metadata
  ) VALUES
    (uid, 'XP', def.xp_reward,
      'period_mission:' || def.id, a.period_type || '_claim', def.id,
      receipt_key || ':XP',
      jsonb_build_object('assignmentId', a.id, 'periodType', a.period_type, 'curve_version', curve_ver)),
    (uid, 'REP', def.rep_reward,
      'period_mission:' || def.id, a.period_type || '_claim', def.id,
      receipt_key || ':REP',
      jsonb_build_object('assignmentId', a.id, 'periodType', a.period_type, 'curve_version', curve_ver))
  ON CONFLICT (player_id, idempotency_key) DO NOTHING
  RETURNING id INTO xp_inserted;

  IF def.season_points > 0 AND active_season IS NOT NULL THEN
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, 'SEASON_POINTS', def.season_points,
      'period_mission:' || def.id, a.period_type || '_claim', def.id,
      receipt_key || ':SEASON_POINTS',
      jsonb_build_object('assignmentId', a.id, 'periodType', a.period_type)
    ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  END IF;

  IF def.rug_points > 0 THEN
    INSERT INTO public.reward_ledger (
      player_id, reward_type, amount, reason, source_type, source_id,
      idempotency_key, metadata
    ) VALUES (
      uid, 'RUG_POINTS', def.rug_points,
      'period_mission:' || def.id, a.period_type || '_claim', def.id,
      receipt_key || ':RUG_POINTS',
      jsonb_build_object('assignmentId', a.id, 'periodType', a.period_type)
    ) ON CONFLICT (player_id, idempotency_key) DO NOTHING;
  END IF;

  IF xp_inserted IS NULL AND EXISTS (
    SELECT 1 FROM public.reward_ledger
    WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
  ) THEN
    SELECT * INTO a FROM public.mission_assignments WHERE id = p_assignment_id;
    RETURN jsonb_build_object('claimed', false, 'duplicate', true, 'assignment', to_jsonb(a));
  END IF;

  new_xp := prog.lifetime_xp + def.xp_reward;
  new_rep := prog.rep + def.rep_reward;
  new_season := prog.season_points + CASE WHEN active_season IS NOT NULL THEN def.season_points ELSE 0 END;
  new_rug := prog.rug_points + def.rug_points;
  new_level := public.rt_recompute_level(new_xp, curve_ver);

  UPDATE public.player_progression SET
    lifetime_xp = new_xp,
    level = new_level,
    rep = new_rep,
    rug_points = new_rug,
    season_id = coalesce(active_season, season_id),
    season_points = CASE WHEN active_season IS NOT NULL THEN new_season ELSE season_points END,
    progression_curve_version = curve_ver,
    claimed_reward_keys = (
      SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
      FROM jsonb_array_elements_text(
        coalesce(claimed_reward_keys, '[]'::jsonb) || jsonb_build_array(receipt_key)
      ) AS value
    ),
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  UPDATE public.mission_assignments
  SET status = 'claimed', claimed_at = now()
  WHERE id = a.id
  RETURNING * INTO a;

  RETURN jsonb_build_object(
    'claimed', true,
    'duplicate', false,
    'assignment', to_jsonb(a),
    'xpAwarded', def.xp_reward,
    'repAwarded', def.rep_reward,
    'seasonPointsAwarded', def.season_points,
    'rugPointsAwarded', def.rug_points,
    'progression', to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mission_reward(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_mission_reward(uuid) TO authenticated;

-- Patch award_gameplay_reward level recompute to honor curve version.
CREATE OR REPLACE FUNCTION public.award_gameplay_reward(
  p_source_type text,
  p_source_id text,
  p_idempotency_key text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  prog public.player_progression;
  existing public.reward_ledger;
  def RECORD;
  inserted public.reward_ledger;
  results jsonb := '[]'::jsonb;
  new_xp bigint;
  new_rep integer;
  new_season integer;
  new_rug integer;
  new_level integer;
  active_season text;
  curve_ver integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_source_type IS NULL OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'invalid reward request';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 3 THEN
    RAISE EXCEPTION 'invalid idempotency key';
  END IF;

  SELECT * INTO existing
  FROM public.reward_ledger
  WHERE player_id = uid
    AND (idempotency_key = p_idempotency_key OR idempotency_key LIKE p_idempotency_key || ':%')
  LIMIT 1;
  IF FOUND THEN
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
    RETURN jsonb_build_object(
      'awarded', false,
      'duplicate', true,
      'ledger_id', existing.id,
      'progression', to_jsonb(prog)
    );
  END IF;

  prog := public.rt_ensure_progression(uid);
  PERFORM public.migrate_progression_curve_v3();
  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;
  curve_ver := greatest(prog.progression_curve_version, 3);

  IF prog.manual_review_status = 'restricted' THEN
    RAISE EXCEPTION 'account restricted';
  END IF;

  SELECT id INTO active_season
  FROM public.seasons
  WHERE status = 'active' AND now() BETWEEN starts_at AND ends_at
  ORDER BY starts_at DESC
  LIMIT 1;

  PERFORM public.rt_set_mutation_flag();
  new_xp := prog.lifetime_xp;
  new_rep := prog.rep;
  new_season := prog.season_points;
  new_rug := prog.rug_points;

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
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('definition_id', def.id, 'rules_version', def.rules_version, 'curve_version', curve_ver)
    )
    ON CONFLICT (player_id, idempotency_key) DO NOTHING
    RETURNING * INTO inserted;

    IF inserted.id IS NOT NULL THEN
      results := results || jsonb_build_array(to_jsonb(inserted));
      IF def.reward_type = 'XP' THEN new_xp := new_xp + def.amount; END IF;
      IF def.reward_type = 'REP' THEN new_rep := new_rep + def.amount; END IF;
      IF def.reward_type = 'SEASON_POINTS' AND active_season IS NOT NULL THEN
        new_season := new_season + def.amount;
      END IF;
      IF def.reward_type = 'RUG_POINTS' THEN new_rug := new_rug + def.amount; END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(results) = 0 THEN
    RAISE EXCEPTION 'unknown or inactive reward source: %', p_source_type;
  END IF;

  new_level := public.rt_recompute_level(new_xp, curve_ver);

  UPDATE public.player_progression SET
    lifetime_xp = new_xp,
    level = new_level,
    rep = new_rep,
    rug_points = new_rug,
    season_id = coalesce(active_season, season_id),
    season_points = CASE WHEN active_season IS NOT NULL THEN new_season ELSE season_points END,
    progression_curve_version = curve_ver,
    claimed_reward_keys = claimed_reward_keys || jsonb_build_array(p_idempotency_key),
    updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  RETURN jsonb_build_object(
    'awarded', true,
    'duplicate', false,
    'entries', results,
    'progression', to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.award_gameplay_reward(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.award_gameplay_reward(text, text, text, jsonb) TO authenticated;

-- Patch complete_chapter_mission to use curve v3 on XP awards.
CREATE OR REPLACE FUNCTION public.complete_chapter_mission(p_mission_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  cat RECORD;
  state_row public.chapter_mission_state;
  prog public.player_progression;
  new_xp bigint;
  new_rep integer;
  new_level integer;
  receipt_key text;
  xp_inserted uuid;
  active_mission text;
  curve_ver integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_mission_id IS NULL OR length(trim(p_mission_id)) = 0 THEN
    RAISE EXCEPTION 'invalid mission id';
  END IF;

  SELECT * INTO cat FROM public.rt_chapter_one_catalog(p_mission_id);
  IF cat.mission_id IS NULL THEN RAISE EXCEPTION 'unknown chapter mission'; END IF;

  PERFORM public.rt_ensure_progression(uid);
  PERFORM public.migrate_progression_curve_v3();
  PERFORM public.rt_sync_chapter_mission_state(uid);

  SELECT * INTO prog FROM public.player_progression WHERE player_id = uid FOR UPDATE;
  curve_ver := greatest(prog.progression_curve_version, 3);
  receipt_key := 'mission:' || p_mission_id || ':complete';

  IF coalesce(prog.claimed_reward_keys, '[]'::jsonb) ? receipt_key
     OR EXISTS (
       SELECT 1 FROM public.reward_ledger
       WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
     ) THEN
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
    RETURN jsonb_build_object(
      'awarded', false, 'duplicate', true,
      'missionId', p_mission_id, 'progression', to_jsonb(prog)
    );
  END IF;

  SELECT mission_id INTO active_mission
  FROM public.chapter_mission_state
  WHERE user_id = uid AND status = 'active'
  ORDER BY (
    SELECT mission_order FROM public.rt_chapter_one_catalog(mission_id)
  )
  LIMIT 1;

  IF active_mission IS DISTINCT FROM p_mission_id THEN
    RAISE EXCEPTION 'mission is not active (expected %)', coalesce(active_mission, 'none');
  END IF;

  SELECT * INTO state_row
  FROM public.chapter_mission_state
  WHERE user_id = uid AND mission_id = p_mission_id
  FOR UPDATE;

  IF state_row.status = 'completed' THEN
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
    RETURN jsonb_build_object(
      'awarded', false, 'duplicate', true,
      'missionId', p_mission_id, 'progression', to_jsonb(prog)
    );
  END IF;

  PERFORM public.rt_set_mutation_flag();

  INSERT INTO public.reward_ledger (
    player_id, reward_type, amount, reason, source_type, source_id,
    idempotency_key, metadata
  ) VALUES
    (uid, 'XP', cat.xp_reward,
      'chapter_mission:' || p_mission_id, 'chapter_mission', p_mission_id,
      receipt_key || ':XP', jsonb_build_object('curve_version', curve_ver, 'mission_version', 1)),
    (uid, 'REP', cat.rep_reward,
      'chapter_mission:' || p_mission_id, 'chapter_mission', p_mission_id,
      receipt_key || ':REP', jsonb_build_object('curve_version', curve_ver, 'mission_version', 1))
  ON CONFLICT (player_id, idempotency_key) DO NOTHING
  RETURNING id INTO xp_inserted;

  IF xp_inserted IS NULL AND EXISTS (
    SELECT 1 FROM public.reward_ledger
    WHERE player_id = uid AND idempotency_key = receipt_key || ':XP'
  ) THEN
    SELECT * INTO prog FROM public.player_progression WHERE player_id = uid;
    RETURN jsonb_build_object(
      'awarded', false, 'duplicate', true,
      'missionId', p_mission_id, 'progression', to_jsonb(prog)
    );
  END IF;

  new_xp := prog.lifetime_xp + cat.xp_reward;
  new_rep := prog.rep + cat.rep_reward;
  new_level := public.rt_recompute_level(new_xp, curve_ver);

  UPDATE public.player_progression
  SET lifetime_xp = new_xp,
      rep = new_rep,
      level = new_level,
      progression_curve_version = curve_ver,
      claimed_reward_keys = (
        SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
        FROM jsonb_array_elements_text(
          coalesce(claimed_reward_keys, '[]'::jsonb) || jsonb_build_array(receipt_key)
        ) AS value
      ),
      statistics = jsonb_set(
        coalesce(statistics, '{}'::jsonb),
        '{missionsCompleted}',
        to_jsonb(coalesce((statistics->>'missionsCompleted')::integer, 0) + 1),
        true
      ),
      updated_at = now()
  WHERE player_id = uid
  RETURNING * INTO prog;

  UPDATE public.profiles SET rep = new_rep, last_seen_at = now() WHERE id = uid;

  UPDATE public.chapter_mission_state
  SET status = 'completed',
      progress = jsonb_build_object('complete', true),
      completed_at = now(),
      reward_claimed_at = now(),
      updated_at = now()
  WHERE user_id = uid AND mission_id = p_mission_id;

  IF cat.next_mission_id IS NOT NULL THEN
    INSERT INTO public.chapter_mission_state (user_id, mission_id, status, started_at)
    VALUES (uid, cat.next_mission_id, 'active', now())
    ON CONFLICT (user_id, mission_id) DO UPDATE
      SET status = CASE
            WHEN chapter_mission_state.status IN ('locked', 'active') THEN 'active'
            ELSE chapter_mission_state.status
          END,
          started_at = coalesce(chapter_mission_state.started_at, now()),
          updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'awarded', true,
    'duplicate', false,
    'missionId', p_mission_id,
    'xpAwarded', cat.xp_reward,
    'repAwarded', cat.rep_reward,
    'progression', to_jsonb(prog)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_chapter_mission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_chapter_mission(text) TO authenticated;

-- Patch ensure_chapter_missions to migrate v3 on login.
CREATE OR REPLACE FUNCTION public.ensure_chapter_missions()
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
  PERFORM public.rt_ensure_progression(uid);
  PERFORM public.migrate_progression_curve_v3();
  PERFORM public.rt_sync_chapter_mission_state(uid);

  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY c.mission_order), '[]'::jsonb)
  INTO rows
  FROM public.chapter_mission_state s
  JOIN public.rt_chapter_one_catalog() c ON c.mission_id = s.mission_id
  WHERE s.user_id = uid;

  RETURN jsonb_build_object('missions', rows);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_chapter_missions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_chapter_missions() TO authenticated;

-- ─── Verification (read-only) ───────────────────────────────────────────────
SELECT public.rt_recompute_level_v3(320) AS level_at_320_xp_v3;
SELECT count(*) FILTER (WHERE period_type = 'daily') AS daily_defs,
       count(*) FILTER (WHERE period_type = 'weekly') AS weekly_defs
FROM public.mission_definitions WHERE active = true;
SELECT id, active, is_test FROM public.party_mission_definitions
WHERE id LIKE 'party_%' ORDER BY id;

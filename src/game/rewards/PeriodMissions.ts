/**
 * PeriodMissions.ts — client catalog mirroring server mission_definitions.
 * Daily: 5 assigned, category-guaranteed (1 each of exploration/social/
 * mission/activity + 1 wildcard). Weekly: 3 assigned from pool ≥15.
 * Kept in sync with database/migrations/20260820_phase2_progression_leaderboards_quests.sql
 * (section 1) — this is the offline/guest fallback catalog; authenticated
 * players get their assignment from ensure_period_missions server-side.
 */

import type { MissionObjectiveType, MissionPeriodType } from './types';

export type DailyMissionCategory = 'exploration' | 'social' | 'mission' | 'activity';

export interface PeriodMissionDef {
  id: string;
  periodType: MissionPeriodType;
  title: string;
  description: string;
  objectiveType: MissionObjectiveType;
  target: number;
  objectiveRef?: string;
  xpReward: number;
  repReward: number;
  seasonPoints: number;
  rugPoints: number;
  difficulty: 'easy' | 'medium' | 'hard';
  /** Daily missions only — used for the 5-category-guaranteed local pick. */
  category?: DailyMissionCategory;
}

export const DAILY_MISSION_CATALOG: PeriodMissionDef[] = [
  { id: 'daily_visit_spring', periodType: 'daily', title: 'Spring Visit', description: 'Interact with Spring Water.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'fountain', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_visit_bridge', periodType: 'daily', title: 'Bridge Walk', description: 'Visit the Main Bridge.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'bridge', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_three_landmarks', periodType: 'daily', title: 'Three Stops', description: 'Discover 3 landmarks today.', objectiveType: 'discover_landmarks', target: 3, xpReward: 40, repReward: 6, seasonPoints: 10, rugPoints: 12, difficulty: 'medium', category: 'exploration' },
  { id: 'daily_enter_interior', periodType: 'daily', title: 'Step Inside', description: 'Enter any open interior.', objectiveType: 'enter_interior', target: 1, xpReward: 32, repReward: 4, seasonPoints: 8, rugPoints: 10, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_meet_player', periodType: 'daily', title: 'City Hello', description: 'Meet one unique real player (NPC fallback when alone).', objectiveType: 'meet_player', target: 1, xpReward: 36, repReward: 5, seasonPoints: 10, rugPoints: 12, difficulty: 'medium', category: 'social' },
  { id: 'daily_wave', periodType: 'daily', title: 'Friendly Wave', description: 'Wave or emote at someone.', objectiveType: 'wave_player', target: 1, xpReward: 22, repReward: 2, seasonPoints: 5, rugPoints: 6, difficulty: 'easy', category: 'social' },
  { id: 'daily_city_event', periodType: 'daily', title: 'Event Curious', description: 'Join one city event.', objectiveType: 'join_event', target: 1, xpReward: 38, repReward: 5, seasonPoints: 10, rugPoints: 12, difficulty: 'medium', category: 'activity' },
  { id: 'daily_two_districts', periodType: 'daily', title: 'District Hop', description: 'Visit 2 districts.', objectiveType: 'visit_districts', target: 2, xpReward: 34, repReward: 5, seasonPoints: 8, rugPoints: 10, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_notice_board', periodType: 'daily', title: 'Check the Board', description: 'Interact with the Notice Board.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'notice', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_coffee', periodType: 'daily', title: 'Coffee Run', description: 'Visit the Coffee Shop.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'coffee', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_meme_market', periodType: 'daily', title: 'Market Peek', description: 'Visit Meme Market.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'market', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_hall_fame', periodType: 'daily', title: 'Hall Walk', description: 'Visit Hall of Fame.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'fame', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_alpha', periodType: 'daily', title: 'Lounge Drop-In', description: 'Visit Alpha Lounge.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'alpha', xpReward: 30, repReward: 4, seasonPoints: 7, rugPoints: 9, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_talk_npcs', periodType: 'daily', title: 'Street Talk', description: 'Talk to 4 citizens or guides.', objectiveType: 'meet_players', target: 4, xpReward: 36, repReward: 5, seasonPoints: 9, rugPoints: 11, difficulty: 'medium', category: 'social' },
  { id: 'daily_join_party', periodType: 'daily', title: 'Find a Crew', description: 'Open party panel / join a party action.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'party_action', xpReward: 34, repReward: 5, seasonPoints: 9, rugPoints: 11, difficulty: 'medium', category: 'activity' },
  { id: 'daily_whale', periodType: 'daily', title: 'Whale Watch', description: 'Visit Whale Tower.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'whale', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_government', periodType: 'daily', title: 'Civic Stop', description: 'Visit Government Quarter (Mission HQ).', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'government', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_academy', periodType: 'daily', title: 'Study Hall', description: 'Visit Trading Academy.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'trading_academy', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_park', periodType: 'daily', title: 'Park Air', description: 'Visit the Park Entrance.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'park', xpReward: 24, repReward: 3, seasonPoints: 5, rugPoints: 7, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_complete_one', periodType: 'daily', title: 'One More Mission', description: 'Complete any other mission today.', objectiveType: 'complete_missions', target: 1, xpReward: 40, repReward: 6, seasonPoints: 10, rugPoints: 12, difficulty: 'medium', category: 'mission' },
  { id: 'daily_random_landmark', periodType: 'daily', title: 'Landmark of the Day', description: 'Interact with Observatory or Financial Office.', objectiveType: 'discover_landmarks', target: 1, objectiveRef: 'research_observatory', xpReward: 30, repReward: 4, seasonPoints: 7, rugPoints: 9, difficulty: 'easy', category: 'exploration' },
  { id: 'daily_social_hub_visit', periodType: 'daily', title: 'Social Hub Regular', description: 'Visit the Coffee Shop / Social Hub.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'coffee', xpReward: 26, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy', category: 'social' },
  { id: 'daily_wave_two', periodType: 'daily', title: 'Double Wave', description: 'Wave or emote at two different players.', objectiveType: 'meet_players', target: 2, xpReward: 32, repReward: 4, seasonPoints: 8, rugPoints: 10, difficulty: 'medium', category: 'social' },
  { id: 'daily_chat_hello', periodType: 'daily', title: 'Say Hello', description: 'Send a message in city chat.', objectiveType: 'wave_player', target: 1, objectiveRef: 'chat', xpReward: 24, repReward: 3, seasonPoints: 6, rugPoints: 7, difficulty: 'easy', category: 'social' },
  { id: 'daily_mission_chain', periodType: 'daily', title: 'Chain Progress', description: 'Advance any mission chain by one stage.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'chain', xpReward: 42, repReward: 6, seasonPoints: 10, rugPoints: 13, difficulty: 'medium', category: 'mission' },
  { id: 'daily_mission_starter', periodType: 'daily', title: 'Warm-Up Task', description: 'Complete any starter or level-two mission today.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'starter', xpReward: 38, repReward: 5, seasonPoints: 9, rugPoints: 12, difficulty: 'medium', category: 'mission' },
  { id: 'daily_mission_bracket', periodType: 'daily', title: 'Tier Progress', description: 'Complete a bracket mission for your current level tier.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'bracket', xpReward: 44, repReward: 6, seasonPoints: 11, rugPoints: 14, difficulty: 'medium', category: 'mission' },
  { id: 'daily_activity_district', periodType: 'daily', title: 'District Activity', description: 'Take part in any building interaction in a new district today.', objectiveType: 'visit_districts', target: 1, xpReward: 28, repReward: 4, seasonPoints: 7, rugPoints: 9, difficulty: 'easy', category: 'activity' },
  { id: 'daily_activity_party', periodType: 'daily', title: 'Team Up', description: 'Take a party action or join a group activity.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'party_action', xpReward: 34, repReward: 5, seasonPoints: 9, rugPoints: 11, difficulty: 'medium', category: 'activity' },
];

export const WEEKLY_MISSION_CATALOG: PeriodMissionDef[] = [
  { id: 'weekly_ten_missions', periodType: 'weekly', title: 'Mission Week', description: 'Complete 10 missions this week.', objectiveType: 'complete_missions', target: 10, xpReward: 120, repReward: 20, seasonPoints: 40, rugPoints: 50, difficulty: 'hard' },
  { id: 'weekly_five_players', periodType: 'weekly', title: 'Social Circuit', description: 'Meet 5 unique real players.', objectiveType: 'meet_players', target: 5, xpReward: 110, repReward: 16, seasonPoints: 35, rugPoints: 45, difficulty: 'hard' },
  { id: 'weekly_all_districts', periodType: 'weekly', title: 'Full Tour', description: 'Visit all five districts.', objectiveType: 'visit_districts', target: 5, xpReward: 130, repReward: 20, seasonPoints: 45, rugPoints: 55, difficulty: 'hard' },
  { id: 'weekly_three_events', periodType: 'weekly', title: 'Event Regular', description: 'Join 3 city events.', objectiveType: 'join_events', target: 3, xpReward: 100, repReward: 16, seasonPoints: 32, rugPoints: 40, difficulty: 'medium' },
  { id: 'weekly_five_interiors', periodType: 'weekly', title: 'Door Opener', description: 'Enter 5 different interiors.', objectiveType: 'enter_interiors', target: 5, xpReward: 110, repReward: 16, seasonPoints: 35, rugPoints: 45, difficulty: 'medium' },
  { id: 'weekly_ten_dailies', periodType: 'weekly', title: 'Daily Grind', description: 'Complete 10 daily quests.', objectiveType: 'complete_missions', target: 10, objectiveRef: 'daily', xpReward: 140, repReward: 22, seasonPoints: 50, rugPoints: 60, difficulty: 'hard' },
  { id: 'weekly_five_city_events', periodType: 'weekly', title: 'Event Circuit', description: 'Complete 5 city events.', objectiveType: 'join_events', target: 5, xpReward: 125, repReward: 18, seasonPoints: 40, rugPoints: 50, difficulty: 'hard' },
  { id: 'weekly_twelve_buildings', periodType: 'weekly', title: 'Building Tour', description: 'Interact with 12 distinct buildings.', objectiveType: 'discover_landmarks', target: 12, xpReward: 135, repReward: 20, seasonPoints: 45, rugPoints: 55, difficulty: 'hard' },
  { id: 'weekly_twenty_npcs', periodType: 'weekly', title: 'Citizen Network', description: 'Talk to 20 NPCs.', objectiveType: 'meet_players', target: 20, xpReward: 120, repReward: 18, seasonPoints: 38, rugPoints: 48, difficulty: 'hard' },
  { id: 'weekly_eight_missions', periodType: 'weekly', title: 'Quest Stack', description: 'Complete 8 story or onboarding missions.', objectiveType: 'complete_missions', target: 8, xpReward: 130, repReward: 20, seasonPoints: 42, rugPoints: 52, difficulty: 'hard' },
  { id: 'weekly_party_three', periodType: 'weekly', title: 'Crew Week', description: 'Complete 3 party actions.', objectiveType: 'complete_missions', target: 3, objectiveRef: 'party', xpReward: 115, repReward: 18, seasonPoints: 36, rugPoints: 46, difficulty: 'medium' },
  { id: 'weekly_emote_variety', periodType: 'weekly', title: 'Express Yourself', description: 'Use emotes 8 times.', objectiveType: 'wave_player', target: 8, xpReward: 90, repReward: 12, seasonPoints: 28, rugPoints: 35, difficulty: 'medium' },
  { id: 'weekly_market_events', periodType: 'weekly', title: 'Market Pulse', description: 'Join 2 market-linked events.', objectiveType: 'join_events', target: 2, objectiveRef: 'market', xpReward: 100, repReward: 15, seasonPoints: 30, rugPoints: 40, difficulty: 'medium' },
  { id: 'weekly_hard_challenge', periodType: 'weekly', title: 'City Challenge', description: 'Complete a hard story stage.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'story_hard', xpReward: 150, repReward: 24, seasonPoints: 55, rugPoints: 65, difficulty: 'hard' },
  { id: 'weekly_exploration_landmarks', periodType: 'weekly', title: 'Explorer Chest', description: 'Visit every major district landmark list (8+).', objectiveType: 'discover_landmarks', target: 8, xpReward: 140, repReward: 22, seasonPoints: 48, rugPoints: 58, difficulty: 'hard' },
];

/** Daily completion bonus when all 5 dailies claimed */
export const DAILY_COMPLETION_BONUS = { xp: 40, rep: 8, seasonPoints: 12, rugPoints: 15 };
/** Weekly completion bonus when all 3 weeklies claimed */
export const WEEKLY_COMPLETION_BONUS = { xp: 120, rep: 25, seasonPoints: 40, rugPoints: 50 };

/** 1 exploration + 1 social + 1 mission + 1 activity + 1 wildcard = 5. */
export const DAILY_ASSIGN_COUNT = 5;
export const WEEKLY_ASSIGN_COUNT = 3;
const DAILY_SLOT_CATEGORIES: DailyMissionCategory[] = ['exploration', 'social', 'mission', 'activity'];

export function getMissionDef(id: string): PeriodMissionDef | undefined {
  return [...DAILY_MISSION_CATALOG, ...WEEKLY_MISSION_CATALOG].find((m) => m.id === id);
}

export function utcDailyKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function utcWeeklyKey(d = new Date()): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * FNV-1a over the whole `seed:id` string. A plain char-code sum would be
 * additive (score = sum(seed chars) + sum(id chars)), so the seed's
 * contribution is a constant shift that cancels out of the sort order —
 * every player would get the identical pick on every day forever. FNV-1a
 * mixes the seed into the running hash at every byte, so a different seed
 * genuinely reorders the catalog.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashPick(seed: string, catalog: PeriodMissionDef[], count: number): PeriodMissionDef[] {
  const scored = catalog.map((m) => ({
    m,
    score: fnv1a(`${seed}:${m.id}`),
  }));
  scored.sort((a, b) => a.score - b.score || a.m.id.localeCompare(b.m.id));
  return scored.slice(0, count).map((s) => s.m);
}

/**
 * Deterministic per (player, UTC day): 1 mission from each of
 * exploration/social/mission/activity, plus 1 wildcard (any category not
 * already picked). Mirrors ensure_period_missions' server-side logic exactly
 * so guest/offline mode produces the same *shape* of assignment (though a
 * different exact mission, since guests have no stable server-side uid to
 * hash against — playerId here is the local guest identity instead).
 */
export function pickLocalDaily(playerId: string, periodKey = utcDailyKey()): PeriodMissionDef[] {
  const picked: PeriodMissionDef[] = [];
  const pickedIds = new Set<string>();
  for (const cat of DAILY_SLOT_CATEGORIES) {
    const pool = DAILY_MISSION_CATALOG.filter((m) => m.category === cat && !pickedIds.has(m.id));
    const [choice] = hashPick(`${playerId}:${periodKey}:daily`, pool, 1);
    if (choice) {
      picked.push(choice);
      pickedIds.add(choice.id);
    }
  }
  const wildcardPool = DAILY_MISSION_CATALOG.filter((m) => !pickedIds.has(m.id));
  const [wildcard] = hashPick(`${playerId}:${periodKey}:daily:wildcard`, wildcardPool, 1);
  if (wildcard) picked.push(wildcard);
  return picked;
}

export function pickLocalWeekly(playerId: string, periodKey = utcWeeklyKey()): PeriodMissionDef[] {
  return hashPick(`${playerId}:${periodKey}:weekly`, WEEKLY_MISSION_CATALOG, WEEKLY_ASSIGN_COUNT);
}

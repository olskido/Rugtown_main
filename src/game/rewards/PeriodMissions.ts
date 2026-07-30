/**
 * PeriodMissions.ts — client catalog mirroring server mission_definitions.
 * Daily: 3 assigned from pool ≥20. Weekly: 4 assigned from pool ≥15.
 */

import type { MissionObjectiveType, MissionPeriodType } from './types';

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
}

export const DAILY_MISSION_CATALOG: PeriodMissionDef[] = [
  { id: 'daily_visit_spring', periodType: 'daily', title: 'Spring Visit', description: 'Interact with Spring Water.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'fountain', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_visit_bridge', periodType: 'daily', title: 'Bridge Walk', description: 'Visit the Main Bridge.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'bridge', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_three_landmarks', periodType: 'daily', title: 'Three Stops', description: 'Discover 3 landmarks today.', objectiveType: 'discover_landmarks', target: 3, xpReward: 40, repReward: 6, seasonPoints: 10, rugPoints: 12, difficulty: 'medium' },
  { id: 'daily_enter_interior', periodType: 'daily', title: 'Step Inside', description: 'Enter any open interior.', objectiveType: 'enter_interior', target: 1, xpReward: 32, repReward: 4, seasonPoints: 8, rugPoints: 10, difficulty: 'easy' },
  { id: 'daily_meet_player', periodType: 'daily', title: 'City Hello', description: 'Meet one unique real player (NPC fallback when alone).', objectiveType: 'meet_player', target: 1, xpReward: 36, repReward: 5, seasonPoints: 10, rugPoints: 12, difficulty: 'medium' },
  { id: 'daily_wave', periodType: 'daily', title: 'Friendly Wave', description: 'Wave or emote at someone.', objectiveType: 'wave_player', target: 1, xpReward: 22, repReward: 2, seasonPoints: 5, rugPoints: 6, difficulty: 'easy' },
  { id: 'daily_city_event', periodType: 'daily', title: 'Event Curious', description: 'Join one city event.', objectiveType: 'join_event', target: 1, xpReward: 38, repReward: 5, seasonPoints: 10, rugPoints: 12, difficulty: 'medium' },
  { id: 'daily_two_districts', periodType: 'daily', title: 'District Hop', description: 'Visit 2 districts.', objectiveType: 'visit_districts', target: 2, xpReward: 34, repReward: 5, seasonPoints: 8, rugPoints: 10, difficulty: 'easy' },
  { id: 'daily_notice_board', periodType: 'daily', title: 'Check the Board', description: 'Interact with the Notice Board.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'notice', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_coffee', periodType: 'daily', title: 'Coffee Run', description: 'Visit the Coffee Shop.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'coffee', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_meme_market', periodType: 'daily', title: 'Market Peek', description: 'Visit Meme Market.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'market', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_hall_fame', periodType: 'daily', title: 'Hall Walk', description: 'Visit Hall of Fame.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'fame', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_alpha', periodType: 'daily', title: 'Lounge Drop-In', description: 'Visit Alpha Lounge.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'alpha', xpReward: 30, repReward: 4, seasonPoints: 7, rugPoints: 9, difficulty: 'easy' },
  { id: 'daily_talk_npcs', periodType: 'daily', title: 'Street Talk', description: 'Talk to 4 citizens or guides.', objectiveType: 'meet_players', target: 4, xpReward: 36, repReward: 5, seasonPoints: 9, rugPoints: 11, difficulty: 'medium' },
  { id: 'daily_join_party', periodType: 'daily', title: 'Find a Crew', description: 'Open party panel / join a party action.', objectiveType: 'complete_missions', target: 1, objectiveRef: 'party_action', xpReward: 34, repReward: 5, seasonPoints: 9, rugPoints: 11, difficulty: 'medium' },
  { id: 'daily_whale', periodType: 'daily', title: 'Whale Watch', description: 'Visit Whale Tower.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'whale', xpReward: 28, repReward: 4, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_government', periodType: 'daily', title: 'Civic Stop', description: 'Visit Government Quarter.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'government', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_academy', periodType: 'daily', title: 'Study Hall', description: 'Visit Trading Academy.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'trading_academy', xpReward: 26, repReward: 3, seasonPoints: 6, rugPoints: 8, difficulty: 'easy' },
  { id: 'daily_park', periodType: 'daily', title: 'Park Air', description: 'Visit the Park Entrance.', objectiveType: 'visit_landmark', target: 1, objectiveRef: 'park', xpReward: 24, repReward: 3, seasonPoints: 5, rugPoints: 7, difficulty: 'easy' },
  { id: 'daily_complete_one', periodType: 'daily', title: 'One More Mission', description: 'Complete any other mission today.', objectiveType: 'complete_missions', target: 1, xpReward: 40, repReward: 6, seasonPoints: 10, rugPoints: 12, difficulty: 'medium' },
  { id: 'daily_random_landmark', periodType: 'daily', title: 'Landmark of the Day', description: 'Interact with Observatory or Financial Office.', objectiveType: 'discover_landmarks', target: 1, objectiveRef: 'research_observatory', xpReward: 30, repReward: 4, seasonPoints: 7, rugPoints: 9, difficulty: 'easy' },
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

/** Daily completion bonus when all 3 dailies claimed */
export const DAILY_COMPLETION_BONUS = { xp: 40, rep: 8, seasonPoints: 12, rugPoints: 15 };
/** Weekly completion bonus when all 4 weeklies claimed */
export const WEEKLY_COMPLETION_BONUS = { xp: 120, rep: 25, seasonPoints: 40, rugPoints: 50 };

export const DAILY_ASSIGN_COUNT = 3;
export const WEEKLY_ASSIGN_COUNT = 4;

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

function hashPick(seed: string, catalog: PeriodMissionDef[], count: number): PeriodMissionDef[] {
  const scored = catalog.map((m) => ({
    m,
    score: Array.from(seed + m.id).reduce((a, c) => a + c.charCodeAt(0), 0),
  }));
  scored.sort((a, b) => a.score - b.score || a.m.id.localeCompare(b.m.id));
  return scored.slice(0, count).map((s) => s.m);
}

export function pickLocalDaily(playerId: string, periodKey = utcDailyKey()): PeriodMissionDef[] {
  return hashPick(`${playerId}:${periodKey}:daily`, DAILY_MISSION_CATALOG, DAILY_ASSIGN_COUNT);
}

export function pickLocalWeekly(playerId: string, periodKey = utcWeeklyKey()): PeriodMissionDef[] {
  return hashPick(`${playerId}:${periodKey}:weekly`, WEEKLY_MISSION_CATALOG, WEEKLY_ASSIGN_COUNT);
}

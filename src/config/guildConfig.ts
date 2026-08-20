/**
 * RugTown Guild — launch balancing (Daily Contracts, Bounties, Streaks).
 * Server RPCs read equivalent values from guild_contract_definitions seeds.
 */

/** Guild objective types wired to trusted gameplay emitters at launch. */
export const GUILD_TRACKED_OBJECTIVES = new Set([
  'visit_districts',
  'complete_missions',
  'meet_players',
  'discover_landmarks',
  'join_event',
  'join_events',
]);

/** Disabled in DB until gameplay emitters support verification (phase15_1). */
export const GUILD_DISABLED_AT_LAUNCH = new Set([
  'guild_daily_market_runner',
  'guild_bounty_district_master',
  'guild_bounty_legend',
]);

export const GUILD_DAILY_CONTRACT_COUNT = 3;
export const GUILD_DAILY_COMPLETION_REP = 250;

export type GuildContractDifficulty = 'easy' | 'medium' | 'hard' | 'legendary';

export interface GuildContractTemplate {
  code: string;
  title: string;
  description: string;
  contractType: 'daily' | 'bounty';
  difficulty: GuildContractDifficulty;
  objectiveType: string;
  target: number;
  objectiveRef?: string;
  repReward: number;
  minLevel?: number;
}

export const GUILD_DAILY_TEMPLATES: GuildContractTemplate[] = [
  { code: 'guild_daily_explorer', title: 'Explorer', description: 'Visit 4 different RugTown districts.', contractType: 'daily', difficulty: 'easy', objectiveType: 'visit_districts', target: 4, repReward: 80 },
  { code: 'guild_daily_market_runner', title: 'Market Runner', description: 'Complete 3 eligible missions in the Market district.', contractType: 'daily', difficulty: 'medium', objectiveType: 'complete_missions', target: 3, objectiveRef: 'market', repReward: 120, minLevel: 2 },
  { code: 'guild_daily_social', title: 'Social Citizen', description: 'Interact meaningfully with 5 unique players.', contractType: 'daily', difficulty: 'medium', objectiveType: 'meet_players', target: 5, repReward: 100 },
  { code: 'guild_daily_mission_specialist', title: 'Mission Specialist', description: 'Complete 4 normal missions.', contractType: 'daily', difficulty: 'medium', objectiveType: 'complete_missions', target: 4, repReward: 120 },
  { code: 'guild_daily_city_walker', title: 'City Walker', description: 'Visit 5 landmarks.', contractType: 'daily', difficulty: 'easy', objectiveType: 'discover_landmarks', target: 5, repReward: 75 },
  { code: 'guild_daily_event', title: 'Event Participant', description: 'Participate in one qualifying city event.', contractType: 'daily', difficulty: 'medium', objectiveType: 'join_event', target: 1, repReward: 150 },
];

export const GUILD_BOUNTY_TEMPLATES: GuildContractTemplate[] = [
  { code: 'guild_bounty_district_master', title: 'District Master', description: 'Complete missions in 4 different districts.', contractType: 'bounty', difficulty: 'medium', objectiveType: 'complete_missions', target: 4, objectiveRef: 'multi_district', repReward: 200 },
  { code: 'guild_bounty_socialite', title: 'Socialite', description: 'Qualifying interactions with 10 unique players.', contractType: 'bounty', difficulty: 'hard', objectiveType: 'meet_players', target: 10, repReward: 350 },
  { code: 'guild_bounty_marathon', title: 'Mission Marathon', description: 'Complete 8 eligible missions.', contractType: 'bounty', difficulty: 'hard', objectiveType: 'complete_missions', target: 8, repReward: 400 },
  { code: 'guild_bounty_explorer', title: 'RugTown Explorer', description: 'Visit every major district.', contractType: 'bounty', difficulty: 'hard', objectiveType: 'visit_districts', target: 5, repReward: 450 },
  { code: 'guild_bounty_event_hunter', title: 'Event Hunter', description: 'Participate in 3 qualifying city events.', contractType: 'bounty', difficulty: 'medium', objectiveType: 'join_events', target: 3, repReward: 280 },
  { code: 'guild_bounty_legend', title: 'Guild Legend', description: 'Complete all daily contracts and one bounty this week.', contractType: 'bounty', difficulty: 'legendary', objectiveType: 'complete_missions', target: 1, objectiveRef: 'guild_legend', repReward: 750, minLevel: 5 },
];

/** Grace-friendly streak bonuses (additive REP on daily completion bonus). */
export const GUILD_STREAK_BONUSES: Record<number, number> = {
  3: 25,
  7: 60,
  14: 120,
  30: 250,
};

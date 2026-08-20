/**
 * DailyWeeklyMissionDirector.ts — 5 Daily & 3 Weekly Missions Assigner.
 * Resets deterministically at 00:00 UTC.
 * Daily Pool: 1 exploration, 1 social, 1 mission, 1 activity, 1 wildcard.
 * Weekly Pool: 3 high-point challenges.
 */

import type { MissionDefinition } from './MissionTypes';

export interface PeriodicMissionSlot {
  slotIndex: number;
  mission: MissionDefinition;
  completed: boolean;
  claimed: boolean;
  currentCount: number;
  targetCount: number;
}

export interface DailyAssignment {
  dateStr: string; // YYYY-MM-DD
  slots: PeriodicMissionSlot[];
}

export interface WeeklyAssignment {
  weekStr: string; // YYYY-Www
  slots: PeriodicMissionSlot[];
}

// ── Daily Mission Pools ──
const DAILY_EXPLORATION_POOL: MissionDefinition[] = [
  {
    id: 'daily_exp_fountain_survey',
    title: 'Daily: Spring Water Refresh',
    description: 'Visit Spring Water Fountain and inspect the central monument.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'fountain', kind: 'interact_landmark', targetId: 'fountain', label: 'Inspect Spring Water Fountain' }],
    rewardXp: 40,
    rewardRep: 8,
    rewardPoints: 50,
    unlocksNext: null,
  },
  {
    id: 'daily_exp_whale_survey',
    title: 'Daily: Whale Tower Watch',
    description: 'Inspect the iconic Whale Tower monument.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'whale', kind: 'interact_landmark', targetId: 'whale', label: 'Inspect Whale Tower' }],
    rewardXp: 40,
    rewardRep: 8,
    rewardPoints: 50,
    unlocksNext: null,
  },
  {
    id: 'daily_exp_hall_statues',
    title: 'Daily: Hall of Fame Respects',
    description: 'Visit the Hall of Fame and check the Top 3 champion statues.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'hall', kind: 'enter_building', targetId: 'hall-of-fame', label: 'Visit Hall of Fame' }],
    rewardXp: 45,
    rewardRep: 10,
    rewardPoints: 50,
    unlocksNext: null,
  },
];

const DAILY_SOCIAL_POOL: MissionDefinition[] = [
  {
    id: 'daily_soc_city_wave',
    title: 'Daily: Plaza Greeting',
    description: 'Send a wave or celebratory emote in public.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'emote', kind: 'use_emote', label: 'Use an emote' }],
    rewardXp: 35,
    rewardRep: 8,
    rewardPoints: 40,
    unlocksNext: null,
  },
  {
    id: 'daily_soc_public_chat',
    title: 'Daily: City Square Dispatch',
    description: 'Post an encouraging message in the global city chat.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'chat', kind: 'send_chat', label: 'Send a message in chat' }],
    rewardXp: 35,
    rewardRep: 8,
    rewardPoints: 40,
    unlocksNext: null,
  },
];

const DAILY_MISSION_POOL: MissionDefinition[] = [
  {
    id: 'daily_mis_lead_check',
    title: 'Daily: Notice Board Dispatch',
    description: 'Inspect the Notice Board and review active community leads.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'notice', kind: 'interact_landmark', targetId: 'notice', label: 'Inspect Notice Board' }],
    rewardXp: 40,
    rewardRep: 8,
    rewardPoints: 50,
    unlocksNext: null,
  },
  {
    id: 'daily_mis_milo_order',
    title: 'Daily: Milo Coffee Run',
    description: 'Visit Milo in the Coffee Shop for your daily briefing.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'coffee', kind: 'enter_building', targetId: 'coffee-shop', label: 'Enter Coffee Shop' }],
    rewardXp: 40,
    rewardRep: 8,
    rewardPoints: 50,
    unlocksNext: null,
  },
];

const DAILY_ACTIVITY_POOL: MissionDefinition[] = [
  {
    id: 'daily_act_active_walk',
    title: 'Daily: City Patrol',
    description: 'Log 500 active movement steps around RugTown.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'walk', kind: 'walk_distance', count: 500, label: 'Walk 500 paces' }],
    rewardXp: 45,
    rewardRep: 10,
    rewardPoints: 60,
    unlocksNext: null,
  },
  {
    id: 'daily_act_perimeter_jog',
    title: 'Daily: Perimeter Cardio',
    description: 'Log 750 paces along the city boulevards.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'easy',
    objectives: [{ id: 'walk', kind: 'walk_distance', count: 750, label: 'Walk 750 paces' }],
    rewardXp: 50,
    rewardRep: 12,
    rewardPoints: 75,
    unlocksNext: null,
  },
];

const DAILY_WILDCARD_POOL: MissionDefinition[] = [
  {
    id: 'daily_wild_interior_hop',
    title: 'Daily: Building Tour',
    description: 'Enter 2 different enterable buildings in RugTown.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'medium',
    objectives: [{ id: 'enter', kind: 'enter_building', count: 2, label: 'Enter 2 buildings' }],
    rewardXp: 55,
    rewardRep: 12,
    rewardPoints: 75,
    unlocksNext: null,
  },
  {
    id: 'daily_wild_event_scout',
    title: 'Daily: Event Scout',
    description: 'Participate in any ongoing city gathering or event.',
    chapterTitle: 'Daily Missions',
    category: 'daily',
    difficulty: 'medium',
    objectives: [{ id: 'event', kind: 'join_city_event', label: 'Join a City Event' }],
    rewardXp: 60,
    rewardRep: 15,
    rewardPoints: 80,
    unlocksNext: null,
  },
];

// ── Weekly Mission Pool (3 high-point challenges) ──
const WEEKLY_CHALLENGES_POOL: MissionDefinition[] = [
  {
    id: 'week_grand_marathon',
    title: 'Weekly: Grand Metropolis Marathon',
    description: 'Complete 3,000 active steps across RugTown this week.',
    chapterTitle: 'Weekly Challenges',
    category: 'weekly',
    difficulty: 'hard',
    objectives: [{ id: 'marathon', kind: 'walk_distance', count: 3000, label: 'Log 3,000 steps across the city' }],
    rewardXp: 250,
    rewardRep: 60,
    rewardPoints: 350,
    unlocksNext: null,
  },
  {
    id: 'week_district_conqueror',
    title: 'Weekly: Master of All Districts',
    description: 'Traverse 4 distinct districts and visit 4 public building interiors.',
    chapterTitle: 'Weekly Challenges',
    category: 'weekly',
    difficulty: 'hard',
    objectives: [
      { id: 'districts', kind: 'visit_any_of', targetIds: ['north', 'east', 'south', 'west'], count: 4, label: 'Traverse 4 districts' },
      { id: 'interiors', kind: 'enter_building', count: 4, label: 'Enter 4 building interiors' },
    ],
    rewardXp: 300,
    rewardRep: 75,
    rewardPoints: 400,
    unlocksNext: null,
  },
  {
    id: 'week_social_pillar',
    title: 'Weekly: Community Pillar',
    description: 'Engage in 5 public events or party activities and send 10 community waves.',
    chapterTitle: 'Weekly Challenges',
    category: 'weekly',
    difficulty: 'hard',
    objectives: [
      { id: 'events', kind: 'join_city_event', count: 3, label: 'Join 3 City Events' },
      { id: 'emotes', kind: 'use_emote', count: 5, label: 'Use 5 public emotes' },
    ],
    rewardXp: 350,
    rewardRep: 90,
    rewardPoints: 500,
    unlocksNext: null,
  },
];

function getUtcDayString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function getUtcWeekString(d: Date = new Date()): string {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  return `${d.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function hashSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export class DailyWeeklyMissionDirector {
  static getDailyMissions(dateStr: string = getUtcDayString()): MissionDefinition[] {
    const seed = hashSeed(dateStr);
    const exp = DAILY_EXPLORATION_POOL[seed % DAILY_EXPLORATION_POOL.length];
    const soc = DAILY_SOCIAL_POOL[(seed + 1) % DAILY_SOCIAL_POOL.length];
    const mis = DAILY_MISSION_POOL[(seed + 2) % DAILY_MISSION_POOL.length];
    const act = DAILY_ACTIVITY_POOL[(seed + 3) % DAILY_ACTIVITY_POOL.length];
    const wld = DAILY_WILDCARD_POOL[(seed + 4) % DAILY_WILDCARD_POOL.length];
    return [exp, soc, mis, act, wld];
  }

  static getWeeklyMissions(weekStr: string = getUtcWeekString()): MissionDefinition[] {
    return [...WEEKLY_CHALLENGES_POOL];
  }

  static getUtcDay(): string {
    return getUtcDayString();
  }

  static getUtcWeek(): string {
    return getUtcWeekString();
  }
}

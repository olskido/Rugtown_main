/**
 * TitleCatalog.ts — equippable cosmetic titles (Phase 10F).
 */

import type { TitleCategory, TitleRarity } from './types';

export interface TitleDef {
  id: string;
  displayName: string;
  description: string;
  rarity: TitleRarity;
  category: TitleCategory;
  /** Achievement or unlock that grants this title. */
  unlockAchievementId?: string;
  hidden: boolean;
  icon?: string;
}

export const TITLE_CATALOG: TitleDef[] = [
  {
    id: 'title_early_citizen',
    displayName: 'Early Citizen',
    description: 'Claimed your first fountain REP.',
    rarity: 'common',
    category: 'progression',
    unlockAchievementId: 'ach_first_rep',
    hidden: false,
    icon: '◆',
  },
  {
    id: 'title_spring_regular',
    displayName: 'Spring Water Regular',
    description: 'Discovered Spring Water Core.',
    rarity: 'common',
    category: 'exploration',
    unlockAchievementId: 'ach_district_spring',
    hidden: false,
  },
  {
    id: 'title_west_scholar',
    displayName: 'West District Scholar',
    description: 'Explored the West District.',
    rarity: 'common',
    category: 'exploration',
    unlockAchievementId: 'ach_district_west',
    hidden: false,
  },
  {
    id: 'title_market_wanderer',
    displayName: 'Market Wanderer',
    description: 'Found the Meme Market.',
    rarity: 'uncommon',
    category: 'exploration',
    unlockAchievementId: 'ach_landmark_market',
    hidden: false,
  },
  {
    id: 'title_alpha_seeker',
    displayName: 'Alpha Seeker',
    description: 'Entered the Alpha Lounge.',
    rarity: 'uncommon',
    category: 'exploration',
    unlockAchievementId: 'ach_interior_alpha',
    hidden: false,
  },
  {
    id: 'title_whale_watcher',
    displayName: 'Whale Watcher',
    description: 'Inspected the Whale Tower.',
    rarity: 'uncommon',
    category: 'events',
    unlockAchievementId: 'ach_landmark_whale',
    hidden: false,
  },
  {
    id: 'title_vault_visitor',
    displayName: 'Vault Visitor',
    description: 'Stepped into the Holder Vault.',
    rarity: 'rare',
    category: 'exploration',
    unlockAchievementId: 'ach_interior_vault',
    hidden: false,
  },
  {
    id: 'title_bridge_crosser',
    displayName: 'Bridge Crosser',
    description: 'Crossed the Main Bridge.',
    rarity: 'uncommon',
    category: 'exploration',
    unlockAchievementId: 'ach_landmark_bridge',
    hidden: false,
  },
  {
    id: 'title_arena_prospect',
    displayName: 'Arena Prospect',
    description: 'Reached the Arena Grounds.',
    rarity: 'rare',
    category: 'exploration',
    unlockAchievementId: 'ach_district_arena',
    hidden: false,
  },
  {
    id: 'title_town_explorer',
    displayName: 'Town Explorer',
    description: 'Visited all five districts.',
    rarity: 'epic',
    category: 'exploration',
    unlockAchievementId: 'ach_all_districts',
    hidden: false,
  },
  {
    id: 'title_mission_runner',
    displayName: 'Mission Runner',
    description: 'Completed five missions.',
    rarity: 'uncommon',
    category: 'missions',
    unlockAchievementId: 'ach_missions_5',
    hidden: false,
  },
  {
    id: 'title_social_butterfly',
    displayName: 'Social Butterfly',
    description: 'Met several real players in town.',
    rarity: 'rare',
    category: 'social',
    unlockAchievementId: 'ach_social_5',
    hidden: false,
  },
  {
    id: 'title_event_regular',
    displayName: 'Event Regular',
    description: 'Joined multiple city events.',
    rarity: 'rare',
    category: 'events',
    unlockAchievementId: 'ach_events_3',
    hidden: false,
  },
  {
    id: 'title_rug_survivor',
    displayName: 'Rug Survivor',
    description: 'Reached level 10.',
    rarity: 'epic',
    category: 'progression',
    unlockAchievementId: 'ach_level_10',
    hidden: false,
  },
  {
    id: 'title_founder',
    displayName: 'Founder',
    description: 'Reached level 25 — a town cornerstone.',
    rarity: 'legendary',
    category: 'special',
    unlockAchievementId: 'ach_level_25',
    hidden: false,
  },
  {
    id: 'title_new_citizen',
    displayName: 'New Citizen',
    description: 'Finished RugTown onboarding.',
    rarity: 'common',
    category: 'progression',
    unlockAchievementId: 'ach_onboarding_complete',
    hidden: false,
    icon: '◆',
  },
  {
    id: 'title_market_scout',
    displayName: 'Market Scout',
    description: 'Learned the market beat.',
    rarity: 'uncommon',
    category: 'exploration',
    unlockAchievementId: 'ach_hall_candidate',
    hidden: false,
  },
  {
    id: 'title_event_runner',
    displayName: 'Event Runner',
    description: 'Joined city events with intent.',
    rarity: 'uncommon',
    category: 'events',
    unlockAchievementId: 'ach_first_city_event',
    hidden: false,
  },
  {
    id: 'title_party_player',
    displayName: 'Party Player',
    description: 'Completed a crew action.',
    rarity: 'uncommon',
    category: 'social',
    unlockAchievementId: 'ach_party_mission',
    hidden: false,
  },
];

export function getTitle(id: string): TitleDef | undefined {
  return TITLE_CATALOG.find((t) => t.id === id);
}

export function titleDisplayName(id: string | null | undefined): string | null {
  if (!id) return null;
  return getTitle(id)?.displayName ?? null;
}

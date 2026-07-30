/**
 * BuildingRegistry — interaction metadata for every major landmark.
 * Coordinates stay in WorldObjects; this file owns gameplay wiring.
 */

import { WORLD_OBJECTS, type WorldObject } from './WorldObjects';

export type BuildingUiPanel =
  | 'fountain'
  | 'notice'
  | 'market'
  | 'fame'
  | 'whale'
  | 'bridge'
  | 'alpha'
  | 'cashback'
  | 'arena'
  | 'generic'
  | 'locked'
  | 'coming_soon';

export interface BuildingRegistryEntry {
  id: string;
  displayName: string;
  district: string;
  interactionLive: boolean;
  access: 'open' | 'locked' | 'coming_soon' | 'exterior_only';
  uiPanel: BuildingUiPanel;
  npcRoles: string[];
  linkedMissionHints: string[];
  summary: string;
  lockedMessage?: string;
}

const BY_ID: Record<string, Omit<BuildingRegistryEntry, 'id' | 'displayName'>> = {
  fountain: {
    district: 'spring_core',
    interactionLive: true,
    access: 'open',
    uiPanel: 'fountain',
    npcRoles: ['starter_guide'],
    linkedMissionHints: ['ch1_new_face', 'daily_visit_spring'],
    summary: 'Spawn fountain — claim daily REP and gather for events.',
  },
  notice: {
    district: 'spring_core',
    interactionLive: true,
    access: 'open',
    uiPanel: 'notice',
    npcRoles: ['notice_guide'],
    linkedMissionHints: ['ch1_milo_heard'],
    summary: 'Mission hub + live market notices.',
  },
  coffee: {
    district: 'spring_core',
    interactionLive: true,
    access: 'open',
    uiPanel: 'generic',
    npcRoles: ['coffee_worker'],
    linkedMissionHints: ['ch1_notice_never_posted'],
    summary: 'Coffee Shop — enter for gossip and social missions.',
  },
  fame: {
    district: 'west',
    interactionLive: true,
    access: 'open',
    uiPanel: 'fame',
    npcRoles: [],
    linkedMissionHints: ['story_fame_visit'],
    summary: 'Hall of Fame — achievements, titles, standings.',
  },
  government: {
    district: 'west',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: ['government_official'],
    linkedMissionHints: ['story_vault_report'],
    summary: 'Civic announcements and weekly quest info.',
  },
  trading_academy: {
    district: 'west',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: ['academy_mentor'],
    linkedMissionHints: ['story_vault_clues'],
    summary: 'Training tips and tutorial knowledge.',
  },
  whale: {
    district: 'east',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'whale',
    npcRoles: ['whale_analyst'],
    linkedMissionHints: ['story_whale_visit', 'whale-alert'],
    summary: 'Whale alerts and rumour missions.',
  },
  financial_office: {
    district: 'east',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: [],
    linkedMissionHints: ['story_ledger_office'],
    summary: 'Progression statistics and ledger story stage.',
  },
  holder_bank: {
    district: 'east',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: [],
    linkedMissionHints: ['story_ledger_bank'],
    summary: 'Profile progression summary (no wallet).',
  },
  research_observatory: {
    district: 'west',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: ['observatory_researcher'],
    linkedMissionHints: [],
    summary: 'City event tracking and research clues.',
  },
  market: {
    district: 'east',
    interactionLive: true,
    access: 'open',
    uiPanel: 'market',
    npcRoles: ['market_trader'],
    linkedMissionHints: ['ch1_proof_not_panic', 'story_ledger_talk'],
    summary: 'Meme Market — events and market missions.',
  },
  market_shop: {
    district: 'east',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: ['market_trader'],
    linkedMissionHints: [],
    summary: 'Browse in-game items only — no purchases.',
  },
  tournament_hall: {
    district: 'east',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: ['arena_coordinator'],
    linkedMissionHints: ['story_arena_prep'],
    summary: 'Challenge records and weekly challenge desk.',
  },
  arena: {
    district: 'east',
    interactionLive: true,
    access: 'coming_soon',
    uiPanel: 'arena',
    npcRoles: ['arena_coordinator'],
    linkedMissionHints: ['story_arena_prep'],
    summary: 'Arena preview and training — no live tournament yet.',
    lockedMessage: 'Future Arena is coming soon.',
  },
  alpha: {
    district: 'west',
    interactionLive: true,
    access: 'open',
    uiPanel: 'alpha',
    npcRoles: ['alpha_informant'],
    linkedMissionHints: ['story_whale_rumour'],
    summary: 'Rumours and rank-flavoured lounge (no token gate).',
  },
  nft_gallery: {
    district: 'south',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: [],
    linkedMissionHints: [],
    summary: 'In-game artwork and cosmetic previews.',
  },
  nft_creator_studio: {
    district: 'south',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: [],
    linkedMissionHints: [],
    summary: 'Creator workshop — appearance tips.',
  },
  park: {
    district: 'south',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'generic',
    npcRoles: [],
    linkedMissionHints: [],
    summary: 'Park entrance — exploration and gatherings.',
  },
  bridge: {
    district: 'east',
    interactionLive: true,
    access: 'exterior_only',
    uiPanel: 'bridge',
    npcRoles: [],
    linkedMissionHints: ['party_twin_landmarks'],
    summary: 'District connector and party meeting point.',
  },
  cashback: {
    district: 'south',
    interactionLive: true,
    access: 'locked',
    uiPanel: 'cashback',
    npcRoles: [],
    linkedMissionHints: ['story_vault_investigate'],
    summary: 'Intentionally locked vault with story interaction.',
    lockedMessage: 'Holder Cashback Vault is locked until $RUGTOWN holder perks go live.',
  },
};

export function getBuildingRegistry(): BuildingRegistryEntry[] {
  return WORLD_OBJECTS.map((obj) => toEntry(obj));
}

export function getBuildingEntry(id: string): BuildingRegistryEntry | undefined {
  const obj = WORLD_OBJECTS.find((o) => o.id === id);
  return obj ? toEntry(obj) : undefined;
}

function toEntry(obj: WorldObject): BuildingRegistryEntry {
  const meta = BY_ID[obj.id];
  if (!meta) {
    return {
      id: obj.id,
      displayName: obj.displayName,
      district: 'unknown',
      interactionLive: true,
      access: 'exterior_only',
      uiPanel: 'generic',
      npcRoles: [],
      linkedMissionHints: [],
      summary: obj.futureDescription,
    };
  }
  return {
    id: obj.id,
    displayName: obj.displayName,
    ...meta,
  };
}

export function assertAllBuildingsRegistered(): string[] {
  return WORLD_OBJECTS.filter((o) => !BY_ID[o.id]).map((o) => o.id);
}

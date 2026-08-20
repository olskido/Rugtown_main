/**
 * Shared mission type surface for Chapter One, story arcs, and event bridging.
 * Period (daily/weekly) missions keep their own catalog in PeriodMissions.ts.
 */

export type MissionCategory =
  | 'exploration'
  | 'social'
  | 'discovery'
  | 'activity'
  | 'landmark'
  | 'challenge'
  | 'chain'
  | 'event'
  | 'hidden'
  | 'daily'
  | 'weekly'
  | 'milestone'
  | 'onboarding'
  | 'story'
  | 'party'
  | 'city_event'
  | 'achievement'
  | 'EXPLORATION'
  | 'SOCIAL'
  | 'DISCOVERY'
  | 'ACTIVITY'
  | 'LANDMARK'
  | 'CHALLENGE'
  | 'CHAIN'
  | 'EVENT'
  | 'HIDDEN'
  | 'DAILY'
  | 'WEEKLY'
  | 'MILESTONE';

export type ObjectiveKind =
  | 'enter_building'
  | 'talk_town_crier'
  | 'visit_landmark'
  | 'interact_landmark'
  | 'talk_npc_role'
  | 'open_panel'
  | 'customize_character'
  | 'send_chat'
  | 'use_emote'
  | 'meet_player_or_fallback'
  | 'join_city_event'
  | 'party_or_solo_action'
  | 'visit_any_of'
  | 'accept_mission'
  | 'walk_distance'
  | 'hidden_discovery';

export interface MissionObjectiveDef {
  id: string;
  kind: ObjectiveKind;
  /** Landmark / building / NPC role / panel id */
  targetId?: string;
  /** For visit_any_of */
  targetIds?: string[];
  /** Required count (default 1) */
  count?: number;
  label: string;
}

export interface MissionDefinition {
  id: string;
  title: string;
  description: string;
  chapterTitle: string;
  category: MissionCategory;
  difficulty: 'easy' | 'medium' | 'hard';
  objectives: MissionObjectiveDef[];
  objectiveHint?: string;
  rewardXp: number;
  rewardRep: number;
  rewardPoints?: number;
  isHidden?: boolean;
  discoveryTrigger?: string;
  /** Extra cosmetic / title unlock ids (client display; server grants via catalog) */
  titleUnlockId?: string | null;
  achievementProgressId?: string | null;
  unlocksNext: string | null;
  minimumLevel?: number;
  buildingDestination?: string | null;
  npcDestination?: string | null;
  district?: string | null;
}

export interface MissionObjectiveProgress {
  id: string;
  label: string;
  kind: ObjectiveKind;
  current: number;
  target: number;
  done: boolean;
}

export interface MissionProgress {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  chapterTitle: string;
  objectiveHint?: string;
  rewardXp: number;
  rewardRep: number;
  rewardPoints?: number;
  isHidden?: boolean;
  discovered?: boolean;
  objectives: MissionObjectiveProgress[];
  category: MissionCategory;
}

export type GameplayEventType =
  | 'PLAYER_MOVED'
  | 'BUILDING_ENTERED'
  | 'BUILDING_INTERACTED'
  | 'LANDMARK_VISITED'
  | 'LANDMARK_INTERACTED'
  | 'NPC_INTERACTED'
  | 'TOWN_CRIER_TALKED'
  | 'DISTRICT_ENTERED'
  | 'CHAT_SENT'
  | 'EMOTE_USED'
  | 'PLAYER_MET'
  | 'PARTY_JOINED'
  | 'PARTY_ACTION'
  | 'CITY_EVENT_JOINED'
  | 'APPEARANCE_SAVED'
  | 'PANEL_OPENED'
  | 'MISSION_ACCEPTED'
  | 'INTERIOR_ENTERED';

export interface GameplayEvent {
  type: GameplayEventType;
  buildingId?: string;
  landmarkId?: string;
  npcRole?: string;
  npcName?: string;
  districtId?: string;
  panelId?: string;
  eventId?: string;
  distancePx?: number;
  at?: number;
}

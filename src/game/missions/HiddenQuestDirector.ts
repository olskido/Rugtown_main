/**
 * HiddenQuestDirector.ts — Dynamic Hidden Quest Discovery & Progression Engine.
 * Supports all 12 trigger types:
 * LOCATION, INTERACTION, SEQUENCE, SOCIAL, TIME, LEVEL, MISSION_COMPLETION,
 * NPC, EXPLORATION_COMBINATION, STREAK, EVENT, COMPOUND.
 *
 * State model: UNKNOWN (not in `discovered`) → DISCOVERED (in `discovered`,
 * not `completed`) → IN_PROGRESS (multi-objective quests only — objectives
 * partially satisfied) → COMPLETED (in `completed`).
 *
 * All quest targets reference REAL world-object ids / npc roles / building
 * ids (WorldObjects.ts, BuildingRegistry.ts, EnterableBuildings.ts) — the
 * original 5 canonical quests referenced ids that did not exist anywhere in
 * the world (bench_east, quest-archive-masonry, silent_wanderer,
 * mysterious_stranger), which meant they could never fire; those have been
 * retargeted to real landmarks/NPC roles below with equivalent flavor.
 *
 * Discovery/completion is client-detected (event-driven, same as
 * MissionSystem) but server-persisted and server-rewarded — see
 * src/lib/hiddenQuests.ts for the RPC calls GamePage makes on each
 * discovery/completion so a player never gets the same reward twice even
 * across sessions/devices.
 */

import type { GameplayEvent, MissionDefinition } from './MissionTypes';

export type HiddenTriggerType =
  | 'LOCATION'
  | 'INTERACTION'
  | 'SEQUENCE'
  | 'SOCIAL'
  | 'TIME'
  | 'LEVEL'
  | 'MISSION_COMPLETION'
  | 'NPC'
  | 'EXPLORATION_COMBINATION'
  | 'STREAK'
  | 'EVENT'
  | 'COMPOUND';

export interface HiddenTriggerCondition {
  locationId?: string;
  interactionTarget?: string;
  sequence?: string[];
  npcRole?: string;
  minLevel?: number;
  requiredMissionId?: string;
  timeOfDay?: 'night' | 'day' | 'any';
  /** SOCIAL: how many unique players must be met (PLAYER_MET events with distinct target). */
  socialCount?: number;
  /** EXPLORATION_COMBINATION: all of these landmark/building ids must be visited (any order). */
  requiredLandmarkIds?: string[];
  /** STREAK: minimum current daily streak. */
  minStreak?: number;
  /** EVENT: specific city event id (matches GameplayEvent.eventId). */
  eventId?: string;
  /** COMPOUND: every sub-condition must independently be satisfied. */
  compound?: Array<{ type: HiddenTriggerType; condition: HiddenTriggerCondition }>;
}

export interface HiddenQuestDefinition extends MissionDefinition {
  triggerType: HiddenTriggerType;
  triggerCondition: HiddenTriggerCondition;
  clueText: string;
}

/** Pushed in by GamePage whenever level/streak/mission-completion state changes — see setContext(). */
export interface HiddenQuestContext {
  level: number;
  streakCurrent: number;
  completedMissionIds: ReadonlySet<string>;
}

export const CANONICAL_HIDDEN_QUESTS: HiddenQuestDefinition[] = [
  {
    id: 'hq_empty_chair',
    title: 'The Empty Chair',
    description: 'A solitary bench sits facing the eastern horizon at the Park. Who sat here before the city rose?',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'medium',
    isHidden: true,
    triggerType: 'LOCATION',
    triggerCondition: { locationId: 'park' },
    clueText: 'Look for an undisturbed bench near the Park entrance.',
    objectives: [
      { id: 'sit_chair', kind: 'interact_landmark', targetId: 'park', label: 'Inspect the empty bench' },
    ],
    rewardXp: 120,
    rewardRep: 25,
    rewardPoints: 100,
    titleUnlockId: 'title_the_solitary_watcher',
    unlocksNext: null,
  },
  {
    id: 'hq_forgotten_door',
    title: 'The Forgotten Door',
    description: 'An ancient ironwood door embedded in the brickwork behind the Quest Archive.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    triggerType: 'INTERACTION',
    triggerCondition: { interactionTarget: 'cashback' },
    clueText: 'Check the rear exterior masonry of the Quest Archive.',
    objectives: [
      { id: 'touch_door', kind: 'interact_landmark', targetId: 'cashback', label: 'Unseal the Forgotten Door' },
    ],
    rewardXp: 150,
    rewardRep: 35,
    rewardPoints: 150,
    titleUnlockId: 'title_keymaster_of_rugtown',
    unlocksNext: null,
  },
  {
    id: 'hq_silent_npc',
    title: 'The Silent Trader',
    description: 'A trader at the Meme Market never speaks — only gestures at the ticker board.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'medium',
    isHidden: true,
    triggerType: 'NPC',
    triggerCondition: { npcRole: 'market_trader' },
    clueText: 'Seek the quiet figure who only gestures at the Meme Market ticker.',
    objectives: [
      { id: 'talk_trader', kind: 'talk_npc_role', targetId: 'market_trader', label: 'Approach the Silent Trader' },
    ],
    rewardXp: 140,
    rewardRep: 30,
    rewardPoints: 120,
    titleUnlockId: 'title_listener_in_the_shadows',
    unlocksNext: null,
  },
  {
    id: 'hq_three_signs',
    title: 'The Three Signs',
    description: 'Three historic plaques — Notice Board, Whale Tower, Spring Water — form an ancient civic riddle when read in order.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    triggerType: 'SEQUENCE',
    triggerCondition: { sequence: ['notice', 'whale', 'fountain'] },
    clueText: 'Observe the Notice Board, then Whale Tower, then touch Spring Water — in that order.',
    objectives: [
      { id: 'sign_1', kind: 'interact_landmark', targetId: 'notice', label: 'Read the First Sign (Notice Board)' },
      { id: 'sign_2', kind: 'interact_landmark', targetId: 'whale', label: 'Read the Second Sign (Whale Tower)' },
      { id: 'sign_3', kind: 'interact_landmark', targetId: 'fountain', label: 'Read the Third Sign (Spring Water)' },
    ],
    rewardXp: 200,
    rewardRep: 50,
    rewardPoints: 250,
    titleUnlockId: 'title_riddle_solver',
    unlocksNext: null,
  },
  {
    id: 'hq_the_stranger',
    title: 'The Midnight Barista',
    description: 'The barista at the Coffee Shop / Social Hub only shares the real menu after dark.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    triggerType: 'TIME',
    triggerCondition: { timeOfDay: 'night', locationId: 'coffee-shop', npcRole: 'coffee_worker' },
    clueText: 'Visit the Coffee Shop / Social Hub after dusk and speak with the barista.',
    objectives: [
      { id: 'meet_stranger', kind: 'talk_npc_role', targetId: 'coffee_worker', label: 'Speak with the barista after dark' },
    ],
    rewardXp: 250,
    rewardRep: 60,
    rewardPoints: 300,
    titleUnlockId: 'title_shadow_conspirator',
    unlocksNext: null,
  },
  {
    id: 'hq_market_watcher',
    title: 'A Face in the Crowd',
    description: 'Someone at the Meme Market is watching the same three players you keep bumping into.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'medium',
    isHidden: true,
    triggerType: 'SOCIAL',
    triggerCondition: { socialCount: 3 },
    clueText: 'Meet 3 different real players in the city.',
    objectives: [
      { id: 'meet_three', kind: 'meet_player_or_fallback', targetId: 'social', count: 3, label: 'Meet 3 unique players' },
    ],
    rewardXp: 130,
    rewardRep: 28,
    rewardPoints: 110,
    titleUnlockId: null,
    unlocksNext: null,
  },
  {
    id: 'hq_investigators_ledger',
    title: 'The Investigator’s Ledger',
    description: 'A weathered ledger surfaces once you’ve proven yourself capable of real investigation work.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    minimumLevel: 41,
    triggerType: 'LEVEL',
    triggerCondition: { minLevel: 41 },
    clueText: 'Reach the Investigator tier (Level 41).',
    objectives: [
      { id: 'reach_investigator', kind: 'interact_landmark', targetId: 'research_observatory', label: 'Claim the Ledger at the Observatory' },
    ],
    rewardXp: 320,
    rewardRep: 70,
    rewardPoints: 350,
    titleUnlockId: 'title_ledger_keeper',
    unlocksNext: null,
  },
  {
    id: 'hq_someone_was_here',
    title: 'Someone Was Here',
    description: 'A note, left by another new arrival, is tucked where you first proved yourself in RugTown.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'easy',
    isHidden: true,
    triggerType: 'MISSION_COMPLETION',
    triggerCondition: { requiredMissionId: 'ch1_new_face' },
    clueText: 'Finish your very first mission, then look around Spring Water again.',
    objectives: [
      { id: 'find_note', kind: 'interact_landmark', targetId: 'fountain', label: 'Find the note near Spring Water' },
    ],
    rewardXp: 80,
    rewardRep: 18,
    rewardPoints: 60,
    titleUnlockId: null,
    unlocksNext: null,
  },
  {
    id: 'hq_three_corners',
    title: 'Three Corners',
    description: 'Government Quarter, Trading Academy, and the Financial Office each hold one piece of the same old map.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'medium',
    isHidden: true,
    minimumLevel: 11,
    triggerType: 'EXPLORATION_COMBINATION',
    triggerCondition: { requiredLandmarkIds: ['government', 'trading_academy', 'financial_office'] },
    clueText: 'Visit Government Quarter, Trading Academy, and the Financial Office — order doesn’t matter.',
    objectives: [
      { id: 'corner_1', kind: 'visit_landmark', targetId: 'government', label: 'Visit Government Quarter' },
      { id: 'corner_2', kind: 'visit_landmark', targetId: 'trading_academy', label: 'Visit Trading Academy' },
      { id: 'corner_3', kind: 'visit_landmark', targetId: 'financial_office', label: 'Visit the Financial Office' },
    ],
    rewardXp: 180,
    rewardRep: 38,
    rewardPoints: 160,
    titleUnlockId: null,
    unlocksNext: null,
  },
  {
    id: 'hq_the_long_streak',
    title: 'The Long Way Around',
    description: 'Consistency has a way of revealing things impatience never finds.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'medium',
    isHidden: true,
    triggerType: 'STREAK',
    triggerCondition: { minStreak: 7 },
    clueText: 'Maintain a 7-day activity streak.',
    objectives: [
      { id: 'streak_reward', kind: 'interact_landmark', targetId: 'fame', label: 'Claim recognition at the Hall of Fame' },
    ],
    rewardXp: 220,
    rewardRep: 45,
    rewardPoints: 200,
    titleUnlockId: 'title_the_persistent',
    unlocksNext: null,
  },
  {
    id: 'hq_whispers_at_the_cafe',
    title: 'Whispers at the Café',
    description: 'City events draw a crowd — and crowds sometimes hide something worth noticing.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'easy',
    isHidden: true,
    triggerType: 'EVENT',
    triggerCondition: {},
    clueText: 'Participate in any live city event.',
    objectives: [
      { id: 'join_any_event', kind: 'join_city_event', label: 'Join a city event' },
    ],
    rewardXp: 90,
    rewardRep: 20,
    rewardPoints: 70,
    titleUnlockId: null,
    unlocksNext: null,
  },
  {
    id: 'hq_the_quiet_district',
    title: 'The Quiet District',
    description: 'Some players find the Arena loud. Regulars know it has a quiet side, but only once you’ve earned the right to notice.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    minimumLevel: 21,
    triggerType: 'COMPOUND',
    triggerCondition: {
      compound: [
        { type: 'LEVEL', condition: { minLevel: 21 } },
        { type: 'LOCATION', condition: { locationId: 'arena' } },
        { type: 'STREAK', condition: { minStreak: 3 } },
      ],
    },
    clueText: 'Reach level 21, keep a 3-day streak, and visit the Arena.',
    objectives: [
      { id: 'quiet_arena', kind: 'interact_landmark', targetId: 'arena', label: 'Find the quiet side of the Arena' },
    ],
    rewardXp: 260,
    rewardRep: 55,
    rewardPoints: 240,
    titleUnlockId: 'title_between_the_lines',
    unlocksNext: null,
  },
  {
    id: 'hq_message_in_gold',
    title: 'A Message in Gold',
    description: 'Word travels fast among players who’ve been around a while — someone always knows someone.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    minimumLevel: 11,
    triggerType: 'SOCIAL',
    triggerCondition: { socialCount: 10 },
    clueText: 'Meet 10 different real players over your time in RugTown.',
    objectives: [
      { id: 'meet_ten', kind: 'meet_player_or_fallback', targetId: 'social', count: 10, label: 'Meet 10 unique players' },
    ],
    rewardXp: 210,
    rewardRep: 42,
    rewardPoints: 190,
    titleUnlockId: 'title_well_connected',
    unlocksNext: null,
  },
  {
    id: 'hq_the_unmarked_door',
    title: 'The Unmarked Door',
    description: 'The NFT Creator Studio has a door with no handle and no sign — creators insist it has always been there.',
    chapterTitle: 'Hidden Lore',
    category: 'hidden',
    difficulty: 'hard',
    isHidden: true,
    minimumLevel: 31,
    triggerType: 'INTERACTION',
    triggerCondition: { interactionTarget: 'nft_creator_studio' },
    clueText: 'Interact with the NFT Creator Studio at Level 31 or above.',
    objectives: [
      { id: 'open_unmarked_door', kind: 'interact_landmark', targetId: 'nft_creator_studio', label: 'Push the unmarked door' },
    ],
    rewardXp: 300,
    rewardRep: 65,
    rewardPoints: 320,
    titleUnlockId: 'title_uncredited',
    unlocksNext: null,
  },
];

export interface HiddenQuestState {
  discoveredIds: string[];
  completedIds: string[];
  currentSequenceSteps: string[];
  /** Progress counters for multi-count triggers (SOCIAL socialCount, EXPLORATION_COMBINATION landmark set). */
  progressCounters: Record<string, string[]>;
}

export class HiddenQuestDirector {
  private discovered = new Set<string>();
  private completed = new Set<string>();
  private sequenceTracker: string[] = [];
  /** questId -> set of distinct progress markers (met-player ids, visited-landmark ids). */
  private progress = new Map<string, Set<string>>();
  private context: HiddenQuestContext = { level: 1, streakCurrent: 0, completedMissionIds: new Set() };

  constructor(initialDiscovered: string[] = [], initialCompleted: string[] = []) {
    for (const id of initialDiscovered) this.discovered.add(id);
    for (const id of initialCompleted) this.completed.add(id);
  }

  /** Called by GamePage whenever level/streak/mission-completion state changes. */
  setContext(context: Partial<HiddenQuestContext>): void {
    this.context = { ...this.context, ...context };
  }

  isDiscovered(id: string): boolean {
    return this.discovered.has(id);
  }

  isCompleted(id: string): boolean {
    return this.completed.has(id);
  }

  /** UNKNOWN | DISCOVERED | IN_PROGRESS | COMPLETED — see file header for the state model. */
  getStatus(id: string): 'UNKNOWN' | 'DISCOVERED' | 'IN_PROGRESS' | 'COMPLETED' {
    if (this.completed.has(id)) return 'COMPLETED';
    if (!this.discovered.has(id)) return 'UNKNOWN';
    const quest = CANONICAL_HIDDEN_QUESTS.find((q) => q.id === id);
    if (quest) {
      // SOCIAL/EXPLORATION_COMBINATION track partial progress via the
      // `progress` set (a count/landmark tally), not via `objectives.length`
      // — a SOCIAL quest like hq_market_watcher only ever declares one
      // objective entry even though it requires meeting 3 unique players, so
      // the objectives-length check below would never see it as in-progress.
      if (quest.triggerType === 'SOCIAL') {
        const need = quest.triggerCondition.socialCount ?? 1;
        const have = this.progress.get(id)?.size ?? 0;
        if (have > 0 && have < need) return 'IN_PROGRESS';
      } else if (quest.triggerType === 'EXPLORATION_COMBINATION') {
        const need = quest.triggerCondition.requiredLandmarkIds?.length ?? 0;
        const have = this.progress.get(id)?.size ?? 0;
        if (have > 0 && have < need) return 'IN_PROGRESS';
      } else if (quest.objectives.length > 1) {
        const done = quest.objectives.filter((o) => this.isObjectiveSatisfied(quest, o.id)).length;
        if (done > 0 && done < quest.objectives.length) return 'IN_PROGRESS';
      }
    }
    return 'DISCOVERED';
  }

  private isObjectiveSatisfied(quest: HiddenQuestDefinition, objectiveId: string): boolean {
    // Sequence-based quests track via sequenceTracker tail match (all-or-nothing);
    // combination-based quests track via the progress set for that quest.
    const set = this.progress.get(quest.id);
    if (!set) return false;
    const obj = quest.objectives.find((o) => o.id === objectiveId);
    return !!obj?.targetId && set.has(obj.targetId);
  }

  getDiscoveredQuests(): HiddenQuestDefinition[] {
    return CANONICAL_HIDDEN_QUESTS.filter((q) => this.discovered.has(q.id));
  }

  getCompletedQuests(): HiddenQuestDefinition[] {
    return CANONICAL_HIDDEN_QUESTS.filter((q) => this.completed.has(q.id));
  }

  getAllQuests(): HiddenQuestDefinition[] {
    return CANONICAL_HIDDEN_QUESTS;
  }

  /**
   * Process a GameplayEvent and check if any hidden quest trigger fires.
   * Returns the ids newly discovered AND the ids newly completed by this event
   * (single-objective quests discover+complete in the same call).
   */
  processEvent(event: GameplayEvent): { discovered: string[]; completed: string[] } {
    const newlyDiscovered: string[] = [];
    const newlyCompleted: string[] = [];

    // Track sequence triggers (e.g. landmarks touched in order)
    if (event.type === 'LANDMARK_INTERACTED' && event.landmarkId) {
      this.sequenceTracker.push(event.landmarkId);
      if (this.sequenceTracker.length > 6) this.sequenceTracker.shift();
    }

    for (const quest of CANONICAL_HIDDEN_QUESTS) {
      if (this.completed.has(quest.id)) continue;

      // SEQUENCE has no partial-match state (evaluateTrigger only recognizes a
      // full ordered tail match), so even with multiple `objectives` entries
      // it is all-or-nothing exactly like a single-objective quest — without
      // this, the event that completes the sequence would only mark it
      // DISCOVERED, and it would silently stall until some unrelated later
      // event happened to complete it.
      const singleShot =
        (quest.objectives.length <= 1 || quest.triggerType === 'SEQUENCE') &&
        quest.triggerType !== 'SOCIAL' &&
        quest.triggerType !== 'EXPLORATION_COMBINATION';

      if (!this.discovered.has(quest.id)) {
        if (this.evaluateTrigger(quest.triggerType, quest.triggerCondition, event, quest.id)) {
          this.discovered.add(quest.id);
          newlyDiscovered.push(quest.id);
          if (singleShot) {
            this.completed.add(quest.id);
            newlyCompleted.push(quest.id);
          }
        }
        continue;
      }

      // Already discovered, multi-step: keep evaluating until fully satisfied.
      if (!singleShot && this.evaluateTrigger(quest.triggerType, quest.triggerCondition, event, quest.id, true)) {
        this.completed.add(quest.id);
        newlyCompleted.push(quest.id);
      }
    }

    return { discovered: newlyDiscovered, completed: newlyCompleted };
  }

  /**
   * Evaluate one trigger condition against the current event/context.
   * `checkCompletion` — for multi-count/multi-landmark triggers, distinguishes
   * "should this be discovered" (first sighting) from "is it now fully done".
   */
  private evaluateTrigger(
    type: HiddenTriggerType,
    condition: HiddenTriggerCondition,
    event: GameplayEvent,
    questId: string,
    checkCompletion = false,
  ): boolean {
    switch (type) {
      case 'LOCATION':
        return (
          (event.type === 'LANDMARK_VISITED' || event.type === 'LANDMARK_INTERACTED') &&
          event.landmarkId === condition.locationId
        );

      case 'INTERACTION':
        return (
          event.type === 'LANDMARK_INTERACTED' &&
          (event.landmarkId === condition.interactionTarget || event.buildingId === condition.interactionTarget)
        );

      case 'NPC':
        return event.type === 'NPC_INTERACTED' && event.npcRole === condition.npcRole;

      case 'SEQUENCE': {
        const reqSeq = condition.sequence ?? [];
        if (reqSeq.length === 0 || this.sequenceTracker.length < reqSeq.length) return false;
        const tail = this.sequenceTracker.slice(-reqSeq.length);
        return tail.every((val, idx) => val === reqSeq[idx]);
      }

      case 'TIME': {
        if (condition.npcRole) {
          if (event.type !== 'NPC_INTERACTED' || event.npcRole !== condition.npcRole) return false;
        } else if (condition.locationId) {
          if (
            !(event.type === 'BUILDING_ENTERED' || event.type === 'INTERIOR_ENTERED') ||
            event.buildingId !== condition.locationId
          ) {
            return false;
          }
        } else {
          return false;
        }
        return isTimeOfDay(condition.timeOfDay ?? 'any');
      }

      case 'LEVEL':
        return this.context.level >= (condition.minLevel ?? Infinity);

      case 'MISSION_COMPLETION':
        return !!condition.requiredMissionId && this.context.completedMissionIds.has(condition.requiredMissionId);

      case 'STREAK':
        return this.context.streakCurrent >= (condition.minStreak ?? Infinity);

      case 'EVENT':
        return event.type === 'CITY_EVENT_JOINED' && (!condition.eventId || event.eventId === condition.eventId);

      case 'SOCIAL': {
        if (event.type !== 'PLAYER_MET') return false;
        const marker = event.landmarkId ?? event.npcName ?? String(event.at ?? Date.now());
        const set = this.progress.get(questId) ?? new Set<string>();
        set.add(marker);
        this.progress.set(questId, set);
        const need = condition.socialCount ?? 1;
        return checkCompletion ? set.size >= need : set.size >= 1;
      }

      case 'EXPLORATION_COMBINATION': {
        const required = condition.requiredLandmarkIds ?? [];
        if (required.length === 0) return false;
        const id = event.landmarkId ?? event.buildingId;
        if (
          id &&
          required.includes(id) &&
          (event.type === 'LANDMARK_VISITED' || event.type === 'LANDMARK_INTERACTED' || event.type === 'BUILDING_ENTERED')
        ) {
          const set = this.progress.get(questId) ?? new Set<string>();
          set.add(id);
          this.progress.set(questId, set);
        }
        const set = this.progress.get(questId);
        if (!set) return false;
        return checkCompletion ? required.every((r) => set.has(r)) : set.size >= 1;
      }

      case 'COMPOUND': {
        const subs = condition.compound ?? [];
        if (subs.length === 0) return false;
        // Every sub-condition must independently be true against current
        // context/state (not necessarily all satisfied by THIS single event —
        // level/streak are ambient state, location/social are progress sets).
        return subs.every((sub) => this.evaluateAmbient(sub.type, sub.condition, event, questId));
      }

      default:
        return false;
    }
  }

  /** Ambient (state-based, not just this-event-based) check used inside COMPOUND. */
  private evaluateAmbient(type: HiddenTriggerType, condition: HiddenTriggerCondition, event: GameplayEvent, questId: string): boolean {
    if (type === 'LEVEL') return this.context.level >= (condition.minLevel ?? Infinity);
    if (type === 'STREAK') return this.context.streakCurrent >= (condition.minStreak ?? Infinity);
    if (type === 'MISSION_COMPLETION') {
      return !!condition.requiredMissionId && this.context.completedMissionIds.has(condition.requiredMissionId);
    }
    if (type === 'LOCATION') {
      // For compound quests, treat "visited at some point" as tracked in this quest's progress set.
      const set = this.progress.get(questId) ?? new Set<string>();
      if (
        (event.type === 'LANDMARK_VISITED' || event.type === 'LANDMARK_INTERACTED') &&
        event.landmarkId === condition.locationId
      ) {
        set.add(condition.locationId!);
        this.progress.set(questId, set);
      }
      return condition.locationId != null && set.has(condition.locationId);
    }
    return this.evaluateTrigger(type, condition, event, questId, true);
  }

  markCompleted(id: string): void {
    this.discovered.add(id);
    this.completed.add(id);
  }

  getState(): HiddenQuestState {
    const progressCounters: Record<string, string[]> = {};
    for (const [k, v] of this.progress.entries()) progressCounters[k] = [...v];
    return {
      discoveredIds: [...this.discovered],
      completedIds: [...this.completed],
      currentSequenceSteps: [...this.sequenceTracker],
      progressCounters,
    };
  }

  restoreState(state: Partial<HiddenQuestState>): void {
    if (state.discoveredIds) this.discovered = new Set(state.discoveredIds);
    if (state.completedIds) this.completed = new Set(state.completedIds);
    if (state.currentSequenceSteps) this.sequenceTracker = [...state.currentSequenceSteps];
    if (state.progressCounters) {
      this.progress = new Map(Object.entries(state.progressCounters).map(([k, v]) => [k, new Set(v)]));
    }
  }
}

/** Local-time day/night split (20:00–06:00 = night) — matches the player's own clock, same as the rest of RugTown's ambient day/night systems. */
function isTimeOfDay(spec: 'night' | 'day' | 'any'): boolean {
  if (spec === 'any') return true;
  const hour = new Date().getHours();
  const isNight = hour >= 20 || hour < 6;
  return spec === 'night' ? isNight : !isNight;
}

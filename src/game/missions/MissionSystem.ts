import { getEnterableBuilding, getEnterableBuildingByWorldObjectId } from '../world/EnterableBuildings';
import { STARTER_MISSIONS } from '../missions/definitions/starterMissions';
import { STORY_MISSIONS } from '../missions/definitions/storyMissions';
import { LEVEL_TWO_MISSIONS, BRACKET_MISSIONS } from '../missions/definitions/bracketMissions';
import type {
  GameplayEvent,
  MissionDefinition,
  MissionObjectiveDef,
  MissionObjectiveProgress,
  MissionProgress,
} from '../missions/MissionTypes';

export type { MissionDefinition, MissionProgress } from '../missions/MissionTypes';
/** @deprecated legacy single-objective union — prefer ObjectiveKind */
export type MissionObjectiveType = 'enter_building' | 'talk_town_crier' | 'visit_landmark';

function objectiveTarget(obj: MissionObjectiveDef): number {
  return Math.max(1, obj.count ?? 1);
}

function progressKey(missionId: string, objectiveId: string): string {
  return `${missionId}::${objectiveId}`;
}

/**
 * Event-driven mission tracker for onboarding, 100-level tiers, and stories.
 * Does not scan the world each frame — consumes GameplayEvents only.
 */
export class MissionSystem {
  private readonly definitions: MissionDefinition[];
  private readonly completed = new Set<string>();
  private readonly objectiveCounts = new Map<string, number>();
  /** Distinct landmark visits for visit_any_of */
  private readonly distinctHits = new Map<string, Set<string>>();
  private walkDistanceAccum = 0;
  /**
   * Player's current level, used to gate which mission becomes "active".
   * Defaults to Infinity so a caller that never wires setPlayerLevel() keeps
   * the pre-existing purely-sequential behavior (no regression risk).
   */
  private playerLevel = Infinity;

  /** Called whenever the player's authoritative level changes (level-up, session hydration). */
  setPlayerLevel(level: number): void {
    if (Number.isFinite(level) && level > 0) this.playerLevel = level;
  }

  constructor(
    definitions: MissionDefinition[] = [
      ...STARTER_MISSIONS,
      ...LEVEL_TWO_MISSIONS,
      ...STORY_MISSIONS,
      ...BRACKET_MISSIONS,
    ],
  ) {
    this.definitions = definitions;
  }

  getMissions(): MissionProgress[] {
    return this.definitions.map((def) => this.toProgress(def));
  }

  restoreCompleted(ids: string[]): void {
    const knownIds = new Set(this.definitions.map((def) => def.id));
    this.completed.clear();
    for (const id of ids) if (knownIds.has(id)) this.completed.add(id);
  }

  /** Restore objective progress maps from persistence. */
  restoreObjectiveCounts(entries: Array<{ key: string; value: number }>): void {
    this.objectiveCounts.clear();
    for (const e of entries) {
      if (typeof e.key === 'string' && Number.isFinite(e.value) && e.value > 0) {
        this.objectiveCounts.set(e.key, Math.floor(e.value));
      }
    }
  }

  getObjectiveCountSnapshot(): Array<{ key: string; value: number }> {
    return [...this.objectiveCounts.entries()].map(([key, value]) => ({ key, value }));
  }

  getCompletedIds(): string[] {
    return this.definitions.filter((def) => this.completed.has(def.id)).map((def) => def.id);
  }

  getActiveMission(): MissionProgress | null {
    const def = this.getActiveDefinition();
    return def ? this.toProgress(def) : null;
  }

  getActiveMissionId(): string | null {
    return this.getActiveMission()?.id ?? null;
  }

  getHighlightedZoneId(): string | null {
    const next = this.getActiveDefinition();
    if (!next) return null;
    const dest = next.buildingDestination;
    if (dest) return dest;
    for (const obj of next.objectives) {
      if (obj.kind === 'talk_town_crier') return null;
      if (obj.targetId && (obj.kind === 'visit_landmark' || obj.kind === 'interact_landmark')) {
        return obj.targetId;
      }
      if (obj.kind === 'enter_building' && obj.targetId) {
        return getEnterableBuilding(obj.targetId)?.worldObjectId ?? null;
      }
      if (obj.targetIds?.length) return obj.targetIds[0];
    }
    return null;
  }

  isComplete(): boolean {
    return this.definitions.every((d) => this.completed.has(d.id));
  }

  isOnboardingComplete(): boolean {
    return STARTER_MISSIONS.every((d) => this.completed.has(d.id));
  }

  /** Primary event sink — prefer this over mark* helpers. */
  handleEvent(event: GameplayEvent): boolean {
    const active = this.getActiveDefinition();
    if (!active) return false;
    let changed = false;

    for (const obj of active.objectives) {
      if (this.isObjectiveDone(active.id, obj)) continue;
      const before = this.getCount(active.id, obj.id);
      this.applyEventToObjective(active, obj, event);
      if (this.getCount(active.id, obj.id) !== before) changed = true;
    }

    if (changed && this.areAllObjectivesDone(active)) {
      return this.complete(active.id);
    }
    return changed;
  }

  markBuildingEntered(buildingId: string): boolean {
    return this.handleEvent({ type: 'BUILDING_ENTERED', buildingId });
  }

  markZoneVisited(zoneId: string): boolean {
    const building = getEnterableBuildingByWorldObjectId(zoneId);
    let changed = this.handleEvent({ type: 'LANDMARK_VISITED', landmarkId: zoneId });
    if (building) {
      changed = this.handleEvent({ type: 'BUILDING_ENTERED', buildingId: building.id }) || changed;
    }
    return changed;
  }

  markLandmarkInteracted(landmarkId: string): boolean {
    return this.handleEvent({ type: 'LANDMARK_INTERACTED', landmarkId });
  }

  markTownCrierTalked(): boolean {
    return this.handleEvent({ type: 'TOWN_CRIER_TALKED' });
  }

  private applyEventToObjective(
    mission: MissionDefinition,
    obj: MissionObjectiveDef,
    event: GameplayEvent,
  ): void {
    const key = progressKey(mission.id, obj.id);
    const bump = (n = 1) => {
      const cur = this.objectiveCounts.get(key) ?? 0;
      this.objectiveCounts.set(key, Math.min(objectiveTarget(obj), cur + n));
    };

    switch (obj.kind) {
      case 'enter_building':
        if (
          (event.type === 'BUILDING_ENTERED' || event.type === 'INTERIOR_ENTERED') &&
          event.buildingId === obj.targetId
        ) {
          bump();
        }
        break;
      case 'talk_town_crier':
        if (event.type === 'TOWN_CRIER_TALKED') bump();
        break;
      case 'visit_landmark':
        if (
          (event.type === 'LANDMARK_VISITED' || event.type === 'LANDMARK_INTERACTED') &&
          event.landmarkId === obj.targetId
        ) {
          bump();
        }
        break;
      case 'interact_landmark':
        if (
          (event.type === 'LANDMARK_INTERACTED' || event.type === 'BUILDING_INTERACTED') &&
          (event.landmarkId === obj.targetId || event.buildingId === obj.targetId)
        ) {
          bump();
        }
        break;
      case 'talk_npc_role':
        if (
          event.type === 'NPC_INTERACTED' &&
          (event.npcRole === obj.targetId ||
            (!event.npcRole && obj.targetId === 'citizen'))
        ) {
          bump();
        }
        break;
      case 'open_panel':
        if (event.type === 'PANEL_OPENED' && event.panelId === obj.targetId) bump();
        break;
      case 'customize_character':
        if (event.type === 'APPEARANCE_SAVED') bump();
        break;
      case 'send_chat':
        if (event.type === 'CHAT_SENT') bump();
        break;
      case 'use_emote':
        if (event.type === 'EMOTE_USED') bump();
        break;
      case 'meet_player_or_fallback':
        if (event.type === 'PLAYER_MET' || event.type === 'NPC_INTERACTED') bump();
        break;
      case 'join_city_event':
        if (event.type === 'CITY_EVENT_JOINED') bump();
        break;
      case 'party_or_solo_action':
        if (event.type === 'PARTY_ACTION' || event.type === 'PARTY_JOINED') bump();
        break;
      case 'accept_mission':
        if (event.type === 'MISSION_ACCEPTED' || (event.type === 'PANEL_OPENED' && event.panelId === 'notice')) {
          bump();
        }
        break;
      case 'visit_any_of': {
        const id = event.landmarkId ?? event.buildingId;
        if (!id || !obj.targetIds?.includes(id)) break;
        if (!(event.type === 'LANDMARK_VISITED' || event.type === 'LANDMARK_INTERACTED' || event.type === 'BUILDING_INTERACTED')) {
          break;
        }
        const setKey = progressKey(mission.id, obj.id);
        let set = this.distinctHits.get(setKey);
        if (!set) {
          set = new Set();
          this.distinctHits.set(setKey, set);
        }
        set.add(id);
        this.objectiveCounts.set(setKey, set.size);
        break;
      }
      case 'walk_distance':
        if (event.type === 'PLAYER_MOVED' && typeof event.distancePx === 'number') {
          this.walkDistanceAccum += event.distancePx;
          const need = objectiveTarget(obj);
          this.objectiveCounts.set(key, Math.min(need, Math.floor(this.walkDistanceAccum)));
        }
        break;
      default:
        break;
    }
  }

  private getCount(missionId: string, objectiveId: string): number {
    return this.objectiveCounts.get(progressKey(missionId, objectiveId)) ?? 0;
  }

  private isObjectiveDone(missionId: string, obj: MissionObjectiveDef): boolean {
    return this.getCount(missionId, obj.id) >= objectiveTarget(obj);
  }

  private areAllObjectivesDone(mission: MissionDefinition): boolean {
    return mission.objectives.every((o) => this.isObjectiveDone(mission.id, o));
  }

  private toProgress(def: MissionDefinition): MissionProgress {
    const objectives: MissionObjectiveProgress[] = def.objectives.map((o) => {
      const current = this.getCount(def.id, o.id);
      const target = objectiveTarget(o);
      return {
        id: o.id,
        label: o.label,
        kind: o.kind,
        current: Math.min(current, target),
        target,
        done: current >= target || this.completed.has(def.id),
      };
    });
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      completed: this.completed.has(def.id),
      chapterTitle: def.chapterTitle,
      objectiveHint: def.objectiveHint,
      rewardXp: def.rewardXp,
      rewardRep: def.rewardRep,
      rewardPoints: def.rewardPoints ?? Math.max(10, Math.floor(def.rewardXp * 0.5)),
      isHidden: def.isHidden,
      discovered: true,
      objectives,
      category: def.category,
    };
  }

  private complete(id: string): boolean {
    if (this.completed.has(id)) return false;
    if (this.getActiveDefinition()?.id !== id) return false;
    this.completed.add(id);
    return true;
  }

  private getActiveDefinition(): MissionDefinition | undefined {
    // Catalogs are ordered; the first incomplete mission the player's level
    // actually qualifies for is active. A mission whose minimumLevel exceeds
    // the player's current level is skipped over (not just "next up") so a
    // low-level player is never assigned endgame-bracket content they can't
    // possibly attempt yet — see MissionDefinition.minimumLevel.
    return this.definitions.find(
      (def) => !this.completed.has(def.id) && (def.minimumLevel == null || this.playerLevel >= def.minimumLevel),
    );
  }

  /** True if at least one remaining (incomplete) mission is level-locked above the player's current level. */
  hasLevelLockedContent(): boolean {
    return this.definitions.some(
      (def) => !this.completed.has(def.id) && def.minimumLevel != null && this.playerLevel < def.minimumLevel,
    );
  }
}

export function createStarterMissionSystem(): MissionSystem {
  return new MissionSystem([
    ...STARTER_MISSIONS,
    ...LEVEL_TWO_MISSIONS,
    ...STORY_MISSIONS,
    ...BRACKET_MISSIONS,
  ]);
}

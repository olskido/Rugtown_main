/**
 * progress.ts
 * ───────────
 * Local, offline-first persistence for the RugTown gameplay loop (Phase 5).
 *
 * Saves the player's core progression to localStorage so it survives reloads
 * even for guests:
 *   - rep                (reputation points)
 *   - completedMissions  (mission ids that are done — stay done forever)
 *   - visitedInteriors   (building ids the player has stepped inside)
 *   - activeMission      (the mission currently being tracked)
 *
 * Phase 10F: account XP/level/titles/achievements live in
 * `rugtown:progression:v1:<playerId>` via ProgressionRepository.
 * On first load, that store migrates REP + interiors + missions from this
 * legacy blob without resetting balances. This file remains the shared
 * cache for mission/interior IDs and a REP mirror for older readers.
 *
 * For logged-in users, REP is still synced to Supabase separately; this local
 * copy is a fast cache + the source of truth for guests. All access is guarded
 * so a corrupt entry or a missing `window` never throws.
 */

export interface RugtownProgress {
  rep: number;
  completedMissions: string[];
  visitedInteriors: string[];
  activeMission: string | null;
  /** Local cache only — server (hidden_quest_state table) is authoritative for logged-in players. */
  hiddenQuestsDiscovered: string[];
  hiddenQuestsCompleted: string[];
}

const STORAGE_KEY = 'rugtown:progress:v1';

const DEFAULT_PROGRESS: RugtownProgress = {
  rep: 0,
  completedMissions: [],
  visitedInteriors: [],
  activeMission: null,
  hiddenQuestsDiscovered: [],
  hiddenQuestsCompleted: [],
};

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Load the saved progress, falling back to sane defaults on any error. */
export function loadProgress(): RugtownProgress {
  if (!hasStorage()) return { ...DEFAULT_PROGRESS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROGRESS };
    const parsed = JSON.parse(raw) as Partial<RugtownProgress>;
    return {
      rep: typeof parsed.rep === 'number' && Number.isFinite(parsed.rep) ? parsed.rep : 0,
      completedMissions: Array.isArray(parsed.completedMissions)
        ? parsed.completedMissions.filter((x): x is string => typeof x === 'string')
        : [],
      visitedInteriors: Array.isArray(parsed.visitedInteriors)
        ? parsed.visitedInteriors.filter((x): x is string => typeof x === 'string')
        : [],
      activeMission: typeof parsed.activeMission === 'string' ? parsed.activeMission : null,
      hiddenQuestsDiscovered: Array.isArray(parsed.hiddenQuestsDiscovered)
        ? parsed.hiddenQuestsDiscovered.filter((x): x is string => typeof x === 'string')
        : [],
      hiddenQuestsCompleted: Array.isArray(parsed.hiddenQuestsCompleted)
        ? parsed.hiddenQuestsCompleted.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

/** Overwrite the saved progress. Silently ignores storage failures. */
export function saveProgress(progress: RugtownProgress): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* quota / private mode — ignore, gameplay continues in-memory */
  }
}

/**
 * Merge a partial update into the saved progress and persist it. Returns the
 * merged result. Load-merge-save keeps concurrent writers (WorldScene saving
 * missions, GamePage saving REP) from clobbering each other's fields.
 */
export function patchProgress(patch: Partial<RugtownProgress>): RugtownProgress {
  const merged: RugtownProgress = { ...loadProgress(), ...patch };
  saveProgress(merged);
  return merged;
}

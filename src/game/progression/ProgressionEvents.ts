/**
 * ProgressionEvents.ts — typed progression event bus (Phase 10F).
 */

export type ProgressionEventType =
  | 'mission_completed'
  | 'landmark_discovered'
  | 'district_discovered'
  | 'interior_entered'
  | 'player_interacted'
  | 'city_event_joined'
  | 'fountain_claimed'
  | 'wave_sent'
  | 'rep_awarded'
  | 'xp_awarded'
  | 'points_awarded'
  | 'streak_advanced'
  | 'level_up'
  | 'achievement_unlocked'
  | 'title_unlocked'
  | 'title_equipped'
  | 'discovery_notified';

export interface ProgressionEvent {
  type: ProgressionEventType;
  at: number;
  payload: Record<string, unknown>;
}

type Listener = (event: ProgressionEvent) => void;

class ProgressionEventBus {
  private listeners = new Set<Listener>();
  private latest: ProgressionEvent | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type: ProgressionEventType, payload: Record<string, unknown> = {}): void {
    const event: ProgressionEvent = { type, at: Date.now(), payload };
    this.latest = event;
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* UI listeners must not break awards */
      }
    }
  }

  getLatest(): ProgressionEvent | null {
    return this.latest;
  }
}

export const progressionEvents = new ProgressionEventBus();

/**
 * Thin typed event helpers — Phaser / React emit GameplayEvents;
 * MissionSystem consumes them without scanning the world each frame.
 */

import type { GameplayEvent, GameplayEventType } from './MissionTypes';

export type MissionEventListener = (event: GameplayEvent) => void;

export class MissionEventBridge {
  private listeners = new Set<MissionEventListener>();

  subscribe(listener: MissionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: GameplayEvent): void {
    const payload: GameplayEvent = { ...event, at: event.at ?? Date.now() };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        /* never let mission listeners crash gameplay */
      }
    }
  }

  emitType(type: GameplayEventType, extra: Omit<GameplayEvent, 'type'> = {}): void {
    this.emit({ type, ...extra });
  }
}

/** Shared bridge instance for the active game session (set by WorldScene). */
let activeBridge: MissionEventBridge | null = null;

export function setActiveMissionBridge(bridge: MissionEventBridge | null): void {
  activeBridge = bridge;
}

export function getActiveMissionBridge(): MissionEventBridge | null {
  return activeBridge;
}

export function emitGameplayEvent(event: GameplayEvent): void {
  activeBridge?.emit(event);
}

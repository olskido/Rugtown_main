/**
 * src/lib/presence.ts
 * ───────────────────
 * Supabase Realtime presence helpers for the RugTown city channel.
 *
 * Production (Vercel) and localhost share this path. Failures on Vercel are
 * usually missing build-time VITE_SUPABASE_* or auth JWT not applied before
 * subscribe — never hardcode origins here.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from './supabase';
import type { PresenceAppearance, PresencePayload } from './presenceTypes';

export type { PresenceAppearance, PresencePayload };

/** Live online-count state for landing page / HUD. */
export type PresenceCountState =
  | { status: 'unavailable' }
  | { status: 'connecting' }
  | { status: 'connected'; count: number };

/** Shared city presence / broadcast topic (public channel). */
export const CITY_TOPIC = 'rugtown:city';

const IS_DEV = import.meta.env.DEV;

function presenceLog(message: string, extra?: Record<string, unknown>): void {
  if (!IS_DEV) return;
  if (extra) console.info(`[presence] ${message}`, extra);
  else console.info(`[presence] ${message}`);
}

function isCityTopic(topic: string): boolean {
  return (
    topic === CITY_TOPIC
    || topic === `realtime:${CITY_TOPIC}`
    || topic.endsWith(`:${CITY_TOPIC}`)
  );
}

/**
 * Remove city-topic channels. Prefer removing only `except` when provided
 * so a landing observer retry cannot wipe an active game channel.
 */
function removeStaleCityChannels(except?: RealtimeChannel | null): void {
  if (!supabase) return;
  for (const ch of supabase.getChannels()) {
    if (except && ch === except) continue;
    if (isCityTopic(ch.topic ?? '')) {
      supabase.removeChannel(ch);
    }
  }
}

/**
 * Apply the current session JWT to the Realtime socket and wait for it.
 * Critical for signed-in multiplayer on production networks.
 */
export async function syncRealtimeAuth(): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      await supabase.realtime.setAuth(session.access_token);
      presenceLog('realtime auth set', { hasSession: true });
      return true;
    }
    presenceLog('realtime auth anon', { hasSession: false });
    return false;
  } catch (err) {
    presenceLog('realtime auth failed', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}

/**
 * Create the city Realtime channel for presence + chat/emote broadcast.
 * @param presenceKey Stable id for this client (auth user id or guest_…).
 */
export function createCityChannel(presenceKey: string): RealtimeChannel | null {
  if (!isSupabaseConfigured || !supabase) return null;
  removeStaleCityChannels();
  presenceLog('create channel', { topic: CITY_TOPIC, keyPrefix: presenceKey.slice(0, 8) });
  return supabase.channel(CITY_TOPIC, {
    config: {
      private: false,
      broadcast: { self: false },
      presence: { key: presenceKey },
    },
  });
}

/**
 * Fully remove a city channel from the client registry (not just unsubscribe).
 */
export function removeCityChannel(channel: RealtimeChannel | null): void {
  if (!supabase || !channel) return;
  supabase.removeChannel(channel);
}

/**
 * Flatten presence state into payloads. Uses the Realtime presence key as
 * `id` when the meta blob omits it (common for JWT-keyed authenticated peers).
 */
export function flattenPresenceState(
  state: Record<string, PresencePayload[] | undefined>,
): PresencePayload[] {
  const out: PresencePayload[] = [];
  for (const [key, metas] of Object.entries(state)) {
    if (!metas?.length) continue;
    for (const meta of metas) {
      if (!meta || typeof meta !== 'object') continue;
      const id = (typeof meta.id === 'string' && meta.id.length > 0) ? meta.id : key;
      out.push({
        ...meta,
        id,
        username: meta.username || 'Degen',
        x: Number(meta.x) || 0,
        y: Number(meta.y) || 0,
        appearance: meta.appearance,
        rep: Number(meta.rep) || 0,
        holderTier: meta.holderTier || 'None',
      });
    }
  }
  return out;
}

/**
 * Subscribe to the city presence channel and report the live player count.
 * Read-only observer for the landing page — does not track a player body.
 */
export function subscribeCityPresenceCount(
  onUpdate: (state: PresenceCountState) => void,
): () => void {
  if (!isSupabaseConfigured || !supabase) {
    onUpdate({ status: 'unavailable' });
    return () => {};
  }

  const observerKey = `observer_${Math.random().toString(36).slice(2, 10)}`;
  let current: RealtimeChannel | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let generation = 0;

  onUpdate({ status: 'connecting' });

  const attach = async () => {
    if (disposed) return;
    const gen = ++generation;
    await syncRealtimeAuth();
    if (disposed || gen !== generation) return;

    removeStaleCityChannels(current);
    const ch = supabase!.channel(CITY_TOPIC, {
      config: {
        private: false,
        broadcast: { self: false },
        presence: { key: observerKey },
      },
    });
    current = ch;

    ch
      .on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<PresencePayload>();
        const all = flattenPresenceState(state as Record<string, PresencePayload[] | undefined>);
        const players = all.filter((p) => !p.id.startsWith('observer_'));
        onUpdate({ status: 'connected', count: players.length });
      })
      .subscribe((status) => {
        presenceLog(`landing ${status}`);
        if (disposed || gen !== generation) return;
        if (status === 'SUBSCRIBED') {
          retries = 0;
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (retries >= 4) {
            onUpdate({ status: 'unavailable' });
            return;
          }
          retries += 1;
          const delay = Math.min(1000 * 2 ** retries, 8000);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (disposed || gen !== generation) return;
            removeCityChannel(ch);
            if (current === ch) current = null;
            void attach();
          }, delay);
        }
      });
  };

  void attach();

  return () => {
    disposed = true;
    generation += 1;
    if (retryTimer) clearTimeout(retryTimer);
    removeCityChannel(current);
    current = null;
  };
}

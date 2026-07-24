/**
 * src/lib/presence.ts
 * ───────────────────
 * Supabase Realtime presence helpers for the RugTown city channel.
 *
 * Guests and signed-in accounts share the same public city topic.
 * Authenticated users must use an explicit presence key (their user id)
 * — without it, JWT-default keys + competing service channels can leave
 * signed-in players invisible to each other while guests still meet.
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

/**
 * Remove any Realtime channel already registered on the city topic.
 * Prevents a duplicate-join `CHANNEL_ERROR` when a stale channel is still
 * registered — e.g. the landing-page counter, or a React StrictMode
 * double-mount in development.
 */
function removeStaleCityChannels(): void {
  if (!supabase) return;
  for (const ch of supabase.getChannels()) {
    const topic = ch.topic ?? '';
    // Match `rugtown:city` and Supabase's `realtime:rugtown:city` form only.
    // Do NOT match `social:…`, `party:…`, etc.
    if (
      topic === CITY_TOPIC
      || topic === `realtime:${CITY_TOPIC}`
      || topic.endsWith(`:${CITY_TOPIC}`)
    ) {
      supabase.removeChannel(ch);
    }
  }
}

/**
 * Create the city Realtime channel for presence + chat/emote broadcast.
 * @param presenceKey Stable id for this client (auth user id or guest_…).
 */
export function createCityChannel(presenceKey: string): RealtimeChannel | null {
  if (!isSupabaseConfigured || !supabase) return null;
  removeStaleCityChannels();
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
 * `unsubscribe()` alone leaves the channel registered, which causes the next
 * subscribe on the same topic to collide.
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
 * Keep the Realtime socket JWT in sync with the auth session.
 * Signed-in players otherwise can subscribe as a stale anon socket while
 * track() is keyed to their user id — guests still meet, accounts don't.
 */
export function syncRealtimeAuth(): void {
  if (!supabase) return;
  void supabase.auth.getSession().then(({ data: { session } }) => {
    if (session?.access_token) {
      void supabase.realtime.setAuth(session.access_token);
    }
  });
}

/**
 * Subscribe to the city presence channel and report the live player count.
 * Does not track a player — read-only listener for landing page stats.
 * Returns an unsubscribe function.
 */
export function subscribeCityPresenceCount(
  onUpdate: (state: PresenceCountState) => void,
): () => void {
  if (!isSupabaseConfigured || !supabase) {
    onUpdate({ status: 'unavailable' });
    return () => {};
  }

  syncRealtimeAuth();

  // Observer key must not collide with a real player's presence key.
  const observerKey = `observer_${Math.random().toString(36).slice(2, 10)}`;
  let current: RealtimeChannel | null = createCityChannel(observerKey);
  if (!current) {
    onUpdate({ status: 'unavailable' });
    return () => {};
  }

  onUpdate({ status: 'connecting' });
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const attach = (ch: RealtimeChannel) => {
    current = ch;
    ch
      .on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<PresencePayload>();
        const all = flattenPresenceState(state as Record<string, PresencePayload[] | undefined>);
        // Observers don't track — count only payloads that look like players.
        const players = all.filter((p) => !p.id.startsWith('observer_'));
        onUpdate({ status: 'connected', count: players.length });
      })
      .subscribe((status) => {
        if (disposed) return;
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
            if (disposed || !supabase) return;
            removeCityChannel(ch);
            syncRealtimeAuth();
            const next = createCityChannel(observerKey);
            if (!next) {
              onUpdate({ status: 'unavailable' });
              return;
            }
            attach(next);
          }, delay);
        }
      });
  };

  attach(current);

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    removeCityChannel(current);
  };
}

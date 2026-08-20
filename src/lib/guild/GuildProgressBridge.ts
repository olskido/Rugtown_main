import { supabase } from '../supabase';

export type GuildGameplayEventType =
  | 'visit_district'
  | 'complete_mission'
  | 'meet_player'
  | 'discover_landmark'
  | 'join_event';

export async function reportGuildGameplayEvent(opts: {
  eventType: GuildGameplayEventType;
  ref?: string;
  counterpartId?: string;
  idempotencyKey: string;
}): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.rpc('report_guild_gameplay_event', {
      p_event_type: opts.eventType,
      p_ref: opts.ref ?? null,
      p_counterpart_id: opts.counterpartId ?? null,
      p_idempotency_key: opts.idempotencyKey,
    });
  } catch { /* pre-migration or offline */ }
}

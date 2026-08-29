/**
 * src/lib/profile.ts
 * ──────────────────
 * Thin helpers that read and write the user's persistent profile data in
 * Supabase.  All functions check for a null client first and return a safe
 * fallback value, so they're safe to call from guest-mode code paths too.
 *
 * Nothing in this file touches gameplay state directly — callers decide what
 * to do with the returned data.
 */

import { supabase, type DbProfile, type RugtownProfileState } from './supabase';

/* ─── profile ─────────────────────────────────────────────────── */

/**
 * Fetch the `profiles` row for `userId`.
 * Returns null on any error (user not found, network failure, etc.) so
 * the caller can fall back to a derived/guest name gracefully.
 */
export async function fetchProfile(userId: string): Promise<DbProfile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error || !data) return null;
  return data as DbProfile;
}

/** Server-authoritative profile + onboarding gate (Phase 15). */
export async function getRugtownProfileState(): Promise<RugtownProfileState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_rugtown_profile_state');
  if (error) {
    // Fallback for databases without Phase 15 migration yet.
    const { data: session } = await supabase.auth.getSession();
    const uid = session.session?.user?.id;
    if (!uid) return null;
    const profile = await fetchProfile(uid);
    if (!profile) return null;
    return {
      id: profile.id,
      username: profile.username,
      displayName: profile.display_name,
      onboardingCompleted: profile.onboarding_completed ?? true,
      walletAddress: profile.wallet_address ?? null,
      rep: profile.rep,
    };
  }
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    username: String(o.username ?? ''),
    displayName: (o.displayName ?? o.display_name ?? null) as string | null,
    onboardingCompleted: o.onboardingCompleted === true || o.onboarding_completed === true,
    walletAddress: (o.walletAddress ?? o.wallet_address ?? null) as string | null,
    rep: Number(o.rep ?? 0),
    level: typeof o.level === 'number' ? o.level : undefined,
    // Phase 16 fields — present when the migration has been applied.
    lifetimeXp: typeof o.lifetimeXp === 'number' ? o.lifetimeXp : undefined,
    rugPoints: typeof o.rugPoints === 'number' ? o.rugPoints : undefined,
    dailyPoints: typeof o.dailyPoints === 'number' ? o.dailyPoints : undefined,
    weeklyPoints: typeof o.weeklyPoints === 'number' ? o.weeklyPoints : undefined,
    progressionCurveVersion: typeof o.progressionCurveVersion === 'number' ? o.progressionCurveVersion : undefined,
    streakCurrent: (o.streakCurrent ?? null) as number | null | undefined,
    streakLongest: (o.streakLongest ?? null) as number | null | undefined,
    streakLastDailyKey: (o.streakLastDailyKey ?? null) as string | null | undefined,
  };
}

export async function checkUsernameAvailable(username: string): Promise<boolean> {
  if (!supabase) return false;
  const trimmed = username.trim();
  if (!trimmed) return false;
  const { data, error } = await supabase.rpc('check_username_available', {
    p_username: trimmed,
  });
  if (error) {
    // Pre-migration: naive client check (non-authoritative preview only).
    const { data: rows } = await supabase
      .from('profiles')
      .select('id')
      .ilike('username', trimmed)
      .limit(1);
    return !rows?.length;
  }
  return data === true;
}

export async function createRugtownProfile(
  username: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase not configured.' };
  const trimmed = username.trim();
  const { data, error } = await supabase.rpc('create_rugtown_profile', {
    p_username: trimmed,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (o.ok === false) return { ok: false, error: String(o.error ?? 'Username unavailable.') };
    return { ok: true, username: String(o.username ?? trimmed) };
  }
  return { ok: true, username: trimmed };
}

/** Minimal shape of the authenticated user needed to seed a profile. Matches
 *  the relevant fields of Supabase's `User` (id / email / user_metadata). */
export interface AuthUserLike {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

function sanitizeHandle(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function randomSuffix(): string {
  // 4 base-36 chars — matches the "short random suffix" requirement.
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Fetch the user's profile, creating it from their account if it doesn't exist
 * yet.
 *
 * The database trigger (`handle_new_user`) normally creates the row on signup,
 * but we do NOT rely on it alone — this is the frontend fallback so a missing
 * trigger or any race can't leave a signed-in user without a profile (which
 * would silently break every later `.update()` write).
 *
 * Safe under RLS: the `profiles` INSERT policy allows a row where
 * `auth.uid() = id`, so a user can always create their own row. Username prefers
 * the handle chosen at sign-up (carried in user_metadata), falling back to the
 * sanitized email prefix, with a short random suffix only if that handle is
 * already taken (username is UNIQUE). Row conflicts (trigger/other tab won the
 * race) resolve to whatever is already in the database.
 */
export async function fetchOrCreateProfile(user: AuthUserLike): Promise<DbProfile | null> {
  if (!supabase) return null;

  const existing = await fetchProfile(user.id);
  if (existing) return existing;

  const meta = user.user_metadata ?? {};
  const metaUsername = typeof meta.username === 'string' ? meta.username : '';
  const metaFullName = typeof meta.full_name === 'string' ? meta.full_name : '';
  const metaName     = typeof meta.name === 'string' ? meta.name : '';

  const chosenHandle = sanitizeHandle(metaUsername);
  const emailPrefix  = sanitizeHandle(user.email?.split('@')[0] ?? '') || 'degen';
  const baseHandle   = chosenHandle || emailPrefix;

  const displayName = metaUsername || metaFullName || metaName || baseHandle;
  const avatarUrl   = null;

  // Try the clean handle first; add a random suffix only if it's needed.
  const candidates = [baseHandle, `${baseHandle}_${randomSuffix()}`, `${baseHandle}_${randomSuffix()}`];
  for (const username of candidates) {
    const { data, error } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
      })
      .select()
      .single();

    if (!error && data) return data as DbProfile;

    // The row may already exist (trigger or another tab created it first) —
    // whatever is stored is authoritative, so prefer it over retrying.
    const now = await fetchProfile(user.id);
    if (now) return now;

    // Otherwise it was most likely a username-unique clash → next candidate.
  }

  return await fetchProfile(user.id);
}

export interface SaveUsernameResult {
  ok: boolean;
  /** Present on failure: 'cooldown' | 'taken' | 'reserved' | 'invalid_length' | 'invalid_chars' | 'rate_limited' | a transport error message. */
  reason?: string;
}

/**
 * Persist the player's chosen display handle via server-authoritative
 * update_player_username when available; fall back to direct update only
 * if the RPC is missing (pre-10J databases).
 *
 * Unlike the pre-Phase-1 version, this inspects the RPC's own `{ok, reason}`
 * response body, not just transport-level errors -- update_player_username
 * returns a normal 200 response with `ok: false` for a cooldown or username
 * collision (it does not raise a SQL exception for those), so a caller that
 * only checked `error` would silently treat a rejected rename as a success.
 */
export async function saveUsername(userId: string, username: string): Promise<SaveUsernameResult> {
  if (!supabase) return { ok: false, reason: 'Supabase not configured.' };
  const trimmed = username.trim();
  if (!trimmed) return { ok: false, reason: 'Username is empty.' };

  const { data, error: rpcError } = await supabase.rpc('update_player_username', {
    p_username: trimmed,
  });
  if (!rpcError) {
    if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>;
      if (o.ok === false) return { ok: false, reason: typeof o.reason === 'string' ? o.reason : 'Username rejected.' };
    }
    return { ok: true };
  }

  const missing =
    rpcError.code === 'PGRST202' ||
    /does not exist|function .* does not exist|schema cache/i.test(rpcError.message ?? '');
  if (!missing) return { ok: false, reason: rpcError.message };

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ username: trimmed, display_name: trimmed })
    .eq('id', userId);
  return updateError ? { ok: false, reason: updateError.message } : { ok: true };
}

/* ─── badges ──────────────────────────────────────────────────── */

/**
 * Fetch the IDs of every badge the user has earned.
 * Returns an empty array on any error — caller stays in default state.
 */
export async function fetchUserBadgeIds(userId: string): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('player_badges')
    .select('badge_id')
    .eq('user_id', userId);
  if (error || !data) return [];
  return (data as { badge_id: string }[]).map(row => row.badge_id);
}

/**
 * Upsert a single earned badge.
 * The UNIQUE(user_id, badge_id) constraint means this is idempotent.
 */
export async function saveBadge(userId: string, badgeId: string): Promise<void> {
  if (!supabase) return;
  await supabase
    .from('player_badges')
    .upsert(
      { user_id: userId, badge_id: badgeId },
      { onConflict: 'user_id,badge_id' },
    );
}

/* ─── inventory ───────────────────────────────────────────────── */

/**
 * Fetch all item IDs the user has in player_inventory.
 * Returns [] on any error — caller treats unloaded items as not-yet-saved.
 */
export async function fetchInventoryItemIds(userId: string): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('player_inventory')
    .select('item_id')
    .eq('user_id', userId);
  if (error || !data) return [];
  return (data as { item_id: string }[]).map(row => row.item_id);
}

/**
 * Upsert a single owned item into player_inventory.
 * UNIQUE(user_id, item_id) constraint makes this idempotent.
 */
export async function saveInventoryItem(
  userId: string,
  itemId: string,
): Promise<void> {
  if (!supabase) return;
  await supabase
    .from('player_inventory')
    .upsert(
      { user_id: userId, item_id: itemId },
      { onConflict: 'user_id,item_id' },
    );
}

/* ─── district_unlocks ─────────────────────────────────────────── */

/**
 * Fetch all district IDs the user has unlocked.
 * Returns [] on any error — caller initialises districts to local defaults.
 */
export async function fetchDistrictUnlockIds(userId: string): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('district_unlocks')
    .select('district_id')
    .eq('user_id', userId);
  if (error || !data) return [];
  return (data as { district_id: string }[]).map(row => row.district_id);
}

/**
 * Upsert a single unlocked district.
 * UNIQUE(user_id, district_id) constraint makes this idempotent.
 */
export async function saveDistrictUnlock(
  userId: string,
  districtId: string,
): Promise<void> {
  if (!supabase) return;
  await supabase
    .from('district_unlocks')
    .upsert(
      { user_id: userId, district_id: districtId },
      { onConflict: 'user_id,district_id' },
    );
}

/* ─── rep ─────────────────────────────────────────────────────── */

/**
 * Persist the player's current REP score to profiles.rep.
 * Called debounced from GamePage so writes are batched on inactivity.
 */
/**
 * Overwrite profiles.rep for the authenticated user.
 *
 * Phase 10G: after `20260716_phase10g_rewards.sql` is applied, direct client
 * updates to `rep` are ignored by trigger unless a SECURITY DEFINER RPC sets
 * `app.rugtown_reward_mutation`. Prefer `award_gameplay_reward` for authority.
 * This helper remains for backwards compatibility before the migration is applied.
 */
export async function saveRep(userId: string, rep: number): Promise<void> {
  if (!supabase) return;
  await supabase
    .from('profiles')
    .update({ rep })
    .eq('id', userId);
}

/**
 * Stamp profiles.last_seen_at to now().
 * Called when the Realtime presence channel subscribes successfully.
 */
export async function updateLastSeen(userId: string): Promise<void> {
  if (!supabase) return;
  await supabase
    .from('profiles')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', userId);
}

/* ─── contact email (Phase 3c) ───────────────────────────────────
 * Captured at New Sign Up, purely as recovery/contact metadata -- not used
 * for authentication or verification, no email is ever sent to it. Stored
 * in its own owner-only-readable table (see 20260823_phase3c_contact_email.sql),
 * never on `profiles`, which is world-readable via RLS. */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

export async function saveMyContactEmail(
  userId: string,
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase not configured.' };
  const clean = email.trim().toLowerCase();
  if (!isValidEmail(clean)) return { ok: false, error: 'invalid_email' };

  const { error } = await supabase
    .from('player_contact_emails')
    .upsert({ player_id: userId, email: clean, updated_at: new Date().toISOString() }, { onConflict: 'player_id' });
  return error ? { ok: false, error: error.message } : { ok: true };
}

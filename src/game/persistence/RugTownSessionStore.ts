/**
 * RugTownSessionStore.ts
 * ──────────────────────
 * Versioned local session persistence so a browser refresh restores
 * route + last safe world position (not a cold start at the fountain).
 *
 * Supabase remains authoritative for XP/REP/missions/appearance.
 * This store only holds client restore hints. Movement is never written
 * to Supabase every frame — callers must debounce.
 */

export const SESSION_SCHEMA_VERSION = 2 as const;

export type RugTownRoute =
  | '/'
  | '/auth'
  | '/wallet'
  | '/onboarding/username'
  | '/onboarding/wallet'
  | '/character'
  | '/play';

export interface RugTownSessionV2 {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  route: RugTownRoute;
  enteredGame: boolean;
  playerName: string;
  position: { x: number; y: number } | null;
  districtId: string | null;
  interiorId: string | null;
  activeMissionId: string | null;
  cameraZoom: number | null;
  savedAt: number;
}

const GUEST_ID_KEY = 'rugtown:guest-id:v1';

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Stable guest id for local session keys (survives refresh). */
export function getOrCreateGuestId(): string {
  if (!hasStorage()) return `guest_${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = window.localStorage.getItem(GUEST_ID_KEY);
    if (existing && existing.startsWith('guest_')) return existing;
    const id = `guest_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(GUEST_ID_KEY, id);
    return id;
  } catch {
    return `guest_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function sessionStorageKey(userId: string | null | undefined): string {
  if (userId && userId.length > 0 && !userId.startsWith('guest_')) {
    return `rugtown:session:v2:user:${userId}`;
  }
  return `rugtown:session:v2:guest:${getOrCreateGuestId()}`;
}

const DEFAULT_SESSION = (): RugTownSessionV2 => ({
  schemaVersion: SESSION_SCHEMA_VERSION,
  route: '/',
  enteredGame: false,
  playerName: '',
  position: null,
  districtId: null,
  interiorId: null,
  activeMissionId: null,
  cameraZoom: null,
  savedAt: Date.now(),
});

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function parseRoute(raw: unknown): RugTownRoute {
  const allowed: RugTownRoute[] = ['/', '/auth', '/wallet', '/onboarding/username', '/character', '/play'];
  return allowed.includes(raw as RugTownRoute) ? (raw as RugTownRoute) : '/';
}

/** Validate and normalize raw JSON into a session, or null if unusable. */
export function parseSession(raw: unknown): RugTownSessionV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ver = o.schemaVersion;
  if (ver !== 1 && ver !== 2 && ver !== SESSION_SCHEMA_VERSION) return null;

  let position: { x: number; y: number } | null = null;
  if (o.position && typeof o.position === 'object') {
    const p = o.position as Record<string, unknown>;
    if (isFiniteNum(p.x) && isFiniteNum(p.y)) position = { x: p.x, y: p.y };
  }

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    route: parseRoute(o.route),
    enteredGame: o.enteredGame === true,
    playerName: typeof o.playerName === 'string' ? o.playerName.slice(0, 32) : '',
    position,
    districtId: typeof o.districtId === 'string' ? o.districtId : null,
    interiorId: typeof o.interiorId === 'string' ? o.interiorId : null,
    activeMissionId: typeof o.activeMissionId === 'string' ? o.activeMissionId : null,
    cameraZoom: isFiniteNum(o.cameraZoom) ? o.cameraZoom : null,
    savedAt: isFiniteNum(o.savedAt) ? o.savedAt : Date.now(),
  };
}

export function loadRugTownSession(userId?: string | null): RugTownSessionV2 | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(sessionStorageKey(userId));
    if (!raw) return null;
    return parseSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveRugTownSession(
  patch: Partial<RugTownSessionV2>,
  userId?: string | null,
): RugTownSessionV2 {
  const prev = loadRugTownSession(userId) ?? DEFAULT_SESSION();
  const next: RugTownSessionV2 = {
    ...prev,
    ...patch,
    schemaVersion: SESSION_SCHEMA_VERSION,
    savedAt: Date.now(),
  };
  if (!hasStorage()) return next;
  try {
    window.localStorage.setItem(sessionStorageKey(userId), JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  return next;
}

export function clearRugTownSession(userId?: string | null): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(sessionStorageKey(userId));
  } catch {
    /* ignore */
  }
}

/** Clamp to world bounds; return null if unusable → caller uses Spring Water spawn. */
export function clampWorldPosition(
  pos: { x: number; y: number } | null | undefined,
  worldW: number,
  worldH: number,
  margin = 40,
): { x: number; y: number } | null {
  if (!pos || !isFiniteNum(pos.x) || !isFiniteNum(pos.y)) return null;
  if (worldW <= margin * 2 || worldH <= margin * 2) return null;
  const x = Math.min(worldW - margin, Math.max(margin, pos.x));
  const y = Math.min(worldH - margin, Math.max(margin, pos.y));
  // Reject clearly corrupt coords (e.g. 0,0 far outside playable plaza)
  if (x !== x || y !== y) return null;
  return { x, y };
}

/** Stale sessions older than 7 days still restore route but not position. */
export function isSessionFresh(session: RugTownSessionV2, maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  return Date.now() - session.savedAt < maxAgeMs;
}

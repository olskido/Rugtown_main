/**
 * RewardService.ts — client boundary to SECURITY DEFINER RPCs (Phase 10G).
 * Guests stay local. Authenticated users prefer server authority when RPCs exist.
 */

import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import {
  completeChapterMission as rpcCompleteChapterMission,
  ensureChapterMissions,
  type CompleteChapterMissionResult,
} from '../../lib/missions/ChapterMissionService';
import { progressionService } from '../progression/ProgressionService';
import {
  getMissionDef,
  pickLocalDaily,
  pickLocalWeekly,
  utcDailyKey,
  utcWeeklyKey,
} from './PeriodMissions';
import { settlementAdapter } from './SettlementAdapter';
import { supabaseSettlementAdapter } from './settlement/SupabaseSettlementAdapter';
import type {
  PlayerNotificationView,
  RewardSettlementView,
  RewardSystemHealth,
  VerifiedWalletView,
} from './settlement/SettlementTypes';
import type {
  ClaimableReward,
  ClaimStatus,
  MissionAssignmentView,
  MissionPeriodType,
  RewardEligibility,
  ServerProgressionSnapshot,
} from './types';
import { RUG_POINTS_DISCLAIMER, REWARD_RULES_VERSION } from './types';

/**
 * Authority modes:
 * - local: guest / unauthenticated, local-only progression (no monetary claims)
 * - server: authenticated + server RPCs healthy
 * - migration_required: authenticated but Phase 10G/10H not applied
 * - server_unavailable: authenticated but server temporarily unreachable
 *   (Phase 10H: authenticated users NEVER silently fall back to local authority)
 * - unavailable: not yet initialised
 */
export type RewardAuthorityMode =
  | 'local'
  | 'server'
  | 'migration_required'
  | 'server_unavailable'
  | 'unavailable';

export interface AwardGameplayResult {
  awarded: boolean;
  duplicate?: boolean;
  mode: RewardAuthorityMode;
  message?: string;
}

function mapAssignment(raw: Record<string, unknown>): MissionAssignmentView {
  const defId = String(raw.mission_definition_id ?? raw.missionDefinitionId ?? '');
  const def = getMissionDef(defId);
  return {
    id: String(raw.id),
    missionDefinitionId: defId,
    periodType: (raw.period_type ?? raw.periodType) as MissionPeriodType,
    periodKey: String(raw.period_key ?? raw.periodKey ?? ''),
    progress: Number(raw.progress ?? 0),
    target: Number(raw.target ?? def?.target ?? 1),
    status: (raw.status as MissionAssignmentView['status']) ?? 'active',
    title: def?.title ?? defId,
    description: def?.description ?? '',
    xpReward: def?.xpReward ?? 0,
    repReward: def?.repReward ?? 0,
    seasonPoints: def?.seasonPoints ?? 0,
    rugPoints: def?.rugPoints ?? 0,
    objectiveType: def?.objectiveType ?? 'visit_district',
    objectiveRef: def?.objectiveRef ?? null,
    sponsored: false,
  };
}

function mapClaim(raw: Record<string, unknown>): ClaimableReward {
  return {
    id: String(raw.id),
    playerId: String(raw.player_id ?? raw.playerId ?? ''),
    rewardAsset: String(raw.reward_asset ?? raw.rewardAsset ?? 'NONE'),
    amount: String(raw.amount ?? '0'),
    source: String(raw.source ?? ''),
    campaignId: (raw.campaign_id ?? raw.campaignId ?? null) as string | null,
    status: (raw.status as ClaimStatus) ?? 'pending',
    eligibilitySnapshot: (raw.eligibility_snapshot ?? raw.eligibilitySnapshot ?? {}) as Record<string, unknown>,
    createdAt: String(raw.created_at ?? raw.createdAt ?? new Date().toISOString()),
    expiresAt: (raw.expires_at ?? raw.expiresAt ?? null) as string | null,
    claimedAt: (raw.claimed_at ?? raw.claimedAt ?? null) as string | null,
    transactionSignature: (raw.transaction_signature ?? raw.transactionSignature ?? null) as string | null,
  };
}

class RewardService {
  private mode: RewardAuthorityMode = 'unavailable';
  private serverReady = false;
  private rugPointsLocal = 0;
  private daily: MissionAssignmentView[] = [];
  private weekly: MissionAssignmentView[] = [];
  private claims: ClaimableReward[] = [];
  private seasonId: string | null = null;
  private seasonPoints = 0;
  private migrated = false;
  private listeners = new Set<() => void>();
  private currentUserId: string | null = null;

  // Phase 10H state
  private health: RewardSystemHealth | null = null;
  private wallets: VerifiedWalletView[] = [];
  private notifications: PlayerNotificationView[] = [];
  private unreadCount = 0;
  private settlements: RewardSettlementView[] = [];
  private realtimeChannel: { unsubscribe?: () => void } | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  readonly disclaimer = RUG_POINTS_DISCLAIMER;
  readonly rulesVersion = REWARD_RULES_VERSION;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  getAuthorityMode(): RewardAuthorityMode {
    return this.mode;
  }

  getRugPoints(): number {
    return this.rugPointsLocal;
  }

  getSeasonId(): string | null {
    return this.seasonId;
  }

  getSeasonPoints(): number {
    return this.seasonPoints;
  }

  getDailyMissions(): MissionAssignmentView[] {
    return this.daily;
  }

  getWeeklyMissions(): MissionAssignmentView[] {
    return this.weekly;
  }

  getClaims(): ClaimableReward[] {
    return this.claims;
  }

  isServerAuthoritative(): boolean {
    return this.mode === 'server' && this.serverReady;
  }

  /** Authenticated but server not usable — client must NOT grant local rewards. */
  isAuthenticatedBlocked(): boolean {
    return this.mode === 'migration_required' || this.mode === 'server_unavailable';
  }

  getHealth(): RewardSystemHealth | null {
    return this.health;
  }

  getWallets(): VerifiedWalletView[] {
    return this.wallets;
  }

  getPrimaryVerifiedWallet(): VerifiedWalletView | null {
    return this.wallets.find((w) => !w.revokedAt && w.isPrimary) ?? this.wallets.find((w) => !w.revokedAt) ?? null;
  }

  getNotifications(): PlayerNotificationView[] {
    return this.notifications;
  }

  getUnreadCount(): number {
    return this.unreadCount;
  }

  getSettlements(): RewardSettlementView[] {
    return this.settlements;
  }

  async initForUser(opts: {
    userId: string | null;
    isGuest: boolean;
    guestIdentity: string;
  }): Promise<void> {
    this.currentUserId = opts.userId;
    if (opts.isGuest || !opts.userId || !isSupabaseConfigured || !supabase) {
      this.mode = 'local';
      this.serverReady = false;
      this.bootstrapLocalMissions(opts.guestIdentity);
      this.notify();
      return;
    }

    // Probe server RPCs. Phase 10H: authenticated users fail CLOSED — never
    // silently fall back to local authority once an account exists.
    const { data, error } = await supabase.rpc('get_my_progression');
    if (error || !data) {
      const missing =
        error?.code === 'PGRST202' || // function not found
        /does not exist|function .* does not exist|schema cache/i.test(error?.message ?? '');
      this.mode = missing ? 'migration_required' : 'server_unavailable';
      this.serverReady = false;
      // Authenticated: do NOT grant local rewards. Show a clear blocked state.
      this.daily = [];
      this.weekly = [];
      this.claims = [];
      this.notify();
      return;
    }

    this.mode = 'server';
    this.serverReady = true;
    this.applyServerProgression(data as ServerProgressionSnapshot);
    await Promise.all([
      ensureChapterMissions(),
      this.refreshPeriodMissions('daily'),
      this.refreshPeriodMissions('weekly'),
      this.refreshClaims(),
      this.refreshHealth(),
      this.refreshWallets(),
      this.refreshNotifications(),
    ]);
    this.subscribeRealtime(opts.userId);
    this.notify();
  }

  private applyServerProgression(snap: ServerProgressionSnapshot): void {
    this.rugPointsLocal = Number(snap.rug_points ?? 0);
    this.seasonId = snap.season_id;
    this.seasonPoints = Number(snap.season_points ?? 0);
    this.migrated = !!snap.migrated_from_local;
    // Forward all known fields — ProgressionService handles max-wins merge.
    progressionService.syncFromServerSnapshot({
      lifetime_xp:         snap.lifetime_xp,
      level:               snap.level,
      rep:                 snap.rep,
      claimed_reward_keys: snap.claimed_reward_keys,
      rug_points:          snap.rug_points,
      daily_points:        snap.daily_points,
      weekly_points:       snap.weekly_points,
    });
  }

  /** Server-authoritative Chapter One mission completion (Phase 13). */
  async completeChapterMission(missionId: string): Promise<CompleteChapterMissionResult> {
    if (!this.serverReady || !supabase) {
      return { awarded: false, duplicate: false, missionId, error: 'server_not_ready' };
    }
    const result = await rpcCompleteChapterMission(missionId);
    if (result.progression) {
      this.applyServerProgression(result.progression);
    }
    this.notify();
    void import('../achievements/AchievementService').then((m) => {
      void m.achievementService.requestEvaluation('mission');
    });
    return result;
  }

  private bootstrapLocalMissions(playerId: string): void {
    const dailyKey = utcDailyKey();
    const weeklyKey = utcWeeklyKey();
    this.daily = pickLocalDaily(playerId, dailyKey).map((d) => ({
      id: `local:${dailyKey}:${d.id}`,
      missionDefinitionId: d.id,
      periodType: 'daily' as const,
      periodKey: dailyKey,
      progress: 0,
      target: d.target,
      status: 'active' as const,
      title: d.title,
      description: d.description,
      xpReward: d.xpReward,
      repReward: d.repReward,
      seasonPoints: d.seasonPoints,
      rugPoints: d.rugPoints,
      objectiveType: d.objectiveType,
      objectiveRef: d.objectiveRef ?? null,
    }));
    this.weekly = pickLocalWeekly(playerId, weeklyKey).map((d) => ({
      id: `local:${weeklyKey}:${d.id}`,
      missionDefinitionId: d.id,
      periodType: 'weekly' as const,
      periodKey: weeklyKey,
      progress: 0,
      target: d.target,
      status: 'active' as const,
      title: d.title,
      description: d.description,
      xpReward: d.xpReward,
      repReward: d.repReward,
      seasonPoints: d.seasonPoints,
      rugPoints: d.rugPoints,
      objectiveType: d.objectiveType,
      objectiveRef: d.objectiveRef ?? null,
    }));
  }

  async refreshPeriodMissions(period: MissionPeriodType): Promise<void> {
    if (!this.serverReady || !supabase) {
      return;
    }
    const { data, error } = await supabase.rpc('ensure_period_missions', {
      p_period_type: period,
    });
    if (error || !data) return;
    const payload = data as { assignments?: Record<string, unknown>[] };
    const list = (payload.assignments ?? []).map(mapAssignment);
    if (period === 'daily') this.daily = list;
    else this.weekly = list;
    this.notify();
  }

  async refreshClaims(): Promise<void> {
    if (!this.serverReady || !supabase) {
      this.claims = [];
      return;
    }
    const { data, error } = await supabase
      .from('claimable_rewards')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error || !data) {
      this.claims = [];
      return;
    }
    this.claims = (data as Record<string, unknown>[]).map(mapClaim);
    this.notify();
  }

  /**
   * Authenticated gameplay award — server decides amounts when available.
   * Guests / unavailable server: local ProgressionService only (no monetary claims).
   */
  async awardGameplay(opts: {
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    /** Local fallback when server unavailable */
    localFallback?: () => void;
  }): Promise<AwardGameplayResult> {
    if (this.serverReady && supabase) {
      const { data, error } = await supabase.rpc('award_gameplay_reward', {
        p_source_type: opts.sourceType,
        p_source_id: opts.sourceId,
        p_idempotency_key: opts.idempotencyKey,
        p_metadata: {},
      });
      if (!error && data) {
        const result = data as {
          awarded?: boolean;
          duplicate?: boolean;
          progression?: ServerProgressionSnapshot;
        };
        if (result.progression) this.applyServerProgression(result.progression);
        this.notify();
        // Avoid circular import with AchievementService — dynamic load after award.
        const evalType =
          opts.sourceType.includes('district') || opts.sourceType.includes('landmark') || opts.sourceType.includes('interior')
            ? 'discovery'
            : opts.sourceType.includes('mission')
              ? 'mission'
              : 'full';
        void import('../achievements/AchievementService').then((m) => {
          void m.achievementService.requestEvaluation(evalType);
        });
        return {
          awarded: !!result.awarded,
          duplicate: !!result.duplicate,
          mode: 'server',
        };
      }
      // Server was authoritative but the award failed. Phase 10H: fail closed —
      // do NOT silently grant a local reward for an authenticated user.
      this.mode = 'server_unavailable';
      this.serverReady = false;
      this.notify();
      return {
        awarded: false,
        mode: 'server_unavailable',
        message: 'Server award failed — reward not granted (no local fallback for accounts).',
      };
    }

    // Guests / local-only: local progression is the only authority.
    if (this.mode === 'local') {
      opts.localFallback?.();
      return { awarded: true, mode: 'local', message: 'Awarded locally (guest).' };
    }

    // Authenticated but blocked (migration_required / server_unavailable): no reward.
    return {
      awarded: false,
      mode: this.mode,
      message: 'Reward authority unavailable for this account.',
    };
  }

  async reportObjective(opts: {
    objectiveType: string;
    ref?: string;
    amount?: number;
  }): Promise<void> {
    const bump = (list: MissionAssignmentView[]): MissionAssignmentView[] =>
      list.map((m) => {
        if (m.status !== 'active') return m;
        let hit = false;
        switch (m.objectiveType) {
          case 'visit_district':
            hit = opts.objectiveType === 'visit_district' && (!m.objectiveRef || m.objectiveRef === opts.ref);
            break;
          case 'visit_landmark':
            hit = opts.objectiveType === 'visit_landmark' && (!m.objectiveRef || m.objectiveRef === opts.ref);
            break;
          case 'discover_landmarks':
            hit = opts.objectiveType === 'visit_landmark' || opts.objectiveType === 'discover_landmarks';
            break;
          case 'enter_interior':
          case 'enter_interiors':
            hit = opts.objectiveType === 'enter_interior';
            break;
          case 'meet_player':
          case 'meet_players':
            hit = opts.objectiveType === 'meet_player';
            break;
          case 'wave_player':
            hit = opts.objectiveType === 'wave_player';
            break;
          case 'join_event':
          case 'join_events':
            hit = opts.objectiveType === 'join_event';
            break;
          case 'complete_missions':
            hit = opts.objectiveType === 'complete_mission';
            break;
          case 'visit_districts':
            hit = opts.objectiveType === 'visit_district';
            break;
          default:
            hit = false;
        }
        if (!hit) return m;
        const next = Math.min(m.target, m.progress + (opts.amount ?? 1));
        const status: MissionAssignmentView['status'] = next >= m.target ? 'completed' : m.status;
        return {
          ...m,
          progress: next,
          status,
        };
      });

    this.daily = bump(this.daily);
    this.weekly = bump(this.weekly);

    if (this.serverReady && supabase) {
      for (const m of [...this.daily, ...this.weekly]) {
        if (!m.id.startsWith('local:')) {
          await supabase.rpc('report_mission_progress', {
            p_assignment_id: m.id,
            p_progress: m.progress,
          });
        }
      }
      await Promise.all([
        this.refreshPeriodMissions('daily'),
        this.refreshPeriodMissions('weekly'),
      ]);
    }
    this.notify();
  }

  async claimMission(assignmentId: string): Promise<{ ok: boolean; message: string }> {
    const all = [...this.daily, ...this.weekly];
    const m = all.find((x) => x.id === assignmentId);
    if (!m) return { ok: false, message: 'Mission not found' };
    if (m.status !== 'completed') return { ok: false, message: 'Complete the mission first' };

    if (this.serverReady && supabase && !assignmentId.startsWith('local:')) {
      const { data, error } = await supabase.rpc('claim_mission_reward', {
        p_assignment_id: assignmentId,
      });
      if (error) return { ok: false, message: error.message };
      // Phase 13B returns progression at the top level. Older 10G nested it under award.
      const payload = data as {
        claimed?: boolean;
        duplicate?: boolean;
        xpAwarded?: number;
        repAwarded?: number;
        rugPointsAwarded?: number;
        progression?: ServerProgressionSnapshot;
        award?: { progression?: ServerProgressionSnapshot };
      };
      const progression = payload.progression ?? payload.award?.progression;
      // applyServerProgression sets rugPointsLocal to the authoritative server
      // total — do NOT add m.rugPoints again (Phase 10H double-add fix).
      if (progression) this.applyServerProgression(progression);
      await Promise.all([
        this.refreshPeriodMissions(m.periodType),
        this.refreshClaims(),
      ]);
      this.notify();
      const rugShown = payload.rugPointsAwarded ?? m.rugPoints;
      return {
        ok: true,
        message: payload.duplicate ? 'Already claimed' : `Claimed +${rugShown} Rug Points`,
      };
    }

    // Local claim — XP/REP via progression, Rug Points local only, never monetary
    progressionService.awardXp({
      amount: m.xpReward,
      reason: `Period mission ${m.missionDefinitionId}`,
      idempotencyKey: `period_claim:${assignmentId}:xp`,
    });
    if (m.repReward > 0) {
      progressionService.awardRep({
        amount: m.repReward,
        reason: `Period mission ${m.missionDefinitionId}`,
        idempotencyKey: `period_claim:${assignmentId}:rep`,
      });
    }
    this.rugPointsLocal += m.rugPoints;
    const mark = (list: MissionAssignmentView[]): MissionAssignmentView[] =>
      list.map((x) => (x.id === assignmentId ? { ...x, status: 'claimed' as const } : x));
    this.daily = mark(this.daily);
    this.weekly = mark(this.weekly);
    this.notify();
    return { ok: true, message: `Claimed +${m.rugPoints} Rug Points (local)` };
  }

  async evaluateEligibility(campaignId?: string): Promise<RewardEligibility> {
    if (!this.serverReady || !supabase) {
      return {
        eligible: false,
        reasons: ['Server reward authority unavailable', 'Authenticated account required for claims'],
        playerId: null,
        campaignId: campaignId ?? null,
      };
    }
    const { data, error } = await supabase.rpc('evaluate_reward_eligibility', {
      p_campaign_id: campaignId ?? null,
    });
    if (error || !data) {
      return {
        eligible: false,
        reasons: [error?.message ?? 'eligibility failed'],
        playerId: null,
      };
    }
    return data as RewardEligibility;
  }

  async createDevClaim(): Promise<{ ok: boolean; message: string }> {
    if (!this.serverReady || !supabase) {
      return { ok: false, message: 'Dev claims require authenticated server RPCs' };
    }
    const { data, error } = await supabase.rpc('create_dev_claim', {
      p_amount: '25',
      p_asset: 'RUG_POINTS',
      p_source: 'dev_mock',
    });
    if (error) return { ok: false, message: error.message };
    await this.refreshClaims();
    return { ok: true, message: `Created claim ${(data as { id?: string })?.id ?? ''}` };
  }

  async advanceClaim(claimId: string, next: ClaimStatus): Promise<{ ok: boolean; message: string }> {
    const claim = this.claims.find((c) => c.id === claimId);
    if (!claim) return { ok: false, message: 'Claim not found' };

    if (next === 'reserved') {
      const prep = await settlementAdapter.prepareClaim(claim);
      if (!prep.ok) return { ok: false, message: prep.message };
    }
    if (next === 'processing') {
      const sub = await settlementAdapter.submitClaim(claim);
      if (!sub.ok) return { ok: false, message: sub.message };
    }
    if (next === 'completed') {
      const ver = await settlementAdapter.verifySettlement(claim);
      if (!ver.verified) return { ok: false, message: ver.message };
    }

    if (this.serverReady && supabase) {
      const { error } = await supabase.rpc('transition_claim_status', {
        p_claim_id: claimId,
        p_next_status: next,
      });
      if (error) return { ok: false, message: error.message };
      await this.refreshClaims();
      return { ok: true, message: `Claim → ${next}` };
    }
    return { ok: false, message: 'Server required for claim transitions' };
  }

  async migrateGuestProgress(opts: {
    guestIdentity: string;
    localProgression: Record<string, unknown>;
  }): Promise<{ ok: boolean; summary?: Record<string, unknown>; message: string }> {
    if (!this.serverReady || !supabase) {
      return { ok: false, message: 'Server migration unavailable — apply Phase 10G SQL first.' };
    }
    if (this.migrated) {
      return { ok: false, message: 'Server already authoritative; migration already completed.' };
    }
    const key = `guest_merge:${opts.guestIdentity}`;
    const { data, error } = await supabase.rpc('migrate_local_progression', {
      p_guest_identity: opts.guestIdentity,
      p_idempotency_key: key,
      p_local: opts.localProgression,
    });
    if (error) return { ok: false, message: error.message };
    const payload = data as {
      merged?: boolean;
      duplicate?: boolean;
      refused?: boolean;
      summary?: Record<string, unknown>;
      progression?: ServerProgressionSnapshot;
    };
    if (payload.progression) this.applyServerProgression(payload.progression);
    this.notify();
    if (payload.refused) return { ok: false, message: 'Migration refused — server already authoritative.' };
    return {
      ok: true,
      summary: payload.summary,
      message: payload.duplicate ? 'Migration already applied' : 'Guest progress merged once',
    };
  }

  async fetchSeasonLeaderboard(seasonId: string, limit = 25, offset = 0) {
    if (!supabase) return { rows: [] as unknown[], seasonId };
    const { data, error } = await supabase.rpc('get_season_leaderboard', {
      p_season_id: seasonId,
      p_limit: limit,
      p_offset: offset,
    });
    if (error || !data) return { rows: [], seasonId };
    return data as { rows: unknown[]; seasonId: string };
  }

  // ─── Phase 10H: health ────────────────────────────────────────────
  async refreshHealth(): Promise<void> {
    if (!supabase) return;
    const { data, error } = await supabase.rpc('get_reward_system_health');
    if (error || !data) return;
    const h = data as Record<string, unknown>;
    this.health = {
      tables: (h.tables ?? {}) as Record<string, boolean>,
      rpcs: (h.rpcs ?? {}) as Record<string, boolean>,
      hasActiveSeason: Boolean(h.has_active_season),
      rewardDefinitions: Number(h.reward_definitions ?? 0),
      missionDefinitions: Number(h.mission_definitions ?? 0),
      ledgerRows: Number(h.ledger_rows ?? 0),
      pendingClaims: Number(h.pending_claims ?? 0),
      failedClaims: Number(h.failed_claims ?? 0),
      settlementMode: (h.settlement_mode ?? 'disabled') as RewardSystemHealth['settlementMode'],
      settlementConfigured: Boolean(h.settlement_configured),
      lastSettlementAt: (h.last_settlement_at ?? null) as string | null,
    };
    this.notify();
  }

  // ─── Phase 10H: wallet verification ───────────────────────────────
  async refreshWallets(): Promise<void> {
    if (!this.serverReady || !supabase) return;
    const { data, error } = await supabase
      .from('verified_wallets')
      .select('id, wallet_address, verified_at, is_primary, revoked_at')
      .order('verified_at', { ascending: false });
    if (error || !data) return;
    this.wallets = (data as Record<string, unknown>[]).map((w) => ({
      id: String(w.id),
      walletAddress: String(w.wallet_address),
      verifiedAt: String(w.verified_at),
      isPrimary: Boolean(w.is_primary),
      revokedAt: (w.revoked_at ?? null) as string | null,
    }));
    this.notify();
  }

  async requestWalletChallenge(walletAddress: string) {
    return supabaseSettlementAdapter.requestWalletChallenge(walletAddress);
  }

  async verifyWalletSignature(challengeId: string, signatureBase58: string) {
    const res = await supabaseSettlementAdapter.verifyWalletSignature(challengeId, signatureBase58);
    if (res.ok) await this.refreshWallets();
    return res;
  }

  async revokeWallet(walletId: string) {
    const res = await supabaseSettlementAdapter.revokeWallet(walletId);
    if (res.ok) await this.refreshWallets();
    return res;
  }

  // ─── Phase 10H: notifications ─────────────────────────────────────
  async refreshNotifications(): Promise<void> {
    if (!this.serverReady || !supabase) return;
    const { data, error } = await supabase.rpc('get_my_notifications', { p_limit: 30 });
    if (error || !data) return;
    const payload = data as { unread?: number; notifications?: Record<string, unknown>[] };
    this.unreadCount = Number(payload.unread ?? 0);
    this.notifications = (payload.notifications ?? []).map((n) => ({
      id: String(n.id),
      type: String(n.type),
      title: String(n.title),
      message: String(n.message ?? ''),
      icon: (n.icon ?? null) as string | null,
      metadata: (n.metadata ?? {}) as Record<string, unknown>,
      isRead: Boolean(n.is_read),
      createdAt: String(n.created_at),
    }));
    this.notify();
  }

  async markNotificationsRead(ids?: string[]): Promise<void> {
    if (!this.serverReady || !supabase) return;
    await supabase.rpc('mark_notifications_read', { p_ids: ids ?? null });
    await this.refreshNotifications();
  }

  // ─── Phase 10H: settlements ───────────────────────────────────────
  async refreshSettlements(): Promise<void> {
    if (!this.serverReady || !supabase) return;
    const { data, error } = await supabase
      .from('reward_settlements')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error || !data) return;
    this.settlements = (data as Record<string, unknown>[]).map((s) => ({
      id: String(s.id),
      claimId: String(s.claim_id),
      assetType: String(s.asset_type ?? 'NONE'),
      amountAtomic: Number(s.amount_atomic ?? 0),
      decimals: Number(s.decimals ?? 0),
      network: String(s.network ?? 'devnet'),
      settlementMode: (s.settlement_mode ?? 'disabled') as RewardSettlementView['settlementMode'],
      status: (s.status ?? 'not_started') as RewardSettlementView['status'],
      transactionSignature: (s.transaction_signature ?? null) as string | null,
      errorMessageSafe: (s.error_message_safe ?? null) as string | null,
      updatedAt: String(s.updated_at ?? new Date().toISOString()),
    }));
    this.notify();
  }

  // ─── Phase 10H: realtime ──────────────────────────────────────────
  private subscribeRealtime(userId: string): void {
    if (!supabase) return;
    this.unsubscribeRealtime();
    const filter = `player_id=eq.${userId}`;
    const channel = supabase
      .channel(`rewards:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_notifications', filter }, () => {
        void this.refreshNotifications();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claimable_rewards', filter }, () => {
        void this.refreshClaims();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reward_settlements', filter }, () => {
        void this.refreshSettlements();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mission_assignments', filter }, () => {
        void this.refreshPeriodMissions('daily');
        void this.refreshPeriodMissions('weekly');
      })
      .subscribe();
    this.realtimeChannel = channel as unknown as { unsubscribe?: () => void };
  }

  private unsubscribeRealtime(): void {
    if (this.realtimeChannel && supabase) {
      try {
        supabase.removeChannel(this.realtimeChannel as never);
      } catch {
        this.realtimeChannel.unsubscribe?.();
      }
    }
    this.realtimeChannel = null;
  }

  // ─── Phase 10H: operator console ──────────────────────────────────
  async isOperator(): Promise<{ operator: boolean; role: string | null }> {
    if (!this.serverReady || !supabase || !this.currentUserId) return { operator: false, role: null };
    const { data } = await supabase
      .from('reward_operators')
      .select('role, active')
      .eq('player_id', this.currentUserId)
      .eq('active', true)
      .maybeSingle();
    if (!data) return { operator: false, role: null };
    return { operator: true, role: String((data as { role?: string }).role ?? 'operator') };
  }

  async listPendingClaims(): Promise<Record<string, unknown>[]> {
    if (!this.serverReady || !supabase) return [];
    const { data, error } = await supabase.rpc('list_pending_claims', { p_limit: 100 });
    if (error || !data) return [];
    return ((data as { claims?: Record<string, unknown>[] }).claims ?? []);
  }

  async reviewClaim(claimId: string, action: 'approve' | 'reject' | 'hold' | 'release', notes?: string) {
    if (!this.serverReady || !supabase) return { ok: false, message: 'Server unavailable' };
    const { error } = await supabase.rpc('review_claim', { p_claim_id: claimId, p_action: action, p_notes: notes ?? null });
    if (error) return { ok: false, message: error.message };
    return { ok: true, message: `Claim ${action}d` };
  }

  async prepareSettlement(claimId: string) {
    if (!supabase) return { ok: false, message: 'Server unavailable' };
    const { data, error } = await supabase.functions.invoke('prepare-reward-settlement', { body: { claimId } });
    if (error) return { ok: false, message: error.message };
    const payload = data as { ok?: boolean; error?: string };
    return { ok: !!payload.ok, message: payload.ok ? 'Settlement prepared' : (payload.error ?? 'Failed') };
  }

  async verifySettlement(settlementId: string) {
    if (!supabase) return { ok: false, message: 'Server unavailable' };
    const { data, error } = await supabase.functions.invoke('verify-reward-settlement', { body: { settlementId } });
    if (error) return { ok: false, message: error.message };
    const payload = data as { ok?: boolean; error?: string };
    return { ok: !!payload.ok, message: payload.ok ? 'Settlement verified' : (payload.error ?? 'Verification failed') };
  }

  // ─── Phase 10H: game sessions ─────────────────────────────────────
  getSessionId(): string | null {
    return this.sessionId;
  }

  async startSession(clientBuild?: string): Promise<void> {
    if (!this.serverReady || !supabase) return;
    const { data, error } = await supabase.rpc('start_game_session', {
      p_client_build: clientBuild ?? null,
      p_device_hash: null,
      p_session_nonce: crypto.randomUUID(),
    });
    if (error || !data) return;
    this.sessionId = String((data as { id?: string }).id ?? '');
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.sessionId && supabase) {
        void supabase.rpc('heartbeat_game_session', { p_session_id: this.sessionId });
      }
    }, 60_000);
  }

  async endSession(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sessionId && supabase) {
      await supabase.rpc('end_game_session', { p_session_id: this.sessionId });
    }
    this.sessionId = null;
  }

  /** Call on logout / unmount to release realtime + reset to unauthenticated. */
  teardown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubscribeRealtime();
    this.currentUserId = null;
    this.mode = 'unavailable';
    this.serverReady = false;
    this.notify();
  }
}

export const rewardService = new RewardService();

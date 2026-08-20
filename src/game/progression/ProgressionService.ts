/**
 * ProgressionService.ts — centralized XP/REP/achievements/titles (Phase 10F).
 * All awards go through idempotency keys. UI must not mutate XP/REP directly.
 */

import { ACHIEVEMENT_CATALOG, achievementPointsFromProgress, getAchievement } from './AchievementCatalog';
import { progressionEvents } from './ProgressionEvents';
import {
  localProgressionRepository,
  type ProgressionRepository,
  resetProgressionStorage,
} from './ProgressionRepository';
import { deriveRankTier, rankDisplayName } from './RankLadder';
import { REP_REWARDS, XP_REWARDS, rewardKey } from './RewardTables';
import { getTitle, titleDisplayName } from './TitleCatalog';
import { unlocksForLevel } from './UnlockCatalog';
import { applyXpGain, levelProgressPercent, xpRequiredForLevel } from './XpCurve';
import type {
  PlayerProgression,
  PointsAwardResult,
  ProgressionSnapshot,
  RepAwardResult,
  XpAwardResult,
} from './types';

export interface LevelUpNotice {
  fromLevel: number;
  toLevel: number;
  unlockedTitles: string[];
  unlockedFeatures: string[];
}

type ChangeListener = (prog: PlayerProgression, meta?: { levelUps?: LevelUpNotice[] }) => void;

export class ProgressionService {
  private prog: PlayerProgression | null = null;
  private repo: ProgressionRepository;
  private listeners = new Set<ChangeListener>();
  private latestRewardKey: string | null = null;
  private playTimeAccumMs = 0;
  private distanceAccum = 0;
  private lastPersistAt = 0;
  private waveAwarded = false;
  private evaluatingAchievements = false;
  private achievementEvalDepth = 0;
  /** Debounce handle for server sync — fires at most once per SERVER_SYNC_DEBOUNCE_MS */
  private serverSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SERVER_SYNC_DEBOUNCE_MS = 10_000;

  constructor(repo: ProgressionRepository = localProgressionRepository) {
    this.repo = repo;
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(meta?: { levelUps?: LevelUpNotice[] }): void {
    if (!this.prog) return;
    for (const fn of this.listeners) fn(this.prog, meta);
  }

  private persist(force = false): void {
    if (!this.prog) return;
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 800) return;
    this.lastPersistAt = now;
    this.repo.save(this.prog);
  }

  /**
   * Debounced push to the server.  Collapses rapid reward bursts into a single
   * RPC call.  Guests are silently skipped inside syncToServer.
   * Must not block the calling code path — fire-and-forget.
   */
  private scheduleServerSync(): void {
    if (!this.prog || this.prog.isGuest) return;
    if (!this.repo.syncToServer) return;
    if (this.serverSyncTimer) clearTimeout(this.serverSyncTimer);
    this.serverSyncTimer = setTimeout(() => {
      this.serverSyncTimer = null;
      if (this.prog && this.repo.syncToServer) {
        void this.repo.syncToServer(this.prog);
      }
    }, ProgressionService.SERVER_SYNC_DEBOUNCE_MS);
  }

  /** Immediately flush any pending debounced sync.  Call on page unload / logout. */
  flushServerSync(): void {
    if (this.serverSyncTimer) {
      clearTimeout(this.serverSyncTimer);
      this.serverSyncTimer = null;
    }
    if (this.prog && !this.prog.isGuest && this.repo.syncToServer) {
      void this.repo.syncToServer(this.prog);
    }
  }

  init(playerId: string, isGuest: boolean, opts?: { seedRep?: number }): PlayerProgression {
    this.prog = this.repo.load(playerId, isGuest);
    if (opts?.seedRep != null && Number.isFinite(opts.seedRep)) {
      // Prefer higher of seed (Supabase) vs local — never silently overwrite higher progress
      if (opts.seedRep > this.prog.rep) {
        this.prog.rep = Math.floor(opts.seedRep);
        this.prog.statistics.totalRepEarned = Math.max(
          this.prog.statistics.totalRepEarned,
          this.prog.rep,
        );
      }
    }
    this.recomputeDerived();
    this.persist(true);
    this.notify();
    return this.prog;
  }

  get(): PlayerProgression | null {
    return this.prog;
  }

  require(): PlayerProgression {
    if (!this.prog) throw new Error('ProgressionService not initialized');
    return this.prog;
  }

  private recomputeDerived(): void {
    const p = this.require();
    const info = levelProgressPercent(p.lifetimeXp);
    p.level = info.level;
    p.currentXp = info.currentXp;
    p.statistics.lifetimeXp = p.lifetimeXp;
    p.unlockedFeatureIds = unlocksForLevel(p.level);
    p.rankTier = deriveRankTier({ level: p.level });

    // Handle Daily Streak & Points Initialization
    const today = new Date().toISOString().slice(0, 10);
    if (!p.streak) {
      p.streak = { current: 1, longest: 1, lastActiveDate: today, multiplier: 1.0 };
    }
    if (!p.points) {
      p.points = { daily: 0, weekly: 0, lifetime: 0 };
    }
    if (p.streak.lastActiveDate && p.streak.lastActiveDate !== today) {
      const prevDate = new Date(p.streak.lastActiveDate);
      const currDate = new Date(today);
      const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        p.streak.current += 1;
        if (p.streak.current > p.streak.longest) p.streak.longest = p.streak.current;
        progressionEvents.emit('streak_advanced', { current: p.streak.current, longest: p.streak.longest });
      } else if (diffDays > 1) {
        p.streak.current = 1;
      }
      p.streak.lastActiveDate = today;
      p.streak.multiplier = Math.min(2.0, 1.0 + (p.streak.current - 1) * 0.05);
      // Reset daily points on new calendar day (UTC)
      p.points.daily = 0;
    }

    p.statistics.uniqueLandmarksVisited = p.discoveredLandmarkIds.length;
    p.statistics.districtsVisited = p.discoveredDistrictIds.length;
    p.statistics.interiorsEntered = p.discoveredInteriorIds.length;
    p.statistics.uniquePlayersInteractedWith = p.uniquePlayerInteractIds.length;
    p.statistics.lastActiveAt = new Date().toISOString();
  }

  hasClaimed(key: string): boolean {
    return this.require().claimedRewardKeys.includes(key);
  }

  private markClaimed(key: string): void {
    const p = this.require();
    if (!p.claimedRewardKeys.includes(key)) p.claimedRewardKeys.push(key);
    this.latestRewardKey = key;
  }

  awardXp(opts: {
    amount: number;
    reason: string;
    idempotencyKey: string;
  }): XpAwardResult {
    const p = this.require();
    const amount = Math.max(0, Math.floor(opts.amount));
    const key = opts.idempotencyKey;
    if (amount <= 0 || this.hasClaimed(key)) {
      return {
        awarded: false,
        amount: 0,
        reason: opts.reason,
        key,
        levelsGained: 0,
        newLevel: p.level,
        previousLevel: p.level,
      };
    }
    this.markClaimed(key);
    const gain = applyXpGain(p.lifetimeXp, amount);
    p.lifetimeXp = gain.lifetimeXp;
    this.recomputeDerived();

    const levelUps: LevelUpNotice[] = [];
    if (gain.levelsGained > 0) {
      levelUps.push({
        fromLevel: gain.previousLevel,
        toLevel: gain.newLevel,
        unlockedTitles: [],
        unlockedFeatures: unlocksForLevel(gain.newLevel).filter(
          (id) => !unlocksForLevel(gain.previousLevel).includes(id),
        ),
      });
      progressionEvents.emit('level_up', {
        from: gain.previousLevel,
        to: gain.newLevel,
      });
    }

    progressionEvents.emit('xp_awarded', { amount, reason: opts.reason, key });
    this.evaluateAchievements();
    this.persist(true);
    this.notify(levelUps.length ? { levelUps } : undefined);
    this.scheduleServerSync();

    return {
      awarded: true,
      amount,
      reason: opts.reason,
      key,
      levelsGained: gain.levelsGained,
      newLevel: gain.newLevel,
      previousLevel: gain.previousLevel,
    };
  }

  awardRep(opts: {
    amount: number;
    reason: string;
    sourceId?: string;
    idempotencyKey: string;
  }): RepAwardResult {
    const p = this.require();
    const amount = Math.max(0, Math.floor(opts.amount));
    const key = opts.idempotencyKey;
    if (amount <= 0 || this.hasClaimed(key)) {
      return { awarded: false, amount: 0, reason: opts.reason, key, newRep: p.rep };
    }
    this.markClaimed(key);
    p.rep += amount;
    p.statistics.totalRepEarned += amount;
    this.recomputeDerived();
    progressionEvents.emit('rep_awarded', {
      amount,
      reason: opts.reason,
      sourceId: opts.sourceId,
      key,
    });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
    this.scheduleServerSync();
    return { awarded: true, amount, reason: opts.reason, key, newRep: p.rep };
  }

  awardPoints(opts: {
    amount: number;
    reason: string;
    idempotencyKey: string;
  }): PointsAwardResult {
    const p = this.require();
    const amount = Math.max(0, Math.floor(opts.amount));
    const key = opts.idempotencyKey;
    if (!p.points) {
      p.points = { daily: 0, weekly: 0, lifetime: 0 };
    }
    if (amount <= 0 || this.hasClaimed(key)) {
      return {
        awarded: false,
        amount: 0,
        reason: opts.reason,
        key,
        newDaily: p.points.daily,
        newWeekly: p.points.weekly,
        newLifetime: p.points.lifetime,
      };
    }
    this.markClaimed(key);
    p.points.daily += amount;
    p.points.weekly += amount;
    p.points.lifetime += amount;
    this.recomputeDerived();
    progressionEvents.emit('points_awarded', {
      amount,
      reason: opts.reason,
      key,
    });
    this.persist(true);
    this.notify();
    this.scheduleServerSync();
    return {
      awarded: true,
      amount,
      reason: opts.reason,
      key,
      newDaily: p.points.daily,
      newWeekly: p.points.weekly,
      newLifetime: p.points.lifetime,
    };
  }

  /**
   * Sync external REP grants that already mutated UI state (legacy paths).
   * Uses idempotency so the same key cannot double-count statistics.
   */
  recordExternalRepGrant(opts: {
    amount: number;
    reason: string;
    idempotencyKey: string;
  }): RepAwardResult {
    const p = this.require();
    const amount = Math.max(0, Math.floor(opts.amount));
    const key = opts.idempotencyKey;
    if (amount <= 0 || this.hasClaimed(key)) {
      // Still sync absolute REP if UI is ahead
      return { awarded: false, amount: 0, reason: opts.reason, key, newRep: p.rep };
    }
    this.markClaimed(key);
    p.rep += amount;
    p.statistics.totalRepEarned += amount;
    this.recomputeDerived();
    progressionEvents.emit('rep_awarded', { amount, reason: opts.reason, key, external: true });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
    this.scheduleServerSync();
    return { awarded: true, amount, reason: opts.reason, key, newRep: p.rep };
  }

  /** Keep progression.rep aligned when legacy setRep is the UI source of truth. */
  syncRepAbsolute(rep: number): void {
    const p = this.require();
    const next = Math.max(0, Math.floor(rep));
    if (next === p.rep) return;
    if (next > p.rep) {
      p.statistics.totalRepEarned += next - p.rep;
    }
    p.rep = next;
    this.recomputeDerived();
    this.persist();
    this.notify();
  }

  /** Align local cache to an authoritative Supabase progression snapshot. */
  syncFromServerSnapshot(snap: {
    lifetime_xp?: number;
    level?: number;
    rep?: number;
    claimed_reward_keys?: unknown;
    /** Phase 16 points fields */
    rug_points?: number;
    daily_points?: number;
    weekly_points?: number;
  }): void {
    const p = this.require();
    if (typeof snap.lifetime_xp === 'number' && Number.isFinite(snap.lifetime_xp)) {
      p.lifetimeXp = Math.max(0, Math.floor(snap.lifetime_xp));
    }
    if (typeof snap.rep === 'number' && Number.isFinite(snap.rep)) {
      const nextRep = Math.max(0, Math.floor(snap.rep));
      if (nextRep > p.rep) p.statistics.totalRepEarned += nextRep - p.rep;
      p.rep = nextRep;
    }
    const keys = snap.claimed_reward_keys;
    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (typeof key === 'string' && !p.claimedRewardKeys.includes(key)) {
          p.claimedRewardKeys.push(key);
        }
      }
    }
    // Phase 16: sync Points buckets from server (server is authoritative source).
    // Server max-wins: never let a stale sync reduce a higher local value.
    if (!p.points) p.points = { daily: 0, weekly: 0, lifetime: 0 };
    if (typeof snap.rug_points === 'number' && Number.isFinite(snap.rug_points)) {
      p.points.lifetime = Math.max(p.points.lifetime, Math.floor(snap.rug_points));
    }
    if (typeof snap.daily_points === 'number' && Number.isFinite(snap.daily_points)) {
      // Server may have reset the daily bucket — accept server value unconditionally
      // since the server performs the UTC reset and is authoritative.
      p.points.daily = Math.max(0, Math.floor(snap.daily_points));
    }
    if (typeof snap.weekly_points === 'number' && Number.isFinite(snap.weekly_points)) {
      p.points.weekly = Math.max(0, Math.floor(snap.weekly_points));
    }
    this.recomputeDerived();
    if (typeof snap.level === 'number' && Number.isFinite(snap.level)) {
      p.level = Math.max(1, Math.min(100, Math.floor(snap.level)));
    }
    this.persist(true);
    this.notify();
  }

  discoverDistrict(districtId: string, opts?: { skipAwards?: boolean }): boolean {
    const p = this.require();
    const key = rewardKey(['district', districtId, 'first_visit']);
    if (p.discoveredDistrictIds.includes(districtId) || this.hasClaimed(key)) return false;
    p.discoveredDistrictIds.push(districtId);
    if (!opts?.skipAwards) {
      this.awardXp({
        amount: XP_REWARDS.districtFirstVisit,
        reason: `Discovered district ${districtId}`,
        idempotencyKey: key,
      });
      this.awardRep({
        amount: REP_REWARDS.districtFirstVisit,
        reason: `Discovered district ${districtId}`,
        sourceId: districtId,
        idempotencyKey: rewardKey(['district', districtId, 'first_visit', 'rep']),
      });
    } else {
      this.markClaimed(key);
      this.markClaimed(rewardKey(['district', districtId, 'first_visit', 'rep']));
    }
    progressionEvents.emit('district_discovered', { districtId });
    progressionEvents.emit('discovery_notified', { kind: 'district', id: districtId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
    return true;
  }

  discoverLandmark(landmarkId: string, opts?: { skipAwards?: boolean }): boolean {
    const p = this.require();
    const key = rewardKey(['landmark', landmarkId, 'first_visit']);
    if (p.discoveredLandmarkIds.includes(landmarkId) || this.hasClaimed(key)) return false;
    p.discoveredLandmarkIds.push(landmarkId);
    if (!opts?.skipAwards) {
      this.awardXp({
        amount: XP_REWARDS.landmarkFirstVisit,
        reason: `Discovered landmark ${landmarkId}`,
        idempotencyKey: key,
      });
      this.awardRep({
        amount: REP_REWARDS.landmarkFirstVisit,
        reason: `Discovered landmark ${landmarkId}`,
        sourceId: landmarkId,
        idempotencyKey: rewardKey(['landmark', landmarkId, 'first_visit', 'rep']),
      });
    } else {
      this.markClaimed(key);
      this.markClaimed(rewardKey(['landmark', landmarkId, 'first_visit', 'rep']));
    }
    progressionEvents.emit('landmark_discovered', { landmarkId });
    progressionEvents.emit('discovery_notified', { kind: 'landmark', id: landmarkId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
    return true;
  }

  discoverInterior(interiorId: string, opts?: { skipAwards?: boolean }): boolean {
    const p = this.require();
    const key = rewardKey(['interior', interiorId, 'first_visit']);
    if (p.discoveredInteriorIds.includes(interiorId) || this.hasClaimed(key)) return false;
    p.discoveredInteriorIds.push(interiorId);
    if (!opts?.skipAwards) {
      this.awardXp({
        amount: XP_REWARDS.interiorFirstVisit,
        reason: `Entered interior ${interiorId}`,
        idempotencyKey: key,
      });
      this.awardRep({
        amount: REP_REWARDS.interiorFirstVisit,
        reason: `Entered interior ${interiorId}`,
        sourceId: interiorId,
        idempotencyKey: rewardKey(['interior', interiorId, 'first_visit', 'rep']),
      });
    } else {
      this.markClaimed(key);
      this.markClaimed(rewardKey(['interior', interiorId, 'first_visit', 'rep']));
    }
    progressionEvents.emit('interior_entered', { interiorId });
    progressionEvents.emit('discovery_notified', { kind: 'interior', id: interiorId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
    return true;
  }

  onMissionCompleted(missionId: string, rewardXp: number = XP_REWARDS.missionComplete): void {
    const key = rewardKey(['mission', missionId, 'complete']);
    this.awardXp({
      amount: rewardXp,
      reason: `Mission ${missionId}`,
      idempotencyKey: key,
    });
    const p = this.require();
    p.statistics.missionsCompleted = p.claimedRewardKeys.filter((k) =>
      k.startsWith('mission:') && k.endsWith(':complete'),
    ).length;
    progressionEvents.emit('mission_completed', { missionId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
  }

  onCityEventJoined(eventId: string, claimId: string | number): void {
    const key = rewardKey(['event', eventId, String(claimId), 'join']);
    if (this.hasClaimed(key)) return;
    const p = this.require();
    this.markClaimed(key);
    p.statistics.cityEventsJoined += 1;
    this.awardXp({
      amount: XP_REWARDS.cityEventJoin,
      reason: `Joined event ${eventId}`,
      idempotencyKey: rewardKey(['event', eventId, String(claimId), 'xp']),
    });
    progressionEvents.emit('city_event_joined', { eventId, claimId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
  }

  onPlayerInteracted(otherPlayerId: string): void {
    const p = this.require();
    if (p.uniquePlayerInteractIds.includes(otherPlayerId)) return;
    const key = rewardKey(['social', 'player', otherPlayerId, 'interact']);
    if (this.hasClaimed(key)) return;
    p.uniquePlayerInteractIds.push(otherPlayerId);
    this.awardXp({
      amount: XP_REWARDS.playerInteractUnique,
      reason: 'Met a real player',
      idempotencyKey: key,
    });
    this.awardRep({
      amount: REP_REWARDS.playerInteractUnique,
      reason: 'Met a real player',
      sourceId: otherPlayerId,
      idempotencyKey: rewardKey(['social', 'player', otherPlayerId, 'interact', 'rep']),
    });
    progressionEvents.emit('player_interacted', { otherPlayerId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
  }

  onWaveSent(): void {
    if (this.waveAwarded || this.hasClaimed('social:wave:once')) return;
    this.waveAwarded = true;
    this.awardXp({
      amount: XP_REWARDS.waveOnce,
      reason: 'Waved at a player',
      idempotencyKey: 'social:wave:once',
    });
    progressionEvents.emit('wave_sent', {});
    this.evaluateAchievements();
  }

  onFountainClaimed(): void {
    this.awardXp({
      amount: XP_REWARDS.fountainClaimOnce,
      reason: 'Fountain claim',
      idempotencyKey: 'fountain:claim:first',
    });
    progressionEvents.emit('fountain_claimed', {});
    this.evaluateAchievements();
  }

  onTutorialLevelComplete(levelId: number): void {
    this.awardXp({
      amount: XP_REWARDS.tutorialLevelComplete,
      reason: `Tutorial level ${levelId}`,
      idempotencyKey: rewardKey(['tutorial_level', String(levelId), 'complete']),
    });
  }

  equipTitle(titleId: string): boolean {
    const p = this.require();
    if (!p.unlockedTitleIds.includes(titleId)) return false;
    if (!getTitle(titleId)) return false;
    p.equippedTitleId = titleId;
    progressionEvents.emit('title_equipped', { titleId });
    this.evaluateAchievements();
    this.persist(true);
    this.notify();
    return true;
  }

  unequipTitle(): void {
    const p = this.require();
    p.equippedTitleId = null;
    this.persist(true);
    this.notify();
  }

  private unlockTitle(titleId: string): void {
    const p = this.require();
    if (!getTitle(titleId)) return;
    if (p.unlockedTitleIds.includes(titleId)) return;
    p.unlockedTitleIds.push(titleId);
    progressionEvents.emit('title_unlocked', { titleId });
    if (!p.equippedTitleId) {
      p.equippedTitleId = titleId;
      progressionEvents.emit('title_equipped', { titleId });
    }
  }

  private setAchievementProgress(id: string, value: number): void {
    const def = getAchievement(id);
    if (!def) return;
    const p = this.require();
    const cur = p.achievementProgress[id] ?? { current: 0, completed: false };
    if (cur.completed) return;
    const next = Math.min(def.target, Math.max(cur.current, Math.floor(value)));
    cur.current = next;
    if (next >= def.target) {
      cur.completed = true;
      cur.completedAt = new Date().toISOString();
      p.achievementProgress[id] = cur;
      progressionEvents.emit('achievement_unlocked', { id, name: def.name });
      if (def.titleUnlockId) this.unlockTitle(def.titleUnlockId);
      if (def.xpReward > 0) {
        this.awardXp({
          amount: def.xpReward,
          reason: `Achievement ${def.id}`,
          idempotencyKey: rewardKey(['achievement', def.id, 'xp']),
        });
      }
      if (def.repReward > 0) {
        this.awardRep({
          amount: def.repReward,
          reason: `Achievement ${def.id}`,
          sourceId: def.id,
          idempotencyKey: rewardKey(['achievement', def.id, 'rep']),
        });
      }
    } else {
      p.achievementProgress[id] = cur;
    }
  }

  evaluateAchievements(): void {
    if (this.evaluatingAchievements) return;
    if (this.achievementEvalDepth > 3) return;
    this.evaluatingAchievements = true;
    this.achievementEvalDepth += 1;
    let unlockedAny = false;
    try {
      const p = this.require();
      for (const a of ACHIEVEMENT_CATALOG) {
        let value = 0;
        switch (a.progressSource) {
          case 'missions_completed':
            value = p.statistics.missionsCompleted;
            break;
          case 'landmarks_visited':
            value = p.discoveredLandmarkIds.length;
            break;
          case 'districts_visited':
            value = p.discoveredDistrictIds.length;
            break;
          case 'interiors_entered':
            value = p.discoveredInteriorIds.length;
            break;
          case 'city_events_joined':
            value = p.statistics.cityEventsJoined;
            break;
          case 'unique_players_interacted':
            value = p.uniquePlayerInteractIds.length;
            break;
          case 'level':
            value = p.level;
            break;
          case 'rep':
            value = p.rep;
            break;
          case 'title_equipped':
            value = p.equippedTitleId ? 1 : 0;
            break;
          case 'fountain_claimed':
            value = this.hasClaimed('fountain:claim:first') ? 1 : 0;
            break;
          case 'wave_sent':
            value = this.hasClaimed('social:wave:once') ? 1 : 0;
            break;
          case 'specific_district':
            value = a.sourceId && p.discoveredDistrictIds.includes(a.sourceId) ? 1 : 0;
            break;
          case 'specific_landmark':
            value = a.sourceId && p.discoveredLandmarkIds.includes(a.sourceId) ? 1 : 0;
            break;
          case 'specific_interior':
            value = a.sourceId && p.discoveredInteriorIds.includes(a.sourceId) ? 1 : 0;
            break;
          default:
            value = 0;
        }
        const before = p.achievementProgress[a.id]?.completed;
        this.setAchievementProgress(a.id, value);
        if (!before && p.achievementProgress[a.id]?.completed) unlockedAny = true;
      }
      this.recomputeDerived();
    } finally {
      this.evaluatingAchievements = false;
    }
    if (unlockedAny) this.evaluateAchievements();
    this.achievementEvalDepth = Math.max(0, this.achievementEvalDepth - 1);
  }

  /** Checkpoint playtime / distance without per-frame writes. */
  tickActivity(deltaMs: number, distanceDelta: number): void {
    this.playTimeAccumMs += deltaMs;
    this.distanceAccum += distanceDelta;
    if (this.playTimeAccumMs < 15_000 && this.distanceAccum < 200) return;
    const p = this.require();
    p.statistics.playTimeSeconds += Math.floor(this.playTimeAccumMs / 1000);
    p.statistics.distanceTravelled += Math.floor(this.distanceAccum);
    this.playTimeAccumMs = 0;
    this.distanceAccum = 0;
    this.persist();
  }

  snapshot(): ProgressionSnapshot {
    const p = this.require();
    const info = levelProgressPercent(p.lifetimeXp);
    const completed = Object.values(p.achievementProgress).filter((x) => x.completed).length;
    const latest = progressionEvents.getLatest();
    return {
      level: p.level,
      currentXp: info.currentXp,
      xpToNext: info.level >= 100 ? 0 : xpRequiredForLevel(info.level),
      progressPercent: info.percent,
      lifetimeXp: p.lifetimeXp,
      rep: p.rep,
      pointsDaily: p.points?.daily ?? 0,
      pointsWeekly: p.points?.weekly ?? 0,
      pointsLifetime: p.points?.lifetime ?? 0,
      currentStreak: p.streak?.current ?? 1,
      streakMultiplier: p.streak?.multiplier ?? 1.0,
      rankTier: p.rankTier,
      rankLabel: rankDisplayName(p.rankTier),
      equippedTitleId: p.equippedTitleId,
      equippedTitleName: titleDisplayName(p.equippedTitleId),
      achievementCompleted: completed,
      achievementTotal: ACHIEVEMENT_CATALOG.length,
      discoveryLandmarks: p.discoveredLandmarkIds.length,
      discoveryDistricts: p.discoveredDistrictIds.length,
      seasonPoints: p.season.seasonId ? p.season.seasonPoints : 0,
      latestEvent: latest?.type ?? null,
      latestRewardKey: this.latestRewardKey,
    };
  }

  /* ── Dev-only tools ── */
  debugGrantXp(amount: number): void {
    if (!import.meta.env.DEV) return;
    const key = `debug:xp:${Date.now()}`;
    this.awardXp({ amount, reason: 'debug', idempotencyKey: key });
  }

  debugGrantRep(amount: number): void {
    if (!import.meta.env.DEV) return;
    const key = `debug:rep:${Date.now()}`;
    this.awardRep({ amount, reason: 'debug', idempotencyKey: key });
  }

  debugUnlockAchievement(id: string): void {
    if (!import.meta.env.DEV) return;
    const def = getAchievement(id);
    if (!def) return;
    this.setAchievementProgress(id, def.target);
    this.persist(true);
    this.notify();
  }

  debugReset(): void {
    if (!import.meta.env.DEV || !this.prog) return;
    resetProgressionStorage(this.prog.playerId);
    this.init(this.prog.playerId, this.prog.isGuest, { seedRep: 0 });
  }
}

/** Shared singleton used by GamePage / WorldScene bridge. */
export const progressionService = new ProgressionService();

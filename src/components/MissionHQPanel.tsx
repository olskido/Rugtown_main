/**
 * MissionHQPanel.tsx — Mission HQ (Government Quarter's gameplay purpose).
 *
 * Browse daily/weekly missions, claim rewards, and see level progress —
 * reuses the existing RewardService (daily/weekly assignments + claim RPC)
 * and ProgressionService (level/XP) singletons rather than duplicating any
 * state. Tabbed to avoid overwhelming the screen (brief: "Do not overwhelm
 * the screen. Use tabs/categories if needed.").
 */

import React, { useEffect, useState, useCallback } from 'react';
import { rewardService } from '../game/rewards/RewardService';
import { progressionService } from '../game/progression';
import { recordDailyParticipation } from '../lib/activity';
import type { MissionAssignmentView } from '../game/rewards/types';

type Tab = 'daily' | 'weekly' | 'progress';

export interface MissionHQPanelProps {
  open: boolean;
  onClose: () => void;
  onToast?: (text: string) => void;
  onFocusMission?: () => void;
}

function MissionRow({ mission, onClaim, claiming, onFocusMission }: {
  mission: MissionAssignmentView;
  onClaim: (id: string) => void;
  claiming: boolean;
  onFocusMission?: () => void;
}) {
  const pct = mission.target > 0 ? Math.min(100, Math.round((mission.progress / mission.target) * 100)) : 0;
  const canClaim = mission.status === 'completed';
  const claimed = mission.status === 'claimed';
  return (
    <div
      className={`missionhq-row${claimed ? ' missionhq-row--claimed' : ''}${onFocusMission ? ' missionhq-row--focusable' : ''}`}
      onClick={() => onFocusMission?.()}
      role={onFocusMission ? 'button' : undefined}
      tabIndex={onFocusMission ? 0 : undefined}
      onKeyDown={(e) => { if (onFocusMission && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onFocusMission(); } }}
    >
      <div className="missionhq-row__main">
        <div className="missionhq-row__title">{mission.title}</div>
        <div className="missionhq-row__desc">{mission.description}</div>
        <div className="missionhq-row__progress-track">
          <div className="missionhq-row__progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="missionhq-row__progress-label">{mission.progress}/{mission.target}</div>
      </div>
      <div className="missionhq-row__rewards">
        <span>+{mission.xpReward} XP</span>
        <span>+{mission.repReward} REP</span>
        <span>+{mission.rugPoints} Pts</span>
      </div>
      <button
        type="button"
        className="missionhq-row__claim"
        disabled={!canClaim || claiming}
        onClick={(e) => { e.stopPropagation(); onClaim(mission.id); }}
      >
        {claimed ? 'Claimed' : canClaim ? (claiming ? 'Claiming…' : 'Claim') : 'In progress'}
      </button>
    </div>
  );
}

export function MissionHQPanel({ open, onClose, onToast, onFocusMission }: MissionHQPanelProps) {
  const [tab, setTab] = useState<Tab>('daily');
  const [, forceRerender] = useState(0);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const snapshot = progressionService.get();

  useEffect(() => {
    if (!open) return;
    const unsub = rewardService.subscribe(() => forceRerender((n) => n + 1));
    return unsub;
  }, [open]);

  const handleClaim = useCallback(async (assignmentId: string) => {
    setClaimingId(assignmentId);
    try {
      const result = await rewardService.claimMission(assignmentId);
      onToast?.(result.ok ? `🎁 ${result.message}` : result.message);
      // A claimed mission is exactly the kind of "meaningful daily activity"
      // the streak system should count — see record_daily_participation's
      // idempotency (safe even if called multiple times the same UTC day).
      if (result.ok) void recordDailyParticipation();
    } finally {
      setClaimingId(null);
    }
  }, [onToast]);

  if (!open) return null;

  const daily = rewardService.getDailyMissions();
  const weekly = rewardService.getWeeklyMissions();
  const level = snapshot?.level ?? 1;
  const xpInfo = snapshot ? progressionService.snapshot() : null;

  return (
    <div
      className="panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Mission HQ"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel panel--missionhq">
        <div className="panel__header">
          <span className="panel__header-icon">🏛️</span>
          <h2 className="panel__title">Mission HQ</h2>
          <button className="panel__close" onClick={onClose} aria-label="Close Mission HQ" type="button">✕</button>
        </div>

        <div className="missionhq-tabs" role="tablist">
          {([
            { key: 'daily' as const, label: `Daily (${daily.filter((m) => m.status !== 'claimed').length})` },
            { key: 'weekly' as const, label: `Weekly (${weekly.filter((m) => m.status !== 'claimed').length})` },
            { key: 'progress' as const, label: 'Progress' },
          ]).map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`missionhq-tab${tab === t.key ? ' missionhq-tab--active' : ''}`}
              onClick={() => setTab(t.key)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'daily' && (
          <div className="missionhq-list">
            {daily.length === 0 && <div className="missionhq-empty">No daily missions assigned yet — sign in to receive today's set.</div>}
            {daily.map((m) => (
              <MissionRow key={m.id} mission={m} onClaim={handleClaim} claiming={claimingId === m.id} onFocusMission={onFocusMission} />
            ))}
          </div>
        )}

        {tab === 'weekly' && (
          <div className="missionhq-list">
            {weekly.length === 0 && <div className="missionhq-empty">No weekly missions assigned yet.</div>}
            {weekly.map((m) => (
              <MissionRow key={m.id} mission={m} onClaim={handleClaim} claiming={claimingId === m.id} onFocusMission={onFocusMission} />
            ))}
          </div>
        )}

        {tab === 'progress' && (
          <div className="missionhq-progress">
            <div className="missionhq-progress__level">Level {level} · {snapshot?.rankTier ?? ''}</div>
            {xpInfo && (
              <>
                <div className="missionhq-row__progress-track">
                  <div className="missionhq-row__progress-fill" style={{ width: `${xpInfo.progressPercent}%` }} />
                </div>
                <div className="missionhq-row__progress-label">
                  {xpInfo.currentXp}/{xpInfo.xpToNext || xpInfo.currentXp} XP to next level
                </div>
              </>
            )}
            <div className="missionhq-progress__stats">
              <span>REP: {snapshot?.rep ?? 0}</span>
              <span>Points (lifetime): {snapshot?.points?.lifetime ?? 0}</span>
              <span>Streak: {snapshot?.streak?.current ?? 0} days</span>
            </div>
            <p className="missionhq-progress__hint">
              Chapter, story, and tier-bracket missions appear in your active Mission HUD as you explore the city — Mission HQ
              tracks your daily/weekly assignments and overall level progress in one place.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

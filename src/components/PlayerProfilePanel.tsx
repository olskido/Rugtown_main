/**
 * PlayerProfilePanel.tsx — full identity / progression profile (Phase 10F).
 */

import type { PlayerProgression } from '../game/progression/types';
import { ACHIEVEMENT_CATALOG } from '../game/progression/AchievementCatalog';
import { rankDisplayName } from '../game/progression/RankLadder';
import { shouldShowSeasonUi } from '../game/progression/SeasonFoundation';
import { TITLE_CATALOG, titleDisplayName } from '../game/progression/TitleCatalog';
import { levelProgressPercent } from '../game/progression/XpCurve';

export interface PlayerProfilePanelProps {
  open: boolean;
  onClose: () => void;
  progression: PlayerProgression;
  username: string;
  holderTier: string;
  online?: boolean;
  onEquipTitle: (titleId: string) => void;
  /** Signs out (guest or authenticated) and returns to the homepage.
   *  Shown for every account type, not just signed-in ones. */
  onSignOut?: () => void;
}

export function PlayerProfilePanel({
  open,
  onClose,
  progression,
  username,
  holderTier,
  online = true,
  onEquipTitle,
  onSignOut,
}: PlayerProfilePanelProps) {
  if (!open) return null;

  const xp = levelProgressPercent(progression.lifetimeXp);
  const completedAch = Object.values(progression.achievementProgress).filter((a) => a.completed).length;
  const showSeason = shouldShowSeasonUi(progression.season);
  const equippedName = titleDisplayName(progression.equippedTitleId);

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      data-ui-block-camera
      role="dialog"
      aria-modal="true"
      aria-label="Player profile"
    >
      <div className="modal-panel player-profile-full" onClick={(e) => e.stopPropagation()}>
        <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
        <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
        <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
        <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

        <div className="modal-header">
          <span className="modal-header__icon" aria-hidden>◆</span>
          <div className="modal-header__titles">
            <span className="modal-header__title">{username}</span>
            <span className="modal-header__sub">
              {progression.isGuest ? 'Guest' : 'Citizen'}
              {equippedName ? ` · ${equippedName}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="modal-close modal-close--profile"
            onClick={onClose}
            aria-label="Close profile"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="modal-body player-profile-full__body">
          <div className="profile-xp-block">
            <div className="profile-xp-block__row">
              <span>Level {xp.level}</span>
              <span>{Math.round(xp.percent)}%</span>
            </div>
            <div className="profile-xp-bar" aria-hidden>
              <div className="profile-xp-bar__fill" style={{ width: `${xp.percent}%` }} />
            </div>
            <div className="profile-xp-block__meta">
              {xp.level >= 50
                ? `${xp.currentXp.toLocaleString()} XP (max level)`
                : `${xp.currentXp.toLocaleString()} / ${xp.xpToNext.toLocaleString()} XP`}
            </div>
          </div>

          <div className="whale-alert-row">
            <span className="whale-alert-row__label">Rank</span>
            <span className="whale-alert-row__value whale-alert-row__value--gold">
              {rankDisplayName(progression.rankTier)}
            </span>
          </div>
          <div className="whale-alert-row">
            <span className="whale-alert-row__label">REP</span>
            <span className="whale-alert-row__value whale-alert-row__value--gold">
              {progression.rep.toLocaleString()}
            </span>
          </div>
          <div className="whale-alert-row">
            <span className="whale-alert-row__label">Holder Tier</span>
            <span className="whale-alert-row__value">{holderTier}</span>
          </div>
          <div className="whale-alert-row">
            <span className="whale-alert-row__label">Status</span>
            <span className={online ? 'player-online-badge' : 'player-offline-badge'}>
              {online ? 'Online' : 'Offline'}
            </span>
          </div>
          <div className="whale-alert-row">
            <span className="whale-alert-row__label">Achievements</span>
            <span className="whale-alert-row__value">
              {completedAch} / {ACHIEVEMENT_CATALOG.length}
            </span>
          </div>
          <div className="whale-alert-row">
            <span className="whale-alert-row__label">Exploration</span>
            <span className="whale-alert-row__value">
              {progression.discoveredLandmarkIds.length}/20 landmarks ·{' '}
              {progression.discoveredDistrictIds.length}/5 districts ·{' '}
              {progression.discoveredInteriorIds.length} interiors
            </span>
          </div>

          {showSeason && (
            <div className="whale-alert-row">
              <span className="whale-alert-row__label">Season</span>
              <span className="whale-alert-row__value">
                {progression.season.seasonPoints} pts
              </span>
            </div>
          )}

          <div className="profile-stats-grid">
            <div><em>Missions</em><strong>{progression.statistics.missionsCompleted}</strong></div>
            <div><em>Events</em><strong>{progression.statistics.cityEventsJoined}</strong></div>
            <div><em>Players met</em><strong>{progression.statistics.uniquePlayersInteractedWith}</strong></div>
            <div><em>Play time</em><strong>{Math.floor(progression.statistics.playTimeSeconds / 60)}m</strong></div>
          </div>

          <h3 className="profile-section-title">Titles</h3>
          <div className="profile-title-list">
            {TITLE_CATALOG.filter((t) => progression.unlockedTitleIds.includes(t.id)).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`profile-title-chip${progression.equippedTitleId === t.id ? ' profile-title-chip--equipped' : ''}`}
                onClick={() => onEquipTitle(t.id)}
              >
                {t.displayName}
              </button>
            ))}
            {progression.unlockedTitleIds.length === 0 && (
              <span className="profile-empty">No titles unlocked yet.</span>
            )}
          </div>

          <h3 className="profile-section-title">Recent Achievements</h3>
          <ul className="profile-ach-list">
            {ACHIEVEMENT_CATALOG.filter((a) => progression.achievementProgress[a.id]?.completed)
              .slice(-6)
              .reverse()
              .map((a) => (
                <li key={a.id}>
                  <strong>{a.name}</strong>
                  <span>{a.description}</span>
                </li>
              ))}
            {completedAch === 0 && <li className="profile-empty">Complete discoveries and missions to earn achievements.</li>}
          </ul>

          {progression.isGuest && (
            <p className="profile-guest-warn">
              Guest progress is saved in this browser. Clearing site data will erase it — sign in to keep a stable identity.
            </p>
          )}

          {onSignOut && (
            <button
              type="button"
              className="settings-action-btn profile-signout-btn"
              onClick={onSignOut}
              aria-label={progression.isGuest ? 'Leave guest mode and return to homepage to sign in' : 'Sign out and return to homepage'}
            >
              {progression.isGuest ? '🏠 Exit to Homepage' : '🚪 Sign Out'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

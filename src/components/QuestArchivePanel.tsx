/**
 * QuestArchivePanel.tsx — Quest Archive (the Cashback Vault building's new
 * gameplay purpose, replacing the old $RUGTOWN-token-gated vault UI).
 *
 * Shows the player's discovered/completed hidden quests with lore and
 * rewards, sourced from the server-authoritative hidden_quest_state table
 * (getMyHiddenQuests) cross-referenced against the client lore catalog
 * (CANONICAL_HIDDEN_QUESTS) for title/description/clue text. No wallet,
 * token, or holder-status content — hidden quests are the archive's whole
 * subject, matching the rest of the leaderboard/mission-driven product.
 */

import React, { useEffect, useState } from 'react';
import { getMyHiddenQuests, type HiddenQuestServerState } from '../lib/hiddenQuests';
import { CANONICAL_HIDDEN_QUESTS } from '../game/missions/HiddenQuestDirector';

export interface QuestArchivePanelProps {
  open: boolean;
  onClose: () => void;
}

export function QuestArchivePanel({ open, onClose }: QuestArchivePanelProps) {
  const [serverState, setServerState] = useState<HiddenQuestServerState[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void getMyHiddenQuests().then((rows) => {
      if (!cancelled) {
        setServerState(rows);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  const stateByQuestId = new Map(serverState.map((s) => [s.questId, s]));
  const discoveredCount = serverState.length;
  const completedCount = serverState.filter((s) => s.status === 'completed').length;

  return (
    <div className="modal-backdrop" role="dialog" aria-label="Quest Archive">
      <div className="modal-panel">
        <header className="modal-header">
          <span className="modal-header__title">Quest Archive</span>
          <span className="modal-header__sub">
            {completedCount}/{CANONICAL_HIDDEN_QUESTS.length} hidden quests completed · {discoveredCount} discovered
          </span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {loading ? (
          <p className="modal-text">Loading archive…</p>
        ) : (
          <ul className="reward-mission-list">
            {CANONICAL_HIDDEN_QUESTS.map((quest) => {
              const state = stateByQuestId.get(quest.id);
              const status: 'unknown' | 'discovered' | 'completed' =
                state?.status === 'completed' ? 'completed' : state ? 'discovered' : 'unknown';
              return (
                <li key={quest.id} className={`reward-mission-list__item reward-mission-list__item--${status}`}>
                  <div className="reward-mission-list__main">
                    <strong>{status === 'unknown' ? '??? — Undiscovered' : quest.title}</strong>
                    <span className="reward-centre__meta">
                      {status === 'unknown'
                        ? 'This quest has not been found yet. Explore the city to uncover it.'
                        : status === 'discovered'
                          ? quest.clueText
                          : quest.description}
                    </span>
                    {status !== 'unknown' && (
                      <span className="reward-centre__meta">
                        Reward: +{quest.rewardXp} XP · +{quest.rewardRep} REP · +{quest.rewardPoints} Pts
                        {quest.titleUnlockId ? ' · unlocks a title' : ''}
                      </span>
                    )}
                  </div>
                  <span className={`modal-locked-tag${status === 'completed' ? ' modal-locked-tag--done' : ''}`}>
                    {status === 'unknown' ? 'Unknown' : status === 'discovered' ? 'In Progress' : 'Completed'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

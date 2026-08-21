/**
 * LevelUpToast.tsx — compact level-up celebration (Phase 10F).
 */

import { useEffect, useState } from 'react';
import type { LevelUpNotice } from '../game/progression/ProgressionService';
import { titleDisplayName } from '../game/progression/TitleCatalog';

export interface LevelUpToastProps {
  notice: LevelUpNotice | null;
  onDismiss: () => void;
}

export function LevelUpToast({ notice, onDismiss }: LevelUpToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!notice) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = window.setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, 4200);
    return () => window.clearTimeout(t);
  }, [notice, onDismiss]);

  if (!notice || !visible) return null;

  const titleNames = notice.unlockedTitles
    .map((id) => titleDisplayName(id))
    .filter(Boolean);

  return (
    <div className="level-up-toast" role="status" aria-live="polite" data-ui-block-camera>
      <button
        className="level-up-toast__close"
        onClick={() => { setVisible(false); onDismiss(); }}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
      <div className="level-up-toast__burst" aria-hidden />
      <span className="level-up-toast__label">Level Up</span>
      <span className="level-up-toast__level">{notice.toLevel}</span>
      {(titleNames.length > 0 || notice.unlockedFeatures.length > 0) && (
        <span className="level-up-toast__unlocks">
          {titleNames.length > 0 && `Title: ${titleNames.join(', ')}`}
          {titleNames.length > 0 && notice.unlockedFeatures.length > 0 ? ' · ' : ''}
          {notice.unlockedFeatures.length > 0 && 'New profile features unlocked'}
        </span>
      )}
    </div>
  );
}

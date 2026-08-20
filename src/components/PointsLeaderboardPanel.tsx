/**
 * PointsLeaderboardPanel.tsx — Daily / Weekly / All-Time Points Leaderboard.
 *
 * • Three tabs: Daily, Weekly, All-Time — each backed by the real
 *   get_points_leaderboard RPC (server-side ranked query, never loads the
 *   full player table) plus get_my_leaderboard_rank for "Your Rank".
 * • Guests / unconfigured Supabase fall back to local NPC seed data so the
 *   panel still renders something meaningful offline — clearly labeled.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { progressionService } from '../game/progression';
import { getPointsLeaderboard, getMyLeaderboardRank } from '../lib/leaderboard';

/* ─── Types ─── */
export interface LeaderboardEntry {
  rank: number;
  username: string;
  points: number;
  level?: number;
  rep?: number;
  isPlayer?: boolean;
}

type LeaderboardScope = 'daily' | 'weekly' | 'alltime';
const SCOPE_TO_PERIOD: Record<LeaderboardScope, 'daily' | 'weekly' | 'all_time'> = {
  daily: 'daily',
  weekly: 'weekly',
  alltime: 'all_time',
};

/* ─── NPC seed data — guest/offline fallback only, deterministic, never changes without a code push ─── */
const NPC_SEED: Omit<LeaderboardEntry, 'rank'>[] = [
  { username: 'WhaleGhost',     points: 14_820 },
  { username: 'AlphaAisha',     points: 12_305 },
  { username: 'ChartChad',      points: 11_100 },
  { username: 'LiquidityLarry', points: 9_840  },
  { username: 'MoonboyNPC',     points: 8_620  },
  { username: 'BagHolderBen',   points: 7_415  },
  { username: 'RugSlayerNPC',   points: 6_230  },
  { username: 'PumpGoblin',     points: 5_080  },
  { username: 'DumpDemon',      points: 3_950  },
  { username: 'JeetBot',        points: 2_740  },
];

function scaleSeedForScope(scope: LeaderboardScope): Omit<LeaderboardEntry, 'rank'>[] {
  const factor = scope === 'daily' ? 0.05 : scope === 'weekly' ? 0.3 : 1;
  return NPC_SEED.map((e) => ({ ...e, points: Math.round(e.points * factor) }));
}

function buildLocalLeaderboard(
  scope: LeaderboardScope,
  playerName: string,
  playerPoints: number,
  playerLevel: number,
): LeaderboardEntry[] {
  const scaled = scaleSeedForScope(scope);
  const playerRow: Omit<LeaderboardEntry, 'rank'> = {
    username: playerName || 'You',
    points: playerPoints,
    level: playerLevel,
    isPlayer: true,
  };
  const merged = [...scaled, playerRow].sort((a, b) => b.points - a.points);
  return merged.map((e, i) => ({ ...e, rank: i + 1 }));
}

function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

/* ─── Props ─── */
export interface PointsLeaderboardPanelProps {
  open: boolean;
  onClose: () => void;
  playerName: string;
  isGuest?: boolean;
}

/* ─── Component ─── */
export function PointsLeaderboardPanel({
  open,
  onClose,
  playerName,
  isGuest = false,
}: PointsLeaderboardPanelProps) {
  const [scope, setScope] = useState<LeaderboardScope>('weekly');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [myRank, setMyRank] = useState<{ rank: number; points: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [usedFallback, setUsedFallback] = useState(false);

  const loadServerLeaderboard = useCallback(async (s: LeaderboardScope) => {
    setLoading(true);
    try {
      const period = SCOPE_TO_PERIOD[s];
      const [rows, rank] = await Promise.all([
        getPointsLeaderboard(period, 15, 0),
        getMyLeaderboardRank(period),
      ]);
      if (rows) {
        setEntries(
          rows.map((r) => ({
            rank: r.rank,
            username: r.username,
            points: r.points,
            level: r.level,
            rep: r.rep,
            isPlayer: r.playerId === rank?.playerId,
          })),
        );
        setUsedFallback(false);
      } else {
        throw new Error('leaderboard RPC unavailable');
      }
      if (rank) setMyRank({ rank: rank.rank, points: rank.points });
    } catch {
      // Pre-Phase-2 database, or offline -- fall back to local seed data
      // rather than showing an empty panel.
      const prog = progressionService.get();
      const pts = prog?.points ?? { daily: 0, weekly: 0, lifetime: 0 };
      const playerPoints = s === 'daily' ? pts.daily : s === 'weekly' ? pts.weekly : pts.lifetime;
      setEntries(buildLocalLeaderboard(s, playerName, playerPoints, prog?.level ?? 1));
      setMyRank(null);
      setUsedFallback(true);
    } finally {
      setLoading(false);
    }
  }, [playerName]);

  useEffect(() => {
    if (!open) return;
    if (isGuest) {
      const prog = progressionService.get();
      const pts = prog?.points ?? { daily: 0, weekly: 0, lifetime: 0 };
      const playerPoints = scope === 'daily' ? pts.daily : scope === 'weekly' ? pts.weekly : pts.lifetime;
      setEntries(buildLocalLeaderboard(scope, playerName, playerPoints, prog?.level ?? 1));
      setUsedFallback(true);
      return;
    }
    void loadServerLeaderboard(scope);
  }, [open, scope, isGuest, playerName, loadServerLeaderboard]);

  if (!open) return null;

  const TABS: { key: LeaderboardScope; label: string }[] = [
    { key: 'daily',   label: 'Daily'    },
    { key: 'weekly',  label: 'Weekly'   },
    { key: 'alltime', label: 'All Time' },
  ];

  const playerRow = entries.find((e) => e.isPlayer);

  return (
    <div
      className="panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Points Leaderboard"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel panel--leaderboard">
        {/* Header */}
        <div className="panel__header">
          <span className="panel__header-icon">🏆</span>
          <h2 className="panel__title">Points Leaderboard</h2>
          <button
            className="panel__close"
            onClick={onClose}
            aria-label="Close leaderboard"
            type="button"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="leaderboard-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={scope === t.key}
              className={`leaderboard-tab${scope === t.key ? ' leaderboard-tab--active' : ''}`}
              onClick={() => setScope(t.key)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Guest / offline notice */}
        {(isGuest || usedFallback) && (
          <div className="leaderboard-notice">
            {isGuest
              ? 'Sign in to appear on the global leaderboard — your Points are tracked locally.'
              : 'Showing local preview data — the live leaderboard could not be reached.'}
          </div>
        )}

        {/* Your Rank callout — server rank when available, else derived from the local list */}
        {(myRank || playerRow) && (
          <div className="leaderboard-player-rank">
            <span className="leaderboard-player-rank__label">Your Rank</span>
            <span className="leaderboard-player-rank__badge">{rankMedal(myRank?.rank ?? playerRow!.rank)}</span>
            <span className="leaderboard-player-rank__pts">{(myRank?.points ?? playerRow!.points).toLocaleString()} pts</span>
          </div>
        )}

        {/* Entries */}
        <div className="leaderboard-list" role="list">
          {loading && entries.length === 0 && (
            <div className="leaderboard-notice">Loading rankings…</div>
          )}
          {entries.slice(0, 15).map((entry) => (
            <div
              key={`${entry.username}-${entry.rank}`}
              role="listitem"
              className={[
                'leaderboard-row',
                entry.isPlayer ? 'leaderboard-row--player' : '',
                entry.rank <= 3  ? 'leaderboard-row--podium' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="leaderboard-row__rank">{rankMedal(entry.rank)}</span>
              <span className="leaderboard-row__name">
                {entry.username}
                {entry.isPlayer && <span className="leaderboard-row__you"> (you)</span>}
              </span>
              {entry.level !== undefined && (
                <span className="leaderboard-row__level">Lv {entry.level}</span>
              )}
              <span className="leaderboard-row__points">
                {entry.points.toLocaleString()}{' '}
                <span className="leaderboard-row__unit">pts</span>
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="leaderboard-footer">
          Daily resets 00:00 UTC · Weekly resets Monday · All-Time is permanent
        </div>
      </div>
    </div>
  );
}

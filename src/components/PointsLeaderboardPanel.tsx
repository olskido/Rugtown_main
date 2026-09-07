/**
 * PointsLeaderboardPanel.tsx — Daily / Weekly / All-Time Points Leaderboard.
 * Phase 17: Daily is now the primary tab (shown first, selected by default).
 *           Each row shows the player's shortened Robinhood Chain wallet address
 *           with a copy button that copies the full address.
 *
 * Data source: get_points_leaderboard + get_my_leaderboard_rank RPCs (Phase 2).
 * Fallback:    empty state for guests or when the server is unreachable.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { getPointsLeaderboard, getMyLeaderboardRank } from '../lib/leaderboard';
import { shortenAddress } from '../lib/wallet';

/* ─── Types ─────────────────────────────────────────────────────────────── */

export interface LeaderboardEntry {
  rank: number;
  username: string;
  points: number;
  level?: number;
  walletAddress?: string | null;
  walletChain?: string | null;
  isPlayer?: boolean;
}

type LeaderboardScope = 'daily' | 'weekly' | 'alltime';

const SCOPE_TO_PERIOD: Record<LeaderboardScope, 'daily' | 'weekly' | 'all_time'> = {
  daily:   'daily',
  weekly:  'weekly',
  alltime: 'all_time',
};

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

/** Display wallet: shortened if present, dash placeholder if absent. */
function walletDisplay(addr: string | null | undefined): string {
  if (!addr) return '—';
  return shortenAddress(addr, 6, 4);
}

/* ─── Wallet copy button component ──────────────────────────────────────── */

interface WalletCopyButtonProps {
  address: string | null | undefined;
}

function WalletCopyButton({ address }: WalletCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the shortened address is still readable.
    }
  }, [address]);

  if (!address) return null;

  return (
    <button
      type="button"
      className={`leaderboard-row__wallet-copy${copied ? ' leaderboard-row__wallet-copy--copied' : ''}`}
      onClick={(e) => void handleCopy(e)}
      aria-label={`Copy full wallet address ${address}`}
      title="Copy full wallet address"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/* ─── Props ─────────────────────────────────────────────────────────────── */

export interface PointsLeaderboardPanelProps {
  open: boolean;
  onClose: () => void;
  playerName: string;
  /** Authenticated player's linked wallet address (for "you" row highlight) */
  playerWalletAddress?: string | null;
  isGuest?: boolean;
}

/* ─── Component ─────────────────────────────────────────────────────────── */

export function PointsLeaderboardPanel({
  open,
  onClose,
  playerName,
  playerWalletAddress,
  isGuest = false,
}: PointsLeaderboardPanelProps) {
  // Daily is the primary / default scope (Phase 17 product requirement).
  const [scope, setScope]             = useState<LeaderboardScope>('daily');
  const [entries, setEntries]         = useState<LeaderboardEntry[]>([]);
  const [myRank, setMyRank]           = useState<{ rank: number; points: number } | null>(null);
  const [loading, setLoading]         = useState(false);
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
            rank:          r.rank,
            username:      r.username,
            points:        r.points,
            level:         r.level,
            walletAddress: r.walletAddress,
            walletChain:   r.walletChain,
            isPlayer:      r.playerId === rank?.playerId,
          })),
        );
        setUsedFallback(false);
      } else {
        throw new Error('leaderboard RPC unavailable');
      }
      if (rank) setMyRank({ rank: rank.rank, points: rank.points });
    } catch {
      // Do not present fabricated rows as a live leaderboard.
      setEntries([]);
      setMyRank(null);
      setUsedFallback(true);
    } finally {
      setLoading(false);
    }
  }, [playerName]);

  useEffect(() => {
    if (!open) return;
    if (isGuest) {
      setEntries([]);
      setMyRank(null);
      setUsedFallback(true);
      return;
    }
    void loadServerLeaderboard(scope);
  }, [open, scope, isGuest, playerName, loadServerLeaderboard]);

  if (!open) return null;

  const TABS: { key: LeaderboardScope; label: string }[] = [
    { key: 'daily',   label: '⚡ Daily'   },
    { key: 'weekly',  label: 'Weekly'     },
    { key: 'alltime', label: 'All Time'   },
  ];

  const playerRow = entries.find((e) => e.isPlayer);
  const showRank  = myRank ?? (playerRow ? { rank: playerRow.rank, points: playerRow.points } : null);

  return (
    <div
      className="panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Daily Leaderboard"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel panel--leaderboard">

        {/* Header — always reads "Daily Leaderboard" for the primary scope */}
        <div className="panel__header">
          <span className="panel__header-icon">🏆</span>
          <h2 className="panel__title">
            {scope === 'daily' ? 'Daily Leaderboard' :
             scope === 'weekly' ? 'Weekly Leaderboard' : 'All-Time Leaderboard'}
          </h2>
          <button
            className="panel__close"
            onClick={onClose}
            aria-label="Close leaderboard"
            type="button"
          >
            ✕
          </button>
        </div>

        {/* Period description */}
        <p className="leaderboard-period-desc">
          {scope === 'daily'
            ? 'Today\'s rankings · resets 00:00 UTC'
            : scope === 'weekly'
              ? 'This week\'s rankings · resets Monday 00:00 UTC'
              : 'Permanent all-time rankings'}
        </p>

        {/* Tabs — Daily first */}
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
              ? 'Sign in to appear on the live leaderboard.'
              : 'Showing preview data — live leaderboard could not be reached.'}
          </div>
        )}

        {/* Your Rank callout */}
        {showRank && (
          <div className="leaderboard-player-rank">
            <span className="leaderboard-player-rank__label">Your Rank</span>
            <span className="leaderboard-player-rank__badge">{rankMedal(showRank.rank)}</span>
            <span className="leaderboard-player-rank__pts">
              {showRank.points.toLocaleString()} pts
            </span>
            {playerWalletAddress && (
              <span className="leaderboard-row__wallet" style={{ marginLeft: 8 }}>
                {walletDisplay(playerWalletAddress)}
              </span>
            )}
          </div>
        )}

        {/* Column headers */}
        <div className="leaderboard-header-row" aria-hidden>
          <span className="leaderboard-header-row__rank">Rank</span>
          <span className="leaderboard-header-row__player">Player</span>
          <span className="leaderboard-header-row__wallet">Wallet</span>
          <span className="leaderboard-header-row__score">Score</span>
        </div>

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
                entry.isPlayer      ? 'leaderboard-row--player' : '',
                entry.rank <= 3     ? 'leaderboard-row--podium' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="leaderboard-row__rank">{rankMedal(entry.rank)}</span>
              <span className="leaderboard-row__name">
                {entry.username}
                {entry.isPlayer && <span className="leaderboard-row__you"> (you)</span>}
                {entry.level !== undefined && (
                  <span className="leaderboard-row__level"> Lv {entry.level}</span>
                )}
                <span className="leaderboard-row__wallet-mobile">
                  {walletDisplay(entry.walletAddress)}
                  <WalletCopyButton address={entry.walletAddress} />
                </span>
              </span>
              <span
                className="leaderboard-row__wallet"
                title={entry.walletAddress ?? undefined}
                aria-label={entry.walletAddress ? `Wallet: ${entry.walletAddress}` : 'No wallet linked'}
              >
                {walletDisplay(entry.walletAddress)}
                <WalletCopyButton address={entry.walletAddress} />
              </span>
              <span className="leaderboard-row__points">
                {entry.points.toLocaleString()}{' '}
                <span className="leaderboard-row__unit">pts</span>
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="leaderboard-footer">
          Daily · Weekly · All-Time &nbsp;|&nbsp; Points ranked server-side
        </div>
      </div>
    </div>
  );
}
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchTrendingSolanaTokens, type MarketToken } from '../services/dexscreener';

/*
  NoticeBoardPanel.tsx
  ─────────────────────
  Notice Board's interior — a live market bulletin pinned from the same
  DexScreener trending data the Meme Market terminal uses (same service,
  same cache; this file is fully self-contained and doesn't import
  anything from MarketPanel.tsx, so the two stay independent). Read-only:
  no wallet, no trading, no swaps — clicking a notice just opens its
  DexScreener page in a new tab.

  Unlike the Market panel (auto-refreshing terminal), this is a fetch-
  once-then-manually-refresh bulletin board — fits the "notices get
  pinned, not live-ticking" framing and keeps requests light.
*/

const THIN_LIQUIDITY_USD = 20_000;
const SECTION_LIMIT = 5;

function formatCompactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return '—';
  if (price === 0) return '$0';
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatPercent(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function pctClass(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct) || pct === 0) return '';
  return pct > 0 ? 'notice-positive' : 'notice-negative';
}

interface NoticeRowProps {
  token: MarketToken;
  metric: string;
  metricClass?: string;
}

function NoticeRow({ token, metric, metricClass }: NoticeRowProps) {
  return (
    <a
      className="notice-row"
      href={token.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${token.symbol} on DexScreener`}
    >
      <span className="notice-row__symbol">${token.symbol}</span>
      <span className="notice-row__name">{token.name}</span>
      <span className="notice-row__price">{formatPrice(token.priceUsd)}</span>
      <span className={`notice-row__metric ${metricClass ?? ''}`}>{metric}</span>
    </a>
  );
}

function NoticeSection({
  icon, title, tokens, emptyText, metricFor, metricClassFor,
}: {
  icon: string;
  title: string;
  tokens: MarketToken[];
  emptyText: string;
  metricFor: (t: MarketToken) => string;
  metricClassFor?: (t: MarketToken) => string | undefined;
}) {
  return (
    <section className="notice-section">
      <div className="notice-section__header">
        <span aria-hidden>{icon}</span>
        <span>{title}</span>
      </div>
      {tokens.length === 0 ? (
        <p className="notice-section__empty">{emptyText}</p>
      ) : (
        <div className="notice-section__rows">
          {tokens.map(t => (
            <NoticeRow key={t.tokenAddress} token={t} metric={metricFor(t)} metricClass={metricClassFor?.(t)} />
          ))}
        </div>
      )}
    </section>
  );
}

export function NoticeBoardPanel({
  onAcceptMissionLead,
  onOpenMissions,
}: {
  onAcceptMissionLead?: () => void;
  onOpenMissions?: () => void;
} = {}) {
  const [tokens, setTokens] = useState<MarketToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [leadPinned, setLeadPinned] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async (force: boolean) => {
      if (cancelled) return;
      if (force) setRefreshing(tokens.length > 0);
      if (tokens.length === 0) setLoading(true);
      setError(null);
      try {
        const data = await fetchTrendingSolanaTokens({ force });
        if (cancelled) return;
        setTokens(data);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load live market notices.');
      } finally {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      }
    };
    run(retryTick > 0);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick]);

  const handleRefresh = useCallback(() => setRetryTick(t => t + 1), []);

  const top5By5m = useMemo(
    () => [...tokens].sort((a, b) => (b.priceChange.m5 ?? -Infinity) - (a.priceChange.m5 ?? -Infinity)).slice(0, SECTION_LIMIT),
    [tokens]
  );
  const top5By24h = useMemo(
    () => [...tokens].sort((a, b) => (b.priceChange.h24 ?? -Infinity) - (a.priceChange.h24 ?? -Infinity)).slice(0, SECTION_LIMIT),
    [tokens]
  );
  const top5ByVolume = useMemo(
    () => [...tokens].sort((a, b) => (b.volume24h ?? -Infinity) - (a.volume24h ?? -Infinity)).slice(0, SECTION_LIMIT),
    [tokens]
  );
  const thinLiquidity = useMemo(
    () => tokens
      .filter(t => t.liquidityUsd !== null && t.liquidityUsd < THIN_LIQUIDITY_USD)
      .sort((a, b) => (a.liquidityUsd ?? 0) - (b.liquidityUsd ?? 0))
      .slice(0, SECTION_LIMIT),
    [tokens]
  );

  const showFullError = error && tokens.length === 0 && !loading;
  const showInitialLoading = loading && tokens.length === 0;

  return (
    <div className="notice-board">
      <div className="notice-mission-hub">
        <p className="notice-mission-hub__title">Mission Desk</p>
        <p className="notice-mission-hub__text">
          Pin a city lead, then track starter, daily, weekly, and story missions from your HUD.
        </p>
        <div className="notice-mission-hub__actions">
          <button
            type="button"
            className="notice-refresh-btn"
            onClick={() => {
              setLeadPinned(true);
              onAcceptMissionLead?.();
            }}
          >
            {leadPinned ? '✓ Lead pinned' : 'Accept mission lead'}
          </button>
          <button type="button" className="notice-refresh-btn" onClick={() => onOpenMissions?.()}>
            Open mission list
          </button>
        </div>
      </div>

      <div className="notice-toolbar">
        <span className="notice-toolbar__tag">DATA: DEXSCREENER · SOLANA · READ-ONLY</span>
        <button className="notice-refresh-btn" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? '⏳ Refreshing…' : '🔄 Refresh'}
        </button>
      </div>

      {showInitialLoading && (
        <div className="notice-state notice-state--loading">
          <span className="notice-spinner" aria-hidden />
          <p>Pinning live notices from DexScreener…</p>
        </div>
      )}

      {showFullError && (
        <div className="notice-state notice-state--error">
          <p>⚠️ {error}</p>
          <button className="notice-refresh-btn" onClick={handleRefresh}>Retry</button>
        </div>
      )}

      {!showInitialLoading && !showFullError && (
        <div className="notice-sections">
          {error && tokens.length > 0 && (
            <div className="notice-stale-banner">⚠️ Couldn't refresh — showing last known notices.</div>
          )}

          <NoticeSection
            icon="🚀"
            title="Top 5 · 5m Gainers"
            tokens={top5By5m}
            emptyText="No 5m movers right now."
            metricFor={t => formatPercent(t.priceChange.m5)}
            metricClassFor={t => pctClass(t.priceChange.m5)}
          />
          <NoticeSection
            icon="📈"
            title="Top 5 · 24h Gainers"
            tokens={top5By24h}
            emptyText="No 24h movers right now."
            metricFor={t => formatPercent(t.priceChange.h24)}
            metricClassFor={t => pctClass(t.priceChange.h24)}
          />
          <NoticeSection
            icon="💰"
            title="Top 5 · Volume"
            tokens={top5ByVolume}
            emptyText="No volume data right now."
            metricFor={t => formatCompactUsd(t.volume24h)}
          />
          <NoticeSection
            icon="⚠️"
            title="Thin Liquidity Warnings"
            tokens={thinLiquidity}
            emptyText="Liquidity looks healthy across the board right now."
            metricFor={t => formatCompactUsd(t.liquidityUsd)}
            metricClassFor={() => 'notice-negative'}
          />
        </div>
      )}

      <p className="notice-disclaimer">
        Live market data via DexScreener · Read-only — no wallet, no trading, no swaps.
      </p>
    </div>
  );
}

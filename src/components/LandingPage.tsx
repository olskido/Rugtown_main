import React, { useEffect, useState } from 'react';
import { FeatureCard } from './FeatureCard';
import { subscribeCityPresenceCount, type PresenceCountState } from '../lib/presence';
import { isSupabaseConfigured } from '../lib/supabase';
import { HOMEPAGE_VISUAL } from '../config/homepageVisual';

/*
  LandingPage — matches Image 2 (05-homepage.png) as source of truth

  Layout breakdown from Image 2:
  ┌─────────────────────────────────────────────────────────────┐
  │  BACKGROUND: Full-screen isometric city illustration        │
  │  (dark teal-green with warm amber lantern lights)           │
  │                                                             │
  │              ┌─────────────────────┐                        │
  │              │ [ornate arch icon]  │                        │
  │              │    R U G T O W N   │ ← double gold border   │
  │              │ Survive or Get      │   ornate corners       │
  │              │ Rugged.             │                        │
  │              │ ─────────────────── │                        │
  │              │ [▶ ENTER THE CITY ] │ ← gold filled button  │
  │              │ [Live Players][Wallet] ← ghost buttons      │
  │              │ [Alpha Calls][Activity]                      │
  │              └─────────────────────┘                        │
  │                                                             │
  │ [Explore][Trade][Compete][Earn Rep][Badges][Holder Perks]  │
  └─────────────────────────────────────────────────────────────┘
*/

// Live stats — NPC count is session-local; real player count comes from
// Supabase presence when configured (never faked).
const MOCK_STATS = {
  npcCitizens: 10,
  alphaCalls: 38,
};

// Feature cards matching RugTown's social progression pillars
const FEATURES = [
  { icon: 'Explore',           label: 'Explore City' },
  { icon: 'Missions',          label: 'Mission HQ' },
  { icon: 'Compete',           label: 'Leaderboard' },
  { icon: 'Earn Reputation',   label: 'Earn REP & XP' },
  { icon: 'Collect Badges',    label: '100 Levels' },
  { icon: 'Hidden Secrets',    label: 'Hidden Quests' },
];

// ──────────────────────────────────────────────────────────────
// Particle system — ambient floating embers/fireflies
// Matches the warm particle atmosphere visible in Images 3/4
// ──────────────────────────────────────────────────────────────
interface Particle {
  id: number;
  x: number;        // % from left
  delay: number;    // animation-delay in seconds
  duration: number; // animation-duration in seconds
  size: number;     // px
  drift: number;    // horizontal drift px
  color: string;
}

function generateParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    delay: Math.random() * 12,
    duration: 8 + Math.random() * 8,
    size: Math.random() > 0.7 ? 3 : Math.random() > 0.5 ? 2 : 1.5,
    drift: (Math.random() - 0.5) * 60,
    // Warm amber or soft gold — matching lantern glow in Image 3
    color: Math.random() > 0.4
      ? `rgba(232,${144 + Math.floor(Math.random() * 60)},42,${0.4 + Math.random() * 0.5})`
      : `rgba(${200 + Math.floor(Math.random() * 40)},${160 + Math.floor(Math.random() * 40)},60,${0.3 + Math.random() * 0.4})`,
  }));
}

// ──────────────────────────────────────────────────────────────
// Animated stat counter
// ──────────────────────────────────────────────────────────────
function useCountUp(target: number, duration: number = 1200, delay: number = 0): number {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const timeout = setTimeout(() => {
      const start = performance.now();
      const step = (now: number) => {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        setCurrent(Math.round(eased * target));
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, delay);
    return () => clearTimeout(timeout);
  }, [target, duration, delay]);
  return current;
}

// ──────────────────────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────────────────────
interface LandingPageProps {
  /** Called when the player taps Enter RugTown on the home card. */
  onEnterRugtown: () => void;
}

export function LandingPage({ onEnterRugtown }: LandingPageProps) {
  const [particles] = useState(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return generateParticles(reduced ? 0 : 28);
  });
  const [mounted, setMounted] = useState(false);

  // Focus input when switching to guest mode
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(t);
  }, []);

  // Animated stat counters — stagger each one (NPC / alpha only)
  const npcCount      = useCountUp(MOCK_STATS.npcCitizens, 800, 1000);
  const alphaCount    = useCountUp(MOCK_STATS.alphaCalls, 1000, 1100);

  /* ── Real player count from Supabase presence (never faked) ── */
  const [presenceState, setPresenceState] = useState<PresenceCountState>(() =>
    isSupabaseConfigured ? { status: 'connecting' } : { status: 'unavailable' },
  );
  useEffect(() => subscribeCityPresenceCount(setPresenceState), []);

  const realPlayersLabel = (() => {
    if (presenceState.status === 'connected') return presenceState.count.toLocaleString();
    if (presenceState.status === 'connecting') return 'Connecting…';
    return '—';
  })();

  return (
    <div className={`landing screen-enter ${mounted ? 'landing--mounted' : ''}`}>

      {/* ────────────────────────────────────────────────────────
          BACKGROUND LAYER
          Source: Image 2 shows the isometric city as full background
          We recreate with a rich CSS gradient that evokes the warm
          teal-dark atmosphere of Images 3/4, plus animated overlays
          ──────────────────────────────────────────────────────── */}
      <div
        className="landing__bg"
        aria-hidden
        style={{
          ['--homepage-bg-image' as string]: `url('${HOMEPAGE_VISUAL.backgroundUrl}')`,
        } as React.CSSProperties}
      >

        {/* Animated background — CSS gradient city atmosphere */}
        {/* Multi-layer to create depth: sky, mid city, foreground */}
        <div className="landing__bg-city" />

        {/* Fog layers — 3 independent animations for organic movement */}
        <div className="landing__fog landing__fog--1" />
        <div className="landing__fog landing__fog--2" />
        <div className="landing__fog landing__fog--3" />

        {/* Warm amber vignette — the city fire/lantern warmth from Image 3 */}
        <div className="landing__vignette-warm" />

        {/* Dark overlay for card readability */}
        <div className="landing__overlay" />

      </div>

      {/* ────────────────────────────────────────────────────────
          PARTICLE SYSTEM
          Ambient embers matching the warm particle atmosphere
          visible throughout Images 3/4 city scenes
          ──────────────────────────────────────────────────────── */}
      <div className="landing__particles" aria-hidden>
        {particles.map((p) => (
          <span
            key={p.id}
            className="landing__particle"
            style={{
              left: `${p.x}%`,
              bottom: `-${p.size}px`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              background: p.color,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              '--drift': `${p.drift}px`,
              boxShadow: `0 0 ${p.size * 2}px ${p.color}`,
            } as React.CSSProperties}
          />
        ))}
      </div>

      {/* ────────────────────────────────────────────────────────
          MAIN CONTENT
          ──────────────────────────────────────────────────────── */}
      <main className="landing__content">

        {/* ──────────────────────────────────────────────────────
            CENTER CARD
            From Image 2: ornate double-border panel, centered,
            contains logo + subtitle + buttons + stats
            ────────────────────────────────────────────────────── */}
        <div className="landing__card" role="main">

          {/* Ornate top edge — gold bar from Image 2 card top */}
          <div className="card__top-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>

          {/* Corner ornaments — 4 corners, matching Image 1's panel corners */}
          <span className="card__corner card__corner--tl" aria-hidden>◆</span>
          <span className="card__corner card__corner--tr" aria-hidden>◆</span>
          <span className="card__corner card__corner--bl" aria-hidden>◆</span>
          <span className="card__corner card__corner--br" aria-hidden>◆</span>

          <div className="card__inner">

            {/* ── LOGO SECTION ── */}
            <div className="card__logo-section">

              {/* Decorative arch icon above logo — visible in Image 2 */}
              <div className="card__arch-icon" aria-hidden>
                <svg viewBox="0 0 80 48" fill="none">
                  {/* Classical arch shape matching the Image 2 icon */}
                  <path
                    d="M8 48 V28 Q8 8 40 8 Q72 8 72 28 V48"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="rgba(200,144,42,0.08)"
                  />
                  {/* Inner arch */}
                  <path
                    d="M16 48 V30 Q16 16 40 16 Q64 16 64 30 V48"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeOpacity="0.6"
                    fill="none"
                  />
                  {/* Column lines */}
                  <line x1="8" y1="28" x2="8" y2="48" stroke="currentColor" strokeWidth="2"/>
                  <line x1="72" y1="28" x2="72" y2="48" stroke="currentColor" strokeWidth="2"/>
                  {/* Crown detail */}
                  <circle cx="40" cy="7" r="3" fill="currentColor" opacity="0.8"/>
                  <path d="M34 7 L40 2 L46 7" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                </svg>
              </div>

              {/* Wordmark — Cinzel Decorative, matches reference */}
              <h1 className="card__logo">
                <span className="card__logo-text">RUGTOWN</span>
                {/* Decorative side lines flanking the wordmark */}
                <span className="card__logo-line card__logo-line--left" aria-hidden />
                <span className="card__logo-line card__logo-line--right" aria-hidden />
              </h1>

              {/* Subtitle — "The Degen City" */}
              <p className="card__subtitle">The Degen City</p>

              {/* Gold divider */}
              <div className="card__divider" aria-hidden>
                <span className="card__divider-line" />
                <span className="card__divider-gem" aria-hidden>◆</span>
                <span className="card__divider-line" />
              </div>

              {/* Tagline — "Survive or Get Rugged." */}
              <p className="card__tagline">
                <em>Survive or Get Rugged.</em>
              </p>

            </div>

            {/* ── BUTTON SECTION ── */}
            <div className="card__actions">

              <button
                className="btn btn--primary"
                onClick={onEnterRugtown}
                aria-label="Enter RugTown"
              >
                <span className="btn__shimmer" aria-hidden />
                <span className="btn__arrow" aria-hidden>▶</span>
                <span className="btn__label">ENTER RUGTOWN</span>
              </button>

                {/* Secondary row — "Live Players" + "Missions & Quests" */}
                <div className="card__btn-row">
                  <button
                    className="btn btn--secondary"
                    aria-label="Real players currently online"
                  >
                    <span className="btn__dot btn__dot--live" aria-hidden />
                    <span>Live Players</span>
                  </button>

                  <button
                    className="btn btn--secondary"
                    onClick={onEnterRugtown}
                    aria-label="Daily & Weekly Missions"
                  >
                    <span className="btn__icon" aria-hidden>📜</span>
                    <span>100 Levels & Quests</span>
                  </button>
                </div>

                {/* Tertiary row — "Hall of Fame" + "Leaderboards" */}
                <div className="card__btn-row">
                  <button className="btn btn--ghost" onClick={onEnterRugtown}>
                    <span className="btn__icon" aria-hidden>🏆</span>
                    <span>Points Leaderboard</span>
                  </button>

                  <button className="btn btn--ghost" onClick={onEnterRugtown}>
                    <span className="btn__icon" aria-hidden>🔍</span>
                    <span>Hidden Quests</span>
                  </button>
                </div>

                {/* ── LIVE STATS ── */}
                {/* Small stat pills below buttons */}
                <div className="card__stats" role="status" aria-live="polite" aria-label="Live city stats">
                  <div className="stat">
                    <span className="stat__dot stat__dot--live" aria-hidden />
                    <span className="stat__value">{realPlayersLabel}</span>
                    <span className="stat__label">Real Players</span>
                  </div>
                  <div className="stat__divider" aria-hidden>·</div>
                  <div className="stat">
                    <span className="stat__dot" aria-hidden />
                    <span className="stat__value">{npcCount}</span>
                    <span className="stat__label">NPC Citizens</span>
                  </div>
                  <div className="stat__divider" aria-hidden>·</div>
                  <div className="stat">
                    <span className="stat__dot stat__dot--amber" aria-hidden />
                    <span className="stat__value">{alphaCount}</span>
                    <span className="stat__label">Alpha Calls Today</span>
                  </div>
                </div>

                {/* Network badge */}
                <div className="card__network-badge" aria-label="Running on Solana devnet">
                  <span className="badge__dot" aria-hidden />
                  <span>DEVNET · MOCK MODE · $RUGTOWN SOON</span>
                </div>

              </div>

          </div>

          {/* Bottom ornament */}
          <div className="card__bottom-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>

        </div>

      </main>

      {/* ────────────────────────────────────────────────────────
          BOTTOM FEATURE BAR
          From Image 2: 6 equal cards at very bottom of screen
          Dark semi-transparent, gold borders, icon + label each
          ──────────────────────────────────────────────────────── */}
      <footer className="landing__features" role="contentinfo" aria-label="Game features">
        <div className="features__bar">
          {FEATURES.map((f, i) => (
            <FeatureCard
              key={f.label}
              icon={f.icon}
              label={f.label}
              index={i}
            />
          ))}
        </div>
      </footer>

    </div>
  );
}

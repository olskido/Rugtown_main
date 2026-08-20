import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import './styles/global.css';
import './styles/landing.css';
import './styles/game.css';
import './styles/auth.css';
import { LandingPage } from './components/LandingPage';
import { UsernameOnboardingPage } from './components/UsernameOnboardingPage';
import { AuthPage } from './components/AuthPage';
import { AuthCallbackPage } from './components/AuthCallbackPage';
import { OutfitSelectPage } from './components/OutfitSelectPage';
import { GamePage } from './components/GamePage';
import { getCanonicalPlayerAppearance } from './game/characters/appearance/CanonicalPlayerAppearance';
import { soundManager } from './audio/SoundManager';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import {
  fetchOrCreateProfile,
  fetchUserBadgeIds,
  fetchInventoryItemIds,
  fetchDistrictUnlockIds,
  saveUsername,
  getRugtownProfileState,
  type AuthUserLike,
} from './lib/profile';
import {
  clampWorldPosition,
  isSessionFresh,
  loadRugTownSession,
  saveRugTownSession,
  type RugTownRoute,
} from './game/persistence/RugTownSessionStore';
import { WORLD_H as WORLD_HEIGHT, WORLD_W as WORLD_WIDTH } from './game/world/NewCanonicalWorld';

/*
  App.tsx — routed screens + auth hydration + session restore on refresh.

  /                     Landing
  /auth                 Sign in with Google / Email
  /auth/callback        OAuth / Email confirmation callback
  /onboarding/username  Username selection for new Google/Email players
  /character            Nickname / outfit gate
  /play                 Game (restores last safe position from local session)
*/

type AuthHydration = 'loading' | 'authenticated' | 'guest' | 'error';

interface AuthUser {
  id: string;
  email: string | null;
}

function pathToRoute(pathname: string): RugTownRoute {
  if (pathname.startsWith('/auth/callback')) return '/auth/callback';
  if (pathname.startsWith('/onboarding/username')) return '/onboarding/username';
  if (pathname.startsWith('/auth')) return '/auth';
  if (pathname.startsWith('/character')) return '/character';
  if (pathname.startsWith('/play')) return '/play';
  return '/';
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [authHydration, setAuthHydration] = useState<AuthHydration>('loading');
  const [playerName, setPlayerName] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initialRep, setInitialRep] = useState(0);
  const [initialBadgeIds, setInitialBadgeIds] = useState<string[]>([]);
  const [initialOwnedItemIds, setInitialOwnedItemIds] = useState<string[]>([]);
  const [initialDistrictIds, setInitialDistrictIds] = useState<string[]>([]);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);
  const [authCallbackError, setAuthCallbackError] = useState<string | null>(null);
  const [restorePosition, setRestorePosition] = useState<{ x: number; y: number } | null>(null);
  const [routeReady, setRouteReady] = useState(false);

  const authActionPendingRef = useRef(false);
  const pendingUsernameRef = useRef<string | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);
  const didRestoreRouteRef = useRef(false);

  const resetGuestProgress = useCallback(() => {
    setPlayerName('');
    setInitialRep(0);
    setInitialBadgeIds([]);
    setInitialOwnedItemIds([]);
    setInitialDistrictIds([]);
    setRestorePosition(null);
  }, []);

  useEffect(() => {
    soundManager.preload();
    if (soundManager.isUnlocked()) return;
    const unlock = () => {
      soundManager.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);

  useEffect(() => {
    const route = pathToRoute(location.pathname);
    if (route === '/auth' || route === '/character' || route === '/play') {
      void import('./game/RugTownGame');
    }
  }, [location.pathname]);

  /* Persist lightweight route hint whenever the URL changes after hydration. */
  useEffect(() => {
    if (!routeReady) return;
    const route = pathToRoute(location.pathname);
    saveRugTownSession({ route }, user?.id ?? null);
  }, [location.pathname, routeReady, user?.id]);

  /* ── Auth hydration (block game until complete) ── */
  useEffect(() => {
    let cancelled = false;

    const loadUserData = async (sUser: AuthUserLike): Promise<{ onboardingCompleted: boolean }> => {
      if (loadedUserIdRef.current === sUser.id) {
        return { onboardingCompleted };
      }
      loadedUserIdRef.current = sUser.id;

      const emailFallback = sUser.email?.split('@')[0] ?? 'Degen';
      try {
        const [profile, badgeIds, itemIds, districtIds] = await Promise.all([
          getRugtownProfileState().then(async (state) => {
            if (state) return state;
            const legacy = await fetchOrCreateProfile(sUser);
            if (!legacy) return null;
            return {
              id: legacy.id,
              username: legacy.username,
              displayName: legacy.display_name,
              onboardingCompleted: legacy.onboarding_completed ?? true,
              walletAddress: legacy.wallet_address ?? null,
              rep: legacy.rep,
            };
          }),
          fetchUserBadgeIds(sUser.id),
          fetchInventoryItemIds(sUser.id),
          fetchDistrictUnlockIds(sUser.id),
        ]);
        if (cancelled) return { onboardingCompleted: true };

        if (profile?.username) setPlayerName(profile.username);
        else setPlayerName(prev => prev || emailFallback);

        const completed = profile?.onboardingCompleted !== false;
        if (profile) {
          setInitialRep(profile.rep);
          setWalletAddress(profile.walletAddress ?? null);
          setOnboardingCompleted(completed);
        }
        // Phase 16: if the server returned full progression, seed ProgressionService
        // immediately so the HUD shows accurate level/XP/points from first render
        // rather than waiting for the game to boot and call get_my_progression.
        if (
          profile &&
          (profile.lifetimeXp != null || profile.level != null || profile.rugPoints != null)
        ) {
          const { progressionService } = await import('./game/progression/ProgressionService');
          progressionService.syncFromServerSnapshot({
            lifetime_xp:         profile.lifetimeXp,
            level:               profile.level,
            rep:                 profile.rep,
            // Map Phase 16 points fields to the shape syncFromServerSnapshot expects
            rug_points:          profile.rugPoints,
            daily_points:        profile.dailyPoints,
            weekly_points:       profile.weeklyPoints,
          });
        }
        if (badgeIds.length) setInitialBadgeIds(badgeIds);
        if (itemIds.length) setInitialOwnedItemIds(itemIds);
        if (districtIds.length) setInitialDistrictIds(districtIds);
        return { onboardingCompleted: completed };
      } catch {
        if (!cancelled) {
          loadedUserIdRef.current = null;
          setPlayerName(prev => prev || emailFallback);
        }
        return { onboardingCompleted: true };
      }
    };

    const applyLocalSession = (uid: string | null) => {
      const session = loadRugTownSession(uid);
      if (!session) return;
      if (session.playerName) setPlayerName(prev => prev || session.playerName);
      if (session.position && isSessionFresh(session)) {
        setRestorePosition(
          clampWorldPosition(session.position, WORLD_WIDTH, WORLD_HEIGHT),
        );
      }
    };

    const finishHydration = (
      next: AuthHydration,
      uid: string | null,
      profileOnboardingComplete = true,
    ) => {
      if (cancelled) return;
      applyLocalSession(uid);
      setAuthHydration(next);

      if (!didRestoreRouteRef.current) {
        didRestoreRouteRef.current = true;
        const session = loadRugTownSession(uid);
        const urlRoute = pathToRoute(location.pathname);

        if (
          next === 'authenticated'
          && !profileOnboardingComplete
          && urlRoute !== '/onboarding/username'
          && urlRoute !== '/wallet'
        ) {
          navigate('/onboarding/username', { replace: true });
        } else if (urlRoute === '/play' || (session?.enteredGame && session.route === '/play' && urlRoute === '/')) {
          navigate('/play', { replace: true });
        } else if (urlRoute === '/' && session?.route && session.route !== '/' && session.enteredGame) {
          navigate(session.route === '/character' ? '/character' : '/play', { replace: true });
        }
      }
      setRouteReady(true);
    };

    if (!supabase || !isSupabaseConfigured) {
      finishHydration('guest', null);
      return () => { cancelled = true; };
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email ?? null });
        void loadUserData(session.user).then(({ onboardingCompleted: completed }) => {
          finishHydration('authenticated', session.user.id, completed);
        });
      } else {
        finishHydration('guest', null);
      }
    }).catch(() => {
      finishHydration('error', null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (cancelled) return;

        if (event === 'SIGNED_IN' && session?.user) {
          const sUser = session.user;
          setUser({ id: sUser.id, email: sUser.email ?? null });
          setAuthHydration('authenticated');
          void loadUserData(sUser).then(async () => {
            if (cancelled) return;
            if (!authActionPendingRef.current) return;
            authActionPendingRef.current = false;

            const chosenUsername = pendingUsernameRef.current;
            pendingUsernameRef.current = null;
            if (chosenUsername) {
              await saveUsername(sUser.id, chosenUsername).catch(() => {});
              if (!cancelled) setPlayerName(chosenUsername);
            }

            if (!cancelled) {
              saveRugTownSession({ route: '/character' }, sUser.id);
              navigate('/character');
            }
          });
        }

        if (event === 'SIGNED_OUT') {
          loadedUserIdRef.current = null;
          pendingUsernameRef.current = null;
          setUser(null);
          resetGuestProgress();
          setAuthHydration('guest');
        }
      },
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetGuestProgress, navigate]);

  const handleEnterRugtown = useCallback(() => {
    if (user && playerName) {
      navigate('/play');
      return;
    }
    if (isSupabaseConfigured) {
      navigate('/auth');
      return;
    }
    navigate('/character');
  }, [navigate, user, playerName]);

  const handleUsernameComplete = useCallback(
    (username: string) => {
      setPlayerName(username);
      setOnboardingCompleted(true);
      saveRugTownSession({ route: '/character', playerName: username }, user?.id ?? null);
      navigate('/character');
    },
    [navigate, user?.id],
  );

  const handleAuthContinue = useCallback(() => {
    // Defense in depth: a signed-in user can reach /auth's "Continue" button
    // directly (browser back, bookmark) outside the OAuth-callback path
    // below. onboardingCompleted is authoritative server state by this point
    // (hydration has already completed, since this route only renders once
    // routeReady is true), so honour it here too -- never send an
    // incomplete profile to the game.
    const dest = onboardingCompleted ? '/character' : '/onboarding/username';
    if (dest === '/character') saveRugTownSession({ route: '/character' }, user?.id ?? null);
    navigate(dest);
  }, [navigate, user?.id, onboardingCompleted]);

  /**
   * OAuth (and email-confirmation-link) callback success. `needsOnboarding`
   * is computed by AuthCallbackPage from a fresh, direct
   * getRugtownProfileState() call made right after the session was
   * established -- NOT from this component's own hydration state, which
   * races the OAuth redirect: on first return from Google, the initial
   * getSession() resolves with no session (the PKCE code hasn't been
   * exchanged yet), so the one-shot post-hydration onboarding check fires
   * early as a 'guest' and is never re-armed once the real session lands via
   * SIGNED_IN. See the Phase 1 report for the full trace. Routing directly
   * from the callback's own fresh profile check sidesteps that race
   * entirely instead of trying to re-time the existing hydration guard.
   */
  const handleAuthCallbackSuccess = useCallback((opts: { needsOnboarding: boolean }) => {
    setAuthCallbackError(null);
    if (opts.needsOnboarding) {
      navigate('/onboarding/username', { replace: true });
    } else {
      saveRugTownSession({ route: '/character' }, user?.id ?? null);
      navigate('/character', { replace: true });
    }
  }, [navigate, user?.id]);

  const handleAuthCallbackFailure = useCallback((message: string) => {
    setAuthCallbackError(message);
    navigate('/auth', { replace: true });
  }, [navigate]);

  const handleAuthSignInAttempt = useCallback(() => {
    authActionPendingRef.current = true;
    pendingUsernameRef.current = null;
  }, []);

  const handleAuthSignUpAttempt = useCallback((username: string) => {
    authActionPendingRef.current = true;
    pendingUsernameRef.current = username.trim() || null;
  }, []);

  const handleGuestFromAuth = useCallback(async () => {
    authActionPendingRef.current = false;
    pendingUsernameRef.current = null;
    if (supabase) await supabase.auth.signOut();
    setUser(null);
    resetGuestProgress();
    setAuthHydration('guest');
    saveRugTownSession({ route: '/character', enteredGame: false }, null);
    navigate('/character');
  }, [navigate, resetGuestProgress]);

  const handleNameSelect = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      // Only attempt a server rename when the name actually changed from the
      // player's persisted username -- this field is pre-filled with it, and
      // most returning players click through unchanged. Re-submitting the
      // same value on every login used to fire a no-op update_player_username
      // call each time (see Phase 1 report: "Username persistence").
      const changed = user?.id && trimmed && trimmed !== playerName;

      setPlayerName(trimmed || playerName);
      saveRugTownSession({
        route: '/play',
        enteredGame: true,
        playerName: trimmed || playerName,
      }, user?.id ?? null);
      try {
        sessionStorage.setItem('rugtown:appearance-saved', '1');
        sessionStorage.setItem('rugtown:panel-character', '1');
      } catch { /* ignore */ }

      if (changed && user?.id) {
        void saveUsername(user.id, trimmed).then((result) => {
          if (!result.ok) {
            // Server rejected the rename (taken/cooldown/etc.) -- revert the
            // locally-displayed name to the last known-good server value
            // rather than showing a name that isn't actually persisted.
            console.warn('[username] rename rejected:', result.reason);
            setPlayerName(playerName);
          }
        });
      }

      navigate('/play');
    },
    [navigate, user, playerName],
  );

  const handleLogout = useCallback(async () => {
    // Flush any pending debounced server sync before signing out so progress
    // is not lost if the sync timer hasn't fired yet.
    const { progressionService } = await import('./game/progression/ProgressionService');
    progressionService.flushServerSync();
    await supabase?.auth.signOut();
    setUser(null);
    resetGuestProgress();
    setAuthHydration('guest');
    saveRugTownSession({ route: '/', enteredGame: false }, null);
    navigate('/');
  }, [navigate, resetGuestProgress]);

  if (authHydration === 'loading' || !routeReady) {
    return (
      <div className="landing landing--mounted screen-enter" role="status" aria-live="polite">
        <div className="landing__bg" aria-hidden>
          <div className="landing__bg-city" />
          <div className="landing__vignette-warm" />
          <div className="landing__overlay" />
        </div>
        <main className="landing__content">
          <div className="landing__card" style={{ maxWidth: 280, padding: 24, textAlign: 'center' }}>
            <div className="card__logo-text" style={{ fontSize: 22 }}>RUGTOWN</div>
            <p style={{ marginTop: 12, color: '#c8b89a', fontFamily: 'Cinzel, serif', fontSize: 12 }}>
              Restoring session…
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<LandingPage onEnterRugtown={handleEnterRugtown} />} />
      <Route path="/wallet" element={<Navigate to="/auth" replace />} />
      <Route
        path="/onboarding/username"
        element={(
          <UsernameOnboardingPage onComplete={handleUsernameComplete} />
        )}
      />
      <Route
        path="/auth"
        element={(
          <AuthPage
            loggedInEmail={user?.email ?? null}
            loggedInUsername={playerName || null}
            isLoggedIn={!!user}
            initialError={authCallbackError}
            onContinue={handleAuthContinue}
            onGuest={handleGuestFromAuth}
            onSignInAttempt={handleAuthSignInAttempt}
            onSignUpAttempt={handleAuthSignUpAttempt}
          />
        )}
      />
      <Route
        path="/auth/callback"
        element={(
          <AuthCallbackPage
            onSuccess={handleAuthCallbackSuccess}
            onFailure={handleAuthCallbackFailure}
          />
        )}
      />
      <Route
        path="/character"
        element={(
          <OutfitSelectPage
            playerName={playerName}
            onSelect={handleNameSelect}
          />
        )}
      />
      <Route
        path="/play"
        element={(
          <GamePage
            playerName={playerName}
            appearance={getCanonicalPlayerAppearance()}
            userEmail={user?.email ?? null}
            userId={user?.id ?? null}
            initialRep={user ? initialRep : undefined}
            initialBadgeIds={initialBadgeIds}
            initialOwnedItemIds={initialOwnedItemIds}
            initialDistrictIds={initialDistrictIds}
            initialPosition={restorePosition}
            walletAddress={walletAddress}
            onLogout={handleLogout}
          />
        )}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

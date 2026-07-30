import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import './styles/global.css';
import './styles/landing.css';
import './styles/game.css';
import './styles/auth.css';
import { LandingPage } from './components/LandingPage';
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

  /                 Landing
  /auth             Sign in / sign up
  /auth/callback    Email confirmation
  /character        Nickname / outfit gate
  /play             Game (restores last safe position from local session)
*/

type AuthHydration = 'loading' | 'authenticated' | 'guest' | 'error';

interface AuthUser {
  id: string;
  email: string | null;
}

function pathToRoute(pathname: string): RugTownRoute {
  if (pathname.startsWith('/auth/callback')) return '/auth/callback';
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

    const loadUserData = async (sUser: AuthUserLike): Promise<void> => {
      if (loadedUserIdRef.current === sUser.id) return;
      loadedUserIdRef.current = sUser.id;

      const emailFallback = sUser.email?.split('@')[0] ?? 'Degen';
      try {
        const [profile, badgeIds, itemIds, districtIds] = await Promise.all([
          fetchOrCreateProfile(sUser),
          fetchUserBadgeIds(sUser.id),
          fetchInventoryItemIds(sUser.id),
          fetchDistrictUnlockIds(sUser.id),
        ]);
        if (cancelled) return;

        if (profile?.username) setPlayerName(profile.username);
        else setPlayerName(prev => prev || emailFallback);

        if (profile) setInitialRep(profile.rep);
        if (badgeIds.length) setInitialBadgeIds(badgeIds);
        if (itemIds.length) setInitialOwnedItemIds(itemIds);
        if (districtIds.length) setInitialDistrictIds(districtIds);
      } catch {
        if (!cancelled) {
          loadedUserIdRef.current = null;
          setPlayerName(prev => prev || emailFallback);
        }
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

    const finishHydration = (next: AuthHydration, uid: string | null) => {
      if (cancelled) return;
      applyLocalSession(uid);
      setAuthHydration(next);

      if (!didRestoreRouteRef.current) {
        didRestoreRouteRef.current = true;
        const session = loadRugTownSession(uid);
        const urlRoute = pathToRoute(location.pathname);
        // Prefer explicit deep link; else restore last entered-game session.
        if (urlRoute === '/play' || (session?.enteredGame && session.route === '/play' && urlRoute === '/')) {
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
        void loadUserData(session.user).finally(() => {
          finishHydration('authenticated', session.user.id);
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
    navigate(isSupabaseConfigured ? '/auth' : '/character');
  }, [navigate]);

  const handleAuthContinue = useCallback(() => {
    saveRugTownSession({ route: '/character' }, user?.id ?? null);
    navigate('/character');
  }, [navigate, user?.id]);

  const handleAuthCallbackSuccess = useCallback(() => {
    setAuthCallbackError(null);
    navigate('/auth', { replace: true });
  }, [navigate]);

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
      setPlayerName(name);
      saveRugTownSession({
        route: '/play',
        enteredGame: true,
        playerName: name,
      }, user?.id ?? null);
      try {
        sessionStorage.setItem('rugtown:appearance-saved', '1');
        sessionStorage.setItem('rugtown:panel-character', '1');
      } catch { /* ignore */ }
      if (user?.id && name.trim()) {
        saveUsername(user.id, name.trim()).catch(() => {});
      }
      navigate('/play');
    },
    [navigate, user],
  );

  const handleLogout = useCallback(async () => {
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
            onLogout={handleLogout}
          />
        )}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import React, { useEffect, useState } from 'react';
import { handleAuthCallback } from '../lib/authRedirect';
import { getRugtownProfileState } from '../lib/profile';

/*
  AuthCallbackPage
  ─────────────────
  Landing target for Supabase Google OAuth returns AND email-confirmation
  links (both use the same PKCE-code/hash-token exchange). Path: /auth/callback

  Exchanges the returned code/tokens for a persisted session, then — Phase 1 —
  determines the destination itself via a fresh, direct getRugtownProfileState()
  call, rather than deferring to App.tsx's separate hydration pass.

  Why: on first return from Google, App.tsx's initial getSession() resolves
  with no session yet (the PKCE code hasn't been exchanged at that point),
  so its one-shot post-hydration onboarding check fires early as a 'guest'
  and never re-checks once the real session lands. Computing the destination
  right here, right after the session is actually established, avoids that
  race entirely instead of trying to re-time App.tsx's guard.
*/

interface AuthCallbackPageProps {
  /** Called after a successful session exchange, with whether the profile still needs username onboarding. */
  onSuccess: (opts: { needsOnboarding: boolean }) => void;
  /** Called when exchange fails, is cancelled, or errors — still open Auth so the user can sign in. No partial identity is ever created here: auth.users rows only exist after a successful exchange. */
  onFailure: (message: string) => void;
}

export function AuthCallbackPage({ onSuccess, onFailure }: AuthCallbackPageProps) {
  const [status, setStatus] = useState('Confirming your session…');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await handleAuthCallback();
      if (cancelled) return;

      if (!result.ok) {
        setStatus(result.error);
        onFailure(result.error);
        return;
      }

      setStatus('Signed in. Setting up your profile…');
      // Profile is guaranteed to exist by this point (the handle_new_user
      // trigger runs synchronously as part of the auth.users insert, which
      // already completed server-side before this session was returned) —
      // but treat a lookup failure as "needs onboarding" defensively rather
      // than risk skipping it.
      const profile = await getRugtownProfileState();
      if (cancelled) return;
      const needsOnboarding = !profile || profile.onboardingCompleted !== true;
      onSuccess({ needsOnboarding });
    })();

    return () => {
      cancelled = true;
    };
  }, [onSuccess, onFailure]);

  return (
    <div className="landing auth-page landing--mounted screen-enter">
      <div className="landing__bg" aria-hidden>
        <div className="landing__bg-city" />
        <div className="landing__vignette-warm" />
        <div className="landing__overlay" />
      </div>

      <main className="auth-page__content">
        <div className="landing__card auth-page__card" role="main">
          <div className="card__top-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>
          <span className="card__corner card__corner--tl" aria-hidden>◆</span>
          <span className="card__corner card__corner--tr" aria-hidden>◆</span>
          <span className="card__corner card__corner--bl" aria-hidden>◆</span>
          <span className="card__corner card__corner--br" aria-hidden>◆</span>

          <div className="card__inner auth-page__inner">
            <div className="auth-page__header">
              <div className="auth-page__logo">RUGTOWN</div>
              <p className="auth-page__subtitle" role="status">
                {status}
              </p>
            </div>
          </div>

          <div className="card__bottom-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>
        </div>
      </main>
    </div>
  );
}

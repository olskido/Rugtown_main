import React, { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { redeemRecoveryCode } from '../lib/recoveryCode';
import { isValidEmail, saveMyContactEmail } from '../lib/profile';

/*
  AuthPage.tsx
  ────────────
  Auth gate between LandingPage and OutfitSelectPage when Supabase is
  configured. Always shown after "Enter RugTown" — never auto-skipped.

  Phase 3 — lightweight account system. No Google, no email/password.
  Three options:
  • Sign in as Guest   — no Supabase session at all (unchanged; session-only,
                          resets on refresh).
  • New Sign Up        — email, then username. Uses Supabase's built-in
                          ANONYMOUS sign-in (a real, persistent auth.users
                          row and session — not the same thing as "Guest"
                          above) for the account itself; the email is NOT
                          used to sign in or verify anything — it's stored
                          separately (see src/lib/profile.ts's
                          saveMyContactEmail) purely so a future account-
                          recovery feature has an address to use. Username
                          is claimed via the existing update_player_username
                          RPC once the anonymous session exists.
  • Restore with Code  — resumes an EXISTING account on a new device using
                          the 10-character recovery code from that account's
                          Profile panel. See src/lib/recoveryCode.ts and
                          supabase/functions/redeem-recovery-code/.

  Sign-in / sign-up advance via onSignInAttempt / onSignUpAttempt + the
  onAuthStateChange('SIGNED_IN', ...) listener in App.tsx — unchanged from
  before, since anonymous sign-in and the recovery-code restore both end in
  a real Supabase session that fires the exact same event.
*/

type AuthMode = 'signup' | 'restore';
type SignupStep = 'email' | 'username';

interface AuthPageProps {
  isLoggedIn: boolean;
  loggedInEmail: string | null;
  loggedInUsername: string | null;
  /** Error from a failed `/auth/callback` exchange. Kept for prop-shape
   *  compatibility; nothing in this flow currently produces one. */
  initialError?: string | null;
  /** Logged-in user proceeds to wallet onboarding or the game. */
  onContinue: () => void;
  /** Guest path — clears account session and opens character creator. */
  onGuest: () => void;
  /** Called immediately before a restore-with-code attempt. */
  onSignInAttempt: () => void;
  /** Called immediately before a new-signup attempt, with the chosen
   *  username so App can persist it to the profile once the anonymous
   *  account exists. */
  onSignUpAttempt: (username: string) => void;
}

export function AuthPage({
  isLoggedIn,
  loggedInEmail,
  loggedInUsername,
  initialError = null,
  onContinue,
  onGuest,
  onSignInAttempt,
  onSignUpAttempt,
}: AuthPageProps) {
  const [mode, setMode]         = useState<AuthMode>('signup');
  const [signupStep, setSignupStep] = useState<SignupStep>('email');
  const [email, setEmail]       = useState('');
  const [username, setUsername] = useState('');
  const [code, setCode]         = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(initialError);
  const [sessionReady, setSessionReady] = useState(false);
  const [localLoggedIn, setLocalLoggedIn] = useState(isLoggedIn);

  const clear = () => setError(null);

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  // Sync session state on mount — show logged-in panel without auto-skipping.
  useEffect(() => {
    if (!supabase) {
      setSessionReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setLocalLoggedIn(!!session?.user);
      setSessionReady(true);
    });
  }, []);

  useEffect(() => {
    setLocalLoggedIn(isLoggedIn);
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isSupabaseConfigured) onGuest();
  }, [onGuest]);

  if (!isSupabaseConfigured) return null;

  const handleEmailContinue = () => {
    clear();
    if (!isValidEmail(email)) {
      setError('Enter a valid email address.');
      return;
    }
    setSignupStep('username');
  };

  const handleSignUp = async () => {
    if (!supabase) return;
    clear();
    const trimmed = username.trim();
    if (trimmed.length < 2) {
      setError('Pick a username with at least 2 characters.');
      return;
    }
    onSignUpAttempt(trimmed);
    setLoading(true);
    try {
      const { data, error: authErr } = await supabase.auth.signInAnonymously({
        options: { data: { username: trimmed, display_name: trimmed } },
      });
      if (authErr) throw authErr;
      if (data.user) {
        // Best-effort: the email is recovery metadata only, never the
        // account's actual sign-in credential — a failure here shouldn't
        // block sign-up from completing.
        await saveMyContactEmail(data.user.id, email).catch(() => {});
      }
      // onAuthStateChange('SIGNED_IN', ...) in App.tsx takes it from here:
      // loads/creates the profile, claims the username, navigates on.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-up failed. Please try again.');
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    clear();
    const trimmed = code.trim();
    if (trimmed.replace(/[^A-Za-z0-9]/g, '').length !== 10) {
      setError('Codes are 10 characters — check for typos.');
      return;
    }
    onSignInAttempt();
    setLoading(true);
    const result = await redeemRecoveryCode(trimmed);
    if (!result.ok) {
      setError(result.message);
      setLoading(false);
      return;
    }
    // onAuthStateChange('SIGNED_IN', ...) in App.tsx takes it from here.
  };

  const handleSignOutAndSwitch = async () => {
    if (!supabase) return;
    clear();
    setLoading(true);
    await supabase.auth.signOut();
    setLocalLoggedIn(false);
    setLoading(false);
  };

  const emailOk = isValidEmail(email);
  const usernameOk = username.trim().length >= 2;
  const codeOk = code.trim().replace(/[^A-Za-z0-9]/g, '').length === 10;

  const handleSubmit =
    mode === 'restore' ? handleRestore :
    signupStep === 'email' ? handleEmailContinue :
    handleSignUp;

  const canSubmit = !loading && (
    mode === 'restore' ? codeOk :
    signupStep === 'email' ? emailOk :
    usernameOk
  );

  const displayName = loggedInUsername || loggedInEmail?.split('@')[0] || 'Degen';

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
              <p className="auth-page__subtitle">
                Pick a username to save your progress, or continue as a guest.
              </p>
            </div>

            {!sessionReady ? (
              <p className="auth-feedback auth-feedback--notice" role="status">
                Checking session…
              </p>
            ) : localLoggedIn ? (
              <div className="auth-logged-in">
                <p className="auth-logged-in__welcome">
                  Signed in as <strong>{displayName}</strong>
                </p>
                <button
                  className="btn btn--primary auth-btn-submit"
                  onClick={onContinue}
                  disabled={loading}
                >
                  <span className="btn__shimmer" aria-hidden />
                  <span className="btn__label">Continue</span>
                </button>
                <button
                  className="btn btn--ghost auth-btn-switch"
                  onClick={handleSignOutAndSwitch}
                  disabled={loading}
                  type="button"
                >
                  Use a different account
                </button>
              </div>
            ) : (
              <>
                <div className="auth-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={mode === 'signup'}
                    className={`auth-tab ${mode === 'signup' ? 'auth-tab--active' : ''}`}
                    onClick={() => { setMode('signup'); setSignupStep('email'); clear(); }}
                  >
                    New Sign Up
                  </button>
                  <button
                    role="tab"
                    aria-selected={mode === 'restore'}
                    className={`auth-tab ${mode === 'restore' ? 'auth-tab--active' : ''}`}
                    onClick={() => { setMode('restore'); clear(); }}
                  >
                    Restore with Code
                  </button>
                </div>

                {error && <p className="auth-feedback auth-feedback--error" role="alert">{error}</p>}

                <div className="auth-form">
                  {mode === 'signup' ? (
                    signupStep === 'email' ? (
                      <>
                        <input
                          className="guest__input auth-input"
                          type="email"
                          placeholder="Email address"
                          value={email}
                          onChange={e => { setEmail(e.target.value); clear(); }}
                          onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                          autoComplete="email"
                          aria-label="Email address"
                          disabled={loading}
                          spellCheck={false}
                          maxLength={254}
                          autoFocus
                        />
                        <p className="auth-page__hint">
                          For account recovery only — never used to sign in or for marketing.
                        </p>
                      </>
                    ) : (
                      <>
                        <input
                          className="guest__input auth-input"
                          type="text"
                          placeholder="Choose a username"
                          value={username}
                          onChange={e => { setUsername(e.target.value); clear(); }}
                          onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                          autoComplete="username"
                          aria-label="Username"
                          disabled={loading}
                          spellCheck={false}
                          maxLength={24}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="auth-page__back"
                          onClick={() => { setSignupStep('email'); clear(); }}
                          disabled={loading}
                        >
                          ← Back to email
                        </button>
                      </>
                    )
                  ) : (
                    <>
                      <input
                        className="guest__input auth-input auth-input--code"
                        type="text"
                        placeholder="e.g. 7K4N-XQ2R8"
                        value={code}
                        onChange={e => { setCode(e.target.value); clear(); }}
                        onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                        autoComplete="off"
                        aria-label="Recovery code"
                        disabled={loading}
                        spellCheck={false}
                        maxLength={16}
                      />
                      <p className="auth-page__hint">
                        Find your code on this account's Profile panel, under Recovery Code.
                      </p>
                    </>
                  )}
                  <button
                    className="btn btn--primary auth-btn-submit"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    aria-busy={loading}
                  >
                    <span className="btn__shimmer" aria-hidden />
                    <span className="btn__label">
                      {mode === 'signup' && signupStep === 'email' ? 'Continue' :
                       loading && mode === 'signup'  ? 'Creating…' :
                       loading && mode === 'restore' ? 'Restoring…' :
                       mode === 'signup'              ? 'Create Account' :
                                                        'Restore Account'}
                    </span>
                  </button>
                </div>
              </>
            )}

            <div className="card__divider auth-divider">
              <span className="card__divider-line" />
              <span className="auth-divider-text">or skip for now</span>
              <span className="card__divider-line" />
            </div>

            <button
              className="btn btn--ghost auth-btn-guest"
              onClick={onGuest}
              disabled={loading}
              aria-label="Continue as guest without an account"
            >
              <span className="btn__icon" aria-hidden>⚡</span>
              Continue as Guest
            </button>

            <p className="auth-disclaimer">
              Guest progress is session-only and resets on refresh.
            </p>

          </div>

          <div className="card__bottom-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>
        </div>
      </main>
    </div>
  );
}

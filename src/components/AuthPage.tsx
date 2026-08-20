import React, { useEffect, useState } from 'react';
import { getAuthEmailRedirectTo } from '../lib/authRedirect';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

/*
  AuthPage.tsx
  ────────────
  Auth gate between LandingPage and OutfitSelectPage when Supabase is
  configured. Always shown after "Enter RugTown" — never auto-skipped.

  Account system is email/password only (Supabase Email Auth):
  • Sign Up  — username, email, password, confirm password.
  • Sign In  — email, password.
  • Logged-in users see a welcome panel + Continue.
  • Sign-in / sign-up advance via onSignInAttempt / onSignUpAttempt + App listener.
  • Continue as Guest signs out (if needed) and opens the character creator.
*/

type AuthMode = 'signin' | 'signup';

interface AuthPageProps {
  isLoggedIn: boolean;
  loggedInEmail: string | null;
  loggedInUsername: string | null;
  /** Error from a failed `/auth/callback` exchange (email confirm). */
  initialError?: string | null;
  /** Logged-in user proceeds to nickname / character creator. */
  onContinue: () => void;
  /** Guest path — clears account session and opens character creator. */
  onGuest: () => void;
  /** Called immediately before an email/password sign-in attempt. */
  onSignInAttempt: () => void;
  /** Called immediately before a sign-up attempt, with the chosen username so
   *  App can persist it to the profile once the account is created. */
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
  const [mode, setMode]         = useState<AuthMode>('signin');
  const [username, setUsername] = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(initialError);
  const [notice, setNotice]     = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [localLoggedIn, setLocalLoggedIn] = useState(isLoggedIn);

  const clear = () => { setError(null); setNotice(null); };

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

  const handleSignIn = async () => {
    if (!supabase) return;
    clear();
    onSignInAttempt();
    setLoading(true);
    try {
      const { data, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
      if (authErr) throw authErr;
      if (!data.user) setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    if (!supabase) return;
    clear();
    const trimmedUsername = username.trim();
    onSignUpAttempt(trimmedUsername);
    setLoading(true);
    try {
      const { data, error: authErr } = await supabase.auth.signUp({
        email,
        password,
        // Carry the chosen username into the auth user's metadata so the
        // profile can be created/updated with it after signup.
        // emailRedirectTo must match an allow-listed Redirect URL in the
        // Supabase dashboard; origin is always the current host (local or Vercel).
        options: {
          emailRedirectTo: getAuthEmailRedirectTo(),
          data: { username: trimmedUsername, display_name: trimmedUsername },
        },
      });
      if (authErr) throw authErr;

      if (data.session) {
        // onAuthStateChange handles navigation + username persistence.
      } else {
        setNotice('Account created! Check your inbox to confirm, then sign in.');
        setMode('signin');
        setLoading(false);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-up failed. Please try again.');
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!supabase) return;
    clear();
    setLoading(true);
    try {
      const { error: authErr } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getAuthEmailRedirectTo(),
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      if (authErr) throw authErr;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed. Please try again.');
      setLoading(false);
    }
  };

  const handleSignOutAndSwitch = async () => {
    if (!supabase) return;
    clear();
    setLoading(true);
    await supabase.auth.signOut();
    setLocalLoggedIn(false);
    setLoading(false);
  };

  const handleSubmit = mode === 'signin' ? handleSignIn : handleSignUp;

  const emailOk    = email.trim().length > 0;
  const passwordOk = password.length >= 6;
  const usernameOk = username.trim().length >= 2;
  const passwordsMatch = password === confirmPassword;
  const showMismatch = mode === 'signup' && confirmPassword.length > 0 && !passwordsMatch;
  const canSubmit =
    !loading &&
    emailOk &&
    passwordOk &&
    (mode === 'signin' || (usernameOk && passwordsMatch));

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
                Sign in to save progress, or continue as a guest.
              </p>
            </div>

            {!sessionReady ? (
              <p className="auth-feedback auth-feedback--notice" role="status">
                Checking session…
              </p>
            ) : localLoggedIn ? (
              <div className="auth-logged-in">
                <p className="auth-logged-in__welcome">
                  Signed in as <strong>{loggedInEmail || displayName}</strong>
                </p>
                {loggedInEmail && loggedInUsername && (
                  <p className="auth-logged-in__email">Playing as {loggedInUsername}</p>
                )}
                <button
                  className="btn btn--primary auth-btn-submit"
                  onClick={onContinue}
                  disabled={loading}
                >
                  <span className="btn__shimmer" aria-hidden />
                  <span className="btn__label">Continue to Character Creator</span>
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
                <button
                  type="button"
                  className="btn btn--google auth-btn-google"
                  onClick={handleGoogleSignIn}
                  disabled={loading}
                  aria-label="Continue with Google"
                >
                  <svg className="google-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                  </svg>
                  <span>Continue with Google</span>
                </button>

                <div className="card__divider auth-divider">
                  <span className="card__divider-line" />
                  <span className="auth-divider-text">or with email</span>
                  <span className="card__divider-line" />
                </div>

                <div className="auth-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={mode === 'signin'}
                    className={`auth-tab ${mode === 'signin' ? 'auth-tab--active' : ''}`}
                    onClick={() => { setMode('signin'); clear(); }}
                  >
                    Sign In
                  </button>
                  <button
                    role="tab"
                    aria-selected={mode === 'signup'}
                    className={`auth-tab ${mode === 'signup' ? 'auth-tab--active' : ''}`}
                    onClick={() => { setMode('signup'); clear(); }}
                  >
                    Create Account
                  </button>
                </div>

                {error       && <p className="auth-feedback auth-feedback--error"  role="alert">{error}</p>}
                {notice      && <p className="auth-feedback auth-feedback--notice" role="status">{notice}</p>}
                {showMismatch && !error && (
                  <p className="auth-feedback auth-feedback--error" role="alert">Passwords don't match.</p>
                )}

                <div className="auth-form">
                  {mode === 'signup' && (
                    <input
                      className="guest__input auth-input"
                      type="text"
                      placeholder="Username"
                      value={username}
                      onChange={e => { setUsername(e.target.value); clear(); }}
                      onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                      autoComplete="username"
                      aria-label="Username"
                      disabled={loading}
                      spellCheck={false}
                      maxLength={24}
                    />
                  )}
                  <input
                    className="guest__input auth-input"
                    type="email"
                    placeholder="email@example.com"
                    value={email}
                    onChange={e => { setEmail(e.target.value); clear(); }}
                    onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                    autoComplete="email"
                    aria-label="Email address"
                    disabled={loading}
                    spellCheck={false}
                  />
                  <input
                    className="guest__input auth-input"
                    type="password"
                    placeholder={mode === 'signup' ? 'Choose a password (6+ chars)' : 'Password'}
                    value={password}
                    onChange={e => { setPassword(e.target.value); clear(); }}
                    onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    aria-label="Password"
                    disabled={loading}
                  />
                  {mode === 'signup' && (
                    <input
                      className="guest__input auth-input"
                      type="password"
                      placeholder="Confirm password"
                      value={confirmPassword}
                      onChange={e => { setConfirmPassword(e.target.value); clear(); }}
                      onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
                      autoComplete="new-password"
                      aria-label="Confirm password"
                      disabled={loading}
                    />
                  )}
                  <button
                    className="btn btn--primary auth-btn-submit"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    aria-busy={loading}
                  >
                    <span className="btn__shimmer" aria-hidden />
                    <span className="btn__label">
                      {loading && mode === 'signin'  ? 'Signing in…'    :
                       loading && mode === 'signup'  ? 'Creating…'      :
                       mode === 'signin'             ? 'Sign In'        :
                                                       'Create Account' }
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

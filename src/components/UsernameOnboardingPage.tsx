import React, { useCallback, useState } from 'react';
import { checkUsernameAvailable, createRugtownProfile } from '../lib/profile';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
const RESERVED = new Set(['admin', 'moderator', 'mod', 'rugtown', 'system', 'support', 'help', 'null', 'undefined']);

interface UsernameOnboardingPageProps {
  onComplete: (username: string) => void;
}

export function UsernameOnboardingPage({ onComplete }: UsernameOnboardingPageProps) {
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);

  const validateLocal = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!USERNAME_RE.test(trimmed)) return 'Use 3–16 letters, numbers, or underscores.';
    if (RESERVED.has(trimmed.toLowerCase())) return 'That username is reserved.';
    return null;
  }, []);

  const handleBlur = useCallback(async () => {
    const invalid = validateLocal(username);
    if (invalid) {
      setStatus('invalid');
      setError(invalid);
      return;
    }
    setStatus('checking');
    setError(null);
    const ok = await checkUsernameAvailable(username.trim());
    setStatus(ok ? 'available' : 'taken');
    if (!ok) setError('Username already taken.');
  }, [username, validateLocal]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    const invalid = validateLocal(trimmed);
    if (invalid) {
      setError(invalid);
      setStatus('invalid');
      return;
    }
    setStatus('saving');
    setError(null);
    const result = await createRugtownProfile(trimmed);
    if (!result.ok) {
      setStatus('taken');
      setError(result.error ?? 'Could not save username.');
      return;
    }
    onComplete(result.username ?? trimmed);
  }, [username, validateLocal, onComplete]);

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
                Step 2 of 3 · Choose Username
              </p>
            </div>

            <p className="wallet-onboard__hint">
              This is your permanent RugTown handle. Your account restores it automatically.
            </p>

            {error && (
              <p className="auth-feedback auth-feedback--error" role="alert">{error}</p>
            )}
            {status === 'available' && (
              <p className="auth-feedback auth-feedback--notice" role="status">Username available</p>
            )}
            {status === 'checking' && (
              <p className="auth-feedback auth-feedback--notice" role="status">Checking…</p>
            )}

            <form onSubmit={(e) => void handleSubmit(e)}>
              <label className="wallet-onboard__label" htmlFor="rugtown-username">
                Username
              </label>
              <input
                id="rugtown-username"
                className="guest__input auth-input"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setStatus('idle');
                  setError(null);
                }}
                onBlur={() => void handleBlur()}
                maxLength={16}
                autoComplete="off"
                autoFocus
                spellCheck={false}
                aria-label="RugTown username"
              />
              <button
                type="submit"
                className="btn btn--primary auth-btn-submit"
                disabled={status === 'saving' || status === 'checking'}
                aria-busy={status === 'saving'}
              >
                <span className="btn__shimmer" aria-hidden />
                <span className="btn__label">
                  {status === 'saving' ? 'Saving…' : 'Continue'}
                </span>
              </button>
            </form>
          </div>

          <div className="card__bottom-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>
        </div>
      </main>
    </div>
  );
}

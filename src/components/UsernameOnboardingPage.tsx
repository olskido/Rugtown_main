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
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Choose Your Username</h1>
        <p className="auth-sub">This is your permanent RugTown handle. Your account login restores it automatically.</p>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <label className="auth-label" htmlFor="rugtown-username">Username</label>
          <input
            id="rugtown-username"
            className="auth-input"
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
          />
          {status === 'available' && <p className="auth-hint auth-hint--ok">Username available</p>}
          {status === 'checking' && <p className="auth-hint">Checking…</p>}
          {error && <p className="auth-error" role="alert">{error}</p>}

          <button
            type="submit"
            className="auth-submit"
            disabled={status === 'saving' || status === 'checking'}
          >
            {status === 'saving' ? 'Saving…' : 'Continue to RugTown'}
          </button>
        </form>
      </div>
    </div>
  );
}

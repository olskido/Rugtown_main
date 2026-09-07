import React, { useCallback, useRef, useState } from 'react';
import { saveWalletAddress, validateRobinhoodAddress, ROBINHOOD_CHAIN_ID } from '../lib/wallet';

/**
 * WalletOnboardingPage — Step 3 of the RugTown onboarding flow.
 *
 * Flow:  Sign in → Username (step 2) → Wallet Address (this, step 3) → Game
 *
 * • Accepts a Robinhood Chain (EVM) public address.
 * • Validates format client-side before the RPC round-trip.
 * • Server (save_wallet_address RPC) re-validates format, checks for
 *   duplicate ownership, normalises to lowercase hex, and sets
 *   onboarding_completed = true.
 * • On success calls onComplete(walletAddress, walletChain).
 * • Never asks for a private key or seed phrase.
 */

interface WalletOnboardingPageProps {
  username: string;
  onComplete: (walletAddress: string, walletChain: string) => void;
}

type Status = 'idle' | 'saving' | 'error';

export function WalletOnboardingPage({ username, onComplete }: WalletOnboardingPageProps) {
  const [address, setAddress] = useState('');
  const [status, setStatus]   = useState<Status>('idle');
  const [error, setError]     = useState<string | null>(null);
  const inputRef              = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAddress(e.target.value);
    setError(null);
    setStatus('idle');
  };

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = address.trim();

    // Client-side format check before the server round-trip.
    const localError = validateRobinhoodAddress(trimmed);
    if (localError) {
      setError(localError);
      setStatus('error');
      inputRef.current?.focus();
      return;
    }

    setStatus('saving');
    setError(null);

    const result = await saveWalletAddress(trimmed, ROBINHOOD_CHAIN_ID);

    if (!result.ok) {
      setError(result.message ?? 'Could not save wallet address. Please try again.');
      setStatus('error');
      inputRef.current?.focus();
      return;
    }

    // Server normalises to lowercase — use the server-returned value.
    onComplete(result.walletAddress ?? trimmed, result.walletChain ?? ROBINHOOD_CHAIN_ID);
  }, [address, onComplete]);

  const isSaving = status === 'saving';

  return (
    <div className="landing auth-page landing--mounted screen-enter">
      <div className="landing__bg" aria-hidden>
        <div className="landing__bg-city" />
        <div className="landing__vignette-warm" />
        <div className="landing__overlay" />
      </div>

      <main className="auth-page__content">
        <div className="landing__card auth-page__card" role="main">
          {/* Card chrome */}
          <div className="card__top-ornament" aria-hidden>
            <div className="card__top-ornament-line" />
          </div>
          <span className="card__corner card__corner--tl" aria-hidden>◆</span>
          <span className="card__corner card__corner--tr" aria-hidden>◆</span>
          <span className="card__corner card__corner--bl" aria-hidden>◆</span>
          <span className="card__corner card__corner--br" aria-hidden>◆</span>

          <div className="card__inner auth-page__inner">

            {/* Header */}
            <div className="auth-page__header">
              <div className="auth-page__logo">RUGTOWN</div>
              <p className="auth-page__subtitle">
                Step 3 of 3 · Connect Wallet
              </p>
            </div>

            {/* Greeting */}
            <p style={{
              fontFamily: 'Cinzel, serif',
              fontSize: 13,
              color: '#c8b89a',
              textAlign: 'center',
              marginBottom: 4,
            }}>
              Welcome, <strong style={{ color: '#e8b84b' }}>{username}</strong>
            </p>

            {/* Chain badge */}
            <div className="wallet-onboard__chain-badge" aria-label="Network: Robinhood Chain">
              <span className="wallet-onboard__chain-dot" aria-hidden />
              Robinhood Chain
            </div>

            {/* Helper copy */}
            <p className="wallet-onboard__hint">
              Enter your public Robinhood Chain wallet address to link it to
              your RugTown account. This is shown on leaderboards.
            </p>
            <p className="wallet-onboard__warn" role="note">
              ⚠ Never enter your private key or seed phrase here — only your
              <strong> public address</strong> (starts with 0x).
            </p>

            {/* Error */}
            {error && (
              <p className="auth-feedback auth-feedback--error" role="alert">
                {error}
              </p>
            )}

            {/* Form */}
            <form onSubmit={(e) => void handleSubmit(e)} noValidate>
              <label
                className="wallet-onboard__label"
                htmlFor="wallet-address-input"
              >
                Wallet Address
              </label>
              <input
                ref={inputRef}
                id="wallet-address-input"
                className="guest__input auth-input wallet-onboard__input"
                type="text"
                inputMode="text"
                placeholder="0x…"
                value={address}
                onChange={handleChange}
                disabled={isSaving}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={42}
                aria-label="Robinhood Chain wallet address"
                aria-describedby="wallet-address-hint"
                aria-invalid={status === 'error'}
              />
              <p
                id="wallet-address-hint"
                className="wallet-onboard__char-hint"
                aria-live="polite"
              >
                {address.trim().length > 0
                  ? `${address.trim().length} / 42 characters`
                  : '42 characters · starts with 0x'}
              </p>

              <button
                type="submit"
                className="btn btn--primary auth-btn-submit"
                disabled={isSaving || address.trim().length === 0}
                aria-busy={isSaving}
              >
                <span className="btn__shimmer" aria-hidden />
                <span className="btn__label">
                  {isSaving ? 'Saving…' : 'Connect Wallet'}
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

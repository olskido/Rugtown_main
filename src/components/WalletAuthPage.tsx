import React, { useCallback, useEffect, useState } from 'react';
import { discoverSolanaWallets, type SolanaWalletProvider } from '../lib/wallet/SolanaWalletProviders';
import {
  authenticateWithSolanaWallet,
  type WalletAuthStage,
} from '../lib/wallet/SolanaWalletAuth';
import { getRugtownProfileState } from '../lib/profile';

interface WalletAuthPageProps {
  onAuthenticated: (opts: { needsUsername: boolean; username?: string }) => void;
  onBack: () => void;
}

const STAGE_LABEL: Record<WalletAuthStage, string> = {
  idle: '',
  selecting: 'Choose a wallet…',
  connecting: 'Connecting wallet…',
  signing: 'Waiting for signature…',
  session: 'Entering RugTown…',
  error: '',
};

export function WalletAuthPage({ onAuthenticated, onBack }: WalletAuthPageProps) {
  const [wallets, setWallets] = useState<SolanaWalletProvider[]>([]);
  const [stage, setStage] = useState<WalletAuthStage>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWallets(discoverSolanaWallets());
  }, []);

  const handleSelect = useCallback(async (provider: SolanaWalletProvider) => {
    setError(null);
    setStage('selecting');
    try {
      await authenticateWithSolanaWallet(provider, setStage);
      const state = await getRugtownProfileState();
      if (!state) {
        onAuthenticated({ needsUsername: true });
        return;
      }
      if (!state.onboardingCompleted || !state.username) {
        onAuthenticated({ needsUsername: true });
        return;
      }
      onAuthenticated({ needsUsername: false, username: state.username });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Wallet authentication failed.';
      if (/reject|cancel|denied/i.test(msg)) {
        setError('Signature rejected. RugTown requires wallet authentication to play.');
      } else if (/connect/i.test(msg)) {
        setError('Could not connect to the wallet. Try again or pick another wallet.');
      } else {
        setError(msg);
      }
      setStage('error');
    }
  }, [onAuthenticated]);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <button type="button" className="auth-back" onClick={onBack}>← Back</button>
        <h1 className="auth-title">Play with Solana Wallet</h1>
        <p className="auth-sub">
          Connect your wallet, then sign the authentication message. Connecting alone does not enter the city.
        </p>

        {stage !== 'idle' && stage !== 'error' && (
          <p className="auth-status" role="status">{STAGE_LABEL[stage]}</p>
        )}

        {error && <p className="auth-error" role="alert">{error}</p>}

        {wallets.length === 0 ? (
          <p className="auth-sub">
            No Solana wallet detected. Install Phantom, Solflare, or Backpack, then refresh.
          </p>
        ) : (
          <ul className="wallet-list">
            {wallets.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="wallet-list__btn"
                  disabled={stage === 'connecting' || stage === 'signing' || stage === 'session'}
                  onClick={() => void handleSelect(w)}
                >
                  {w.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

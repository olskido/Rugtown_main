import React, { useCallback, useEffect, useState } from 'react';
import { shortenWalletAddress } from '../../lib/wallet/SolanaWalletProviders';
import {
  claimEpochReward,
  fetchVaultState,
  formatVaultTokens,
  type VaultStateView,
} from '../../lib/vault/VaultService';
import { refreshHolderStatus } from '../../lib/vault/HolderService';

interface RugTownVaultPanelProps {
  open: boolean;
  onClose: () => void;
}

export function RugTownVaultPanel({ open, onClose }: RugTownVaultPanelProps) {
  const [state, setState] = useState<VaultStateView | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<string>('');

  const reload = useCallback(async () => {
    setLoading(true);
    setStage('Checking holdings…');
    await refreshHolderStatus({ force: true });
    const next = await fetchVaultState();
    setState(next);
    setLoading(false);
    setStage(next?.holderStale ? 'Holder status may be stale — refresh again later.' : '');
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const handleClaim = async () => {
    if (!state?.pendingEpochId) return;
    setStage('Preparing claim…');
    const res = await claimEpochReward(state.pendingEpochId);
    if (res.ok) {
      setStage(res.signature ? `Reward claimed. Tx: ${res.signature.slice(0, 8)}…` : 'Reward claimed.');
      await reload();
    } else {
      setStage(res.error ?? 'Claim failed.');
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-label="RugTown Vault">
      <div className="modal-panel vault-panel">
        <header className="modal-header">
          <span className="modal-header__title">RugTown Vault</span>
          <span className="modal-header__sub">Token rewards · separate from REP</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {loading ? <p className="modal-text">{stage || 'Loading vault…'}</p> : (
          <>
            <div className="vault-grid">
              <div className="vault-row"><span>Wallet</span><span>{state?.walletAddress ? shortenWalletAddress(state.walletAddress) : '—'}</span></div>
              <div className="vault-row"><span>Holder Tier</span><span>{state?.holderTier ?? 'none'}</span></div>
              <div className="vault-row"><span>Holder Multiplier</span><span>{state?.rpMultiplier?.toFixed(2) ?? '1.00'}× RP</span></div>
              <div className="vault-row"><span>Reward Points</span><span>{state?.rewardPoints?.toLocaleString() ?? 0}</span></div>
              <div className="vault-row"><span>Claimable $RUGTOWN</span><span>{state ? formatVaultTokens(state.claimableTokenBaseUnits) : '0'}</span></div>
              <div className="vault-row"><span>Lifetime Claimed</span><span>{state ? formatVaultTokens(state.lifetimeClaimedBaseUnits) : '0'}</span></div>
            </div>
            {stage && <p className="auth-hint">{stage}</p>}
            <button
              type="button"
              className="profile-action-btn profile-action-btn--primary"
              disabled={!state?.pendingEpochId || state.claimableTokenBaseUnits <= 0n}
              onClick={() => void handleClaim()}
            >
              Claim Rewards
            </button>
          </>
        )}
      </div>
    </div>
  );
}

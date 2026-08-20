import React, { useCallback, useEffect, useState } from 'react';

import {

  claimGuildContract,

  fetchGuildState,

  type GuildStateView,

} from '../../lib/guild/GuildService';



interface RugTownGuildPanelProps {

  open: boolean;

  playerLevel: number;

  playerRep: number;

  onClose: () => void;

  onRepAwarded?: (amount: number) => void;

}



export function RugTownGuildPanel({

  open,

  playerLevel,

  playerRep,

  onClose,

  onRepAwarded,

}: RugTownGuildPanelProps) {

  const [tab, setTab] = useState<'daily' | 'bounty'>('daily');

  const [state, setState] = useState<GuildStateView | null>(null);

  const [loading, setLoading] = useState(false);

  const [message, setMessage] = useState<string | null>(null);



  const reload = useCallback(async () => {

    setLoading(true);

    setMessage(null);

    const next = await fetchGuildState();

    setState(next);

    setLoading(false);

  }, []);



  useEffect(() => {

    if (open) void reload();

  }, [open, reload]);



  const handleClaim = async (id: string) => {

    setMessage('Claiming REP…');

    const res = await claimGuildContract(id);

    if (res.ok) {

      let totalRep = res.repAwarded ?? 0;

      if (res.dailyBonusRep) totalRep += res.dailyBonusRep;

      setMessage(
        res.dailyBonusRep
          ? `+${res.repAwarded ?? 0} REP · Daily bonus +${res.dailyBonusRep} REP`
          : `+${res.repAwarded ?? 0} REP claimed.`,
      );

      onRepAwarded?.(totalRep);

      await reload();

    } else {

      setMessage(res.error ?? 'Claim failed.');

    }

  };



  if (!open) return null;



  const list = tab === 'daily' ? state?.dailyContracts ?? [] : state?.bounties ?? [];



  return (

    <div className="modal-backdrop" role="dialog" aria-label="RugTown Guild">

      <div className="modal-panel guild-panel">

        <header className="modal-header">

          <span className="modal-header__title">RugTown Guild</span>

          <span className="modal-header__sub">Level {playerLevel} · {playerRep.toLocaleString()} REP</span>

          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>

        </header>



        <div className="guild-panel__stats">

          <span>Guild streak: {state?.streak.current ?? 0} days</span>

          <span>Today&apos;s possible REP: {list.reduce((s, c) => s + (c.status === 'claimed' ? 0 : c.repReward), 0)}</span>

        </div>



        <div className="guild-panel__tabs">

          <button type="button" className={tab === 'daily' ? 'guild-tab guild-tab--active' : 'guild-tab'} onClick={() => setTab('daily')}>Daily Contracts</button>

          <button type="button" className={tab === 'bounty' ? 'guild-tab guild-tab--active' : 'guild-tab'} onClick={() => setTab('bounty')}>Bounty Board</button>

        </div>



        {loading && <p className="modal-text">Loading contracts…</p>}

        {message && <p className="auth-hint">{message}</p>}



        <ul className="guild-contract-list">

          {list.map((c) => (

            <li key={c.id} className="guild-contract">

              <div className="guild-contract__head">

                <strong>{c.title}</strong>

                <span className="guild-contract__reward">+{c.repReward} REP</span>

              </div>

              <p className="guild-contract__desc">{c.description}</p>

              <p className="guild-contract__progress">{c.progress}/{c.target} · {c.status}</p>

              {c.status === 'completed' && (

                <button type="button" className="profile-action-btn profile-action-btn--primary" onClick={() => void handleClaim(c.id)}>

                  Claim REP

                </button>

              )}

            </li>

          ))}

        </ul>

      </div>

    </div>

  );

}


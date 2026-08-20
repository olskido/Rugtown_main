/**
 * Supabase Auth Sign in with Web3 (Solana).
 * Wallet connection alone does NOT authenticate — signInWithWeb3 validates the signature.
 */

import { supabase } from '../supabase';
import type { SolanaWalletAdapterLike, SolanaWalletProvider } from './SolanaWalletProviders';

const WEB3_STATEMENT =
  'I sign in to RugTown and accept the Terms of Service at https://rugtown.game/terms';

export type WalletAuthStage =
  | 'idle'
  | 'selecting'
  | 'connecting'
  | 'signing'
  | 'session'
  | 'error';

export interface WalletAuthResult {
  userId: string;
  walletAddress: string | null;
}

async function signInWithWeb3(wallet: SolanaWalletAdapterLike): Promise<WalletAuthResult> {
  if (!supabase) throw new Error('Supabase is not configured.');

  // supabase-js >= 2.49 includes signInWithWeb3; cast for older generated types.
  const auth = supabase.auth as typeof supabase.auth & {
    signInWithWeb3: (opts: {
      chain: 'solana';
      statement: string;
      wallet?: SolanaWalletAdapterLike;
    }) => Promise<{ data: { user: { id: string } | null }; error: Error | null }>;
  };

  const { data, error } = await auth.signInWithWeb3({
    chain: 'solana',
    statement: WEB3_STATEMENT,
    wallet,
  });

  if (error) throw error;
  if (!data.user?.id) throw new Error('Authentication succeeded but no user was returned.');

  const walletAddress = wallet.publicKey?.toBase58() ?? null;
  return { userId: data.user.id, walletAddress };
}

export async function authenticateWithSolanaWallet(
  provider: SolanaWalletProvider,
  onStage?: (stage: WalletAuthStage) => void,
): Promise<WalletAuthResult> {
  onStage?.('connecting');
  if (provider.adapter.connect) {
    await provider.adapter.connect();
  }

  onStage?.('signing');
  const result = await signInWithWeb3(provider.adapter);

  onStage?.('session');
  return result;
}

export async function disconnectWalletSession(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

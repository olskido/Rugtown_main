/**
 * Lightweight Solana wallet discovery (Wallet Standard / injected providers).
 * No hard dependency on @solana/wallet-adapter — supports Phantom, Solflare, Backpack, etc.
 */

export interface SolanaWalletProvider {
  id: string;
  name: string;
  icon?: string;
  /** Injected provider object passed to supabase.auth.signInWithWeb3({ wallet }) */
  adapter: SolanaWalletAdapterLike;
}

export interface SolanaWalletAdapterLike {
  publicKey?: { toBase58(): string } | null;
  connected?: boolean;
  connect?: () => Promise<unknown>;
  disconnect?: () => Promise<unknown>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
  signIn?: (input?: unknown) => Promise<unknown>;
}

declare global {
  interface Window {
    solana?: SolanaWalletAdapterLike & { isPhantom?: boolean; isSolflare?: boolean; isBackpack?: boolean };
    solflare?: SolanaWalletAdapterLike;
    backpack?: SolanaWalletAdapterLike;
    braveSolana?: SolanaWalletAdapterLike;
  }
}

const KNOWN: Array<{ id: string; name: string; pick: () => SolanaWalletAdapterLike | undefined }> = [
  { id: 'phantom', name: 'Phantom', pick: () => window.solana?.isPhantom ? window.solana : undefined },
  { id: 'solflare', name: 'Solflare', pick: () => window.solflare ?? (window.solana?.isSolflare ? window.solana : undefined) },
  { id: 'backpack', name: 'Backpack', pick: () => window.backpack ?? (window.solana?.isBackpack ? window.solana : undefined) },
  { id: 'brave', name: 'Brave Wallet', pick: () => window.braveSolana },
  { id: 'solana', name: 'Solana Wallet', pick: () => window.solana },
];

export function discoverSolanaWallets(): SolanaWalletProvider[] {
  if (typeof window === 'undefined') return [];
  const seen = new Set<SolanaWalletAdapterLike>();
  const out: SolanaWalletProvider[] = [];
  for (const k of KNOWN) {
    const adapter = k.pick();
    if (!adapter || seen.has(adapter)) continue;
    seen.add(adapter);
    out.push({ id: k.id, name: k.name, adapter });
  }
  return out;
}

export async function connectWalletProvider(provider: SolanaWalletProvider): Promise<string> {
  if (provider.adapter.connect) {
    await provider.adapter.connect();
  }
  const pk = provider.adapter.publicKey?.toBase58();
  if (!pk) throw new Error('Wallet connected but no public key returned.');
  return pk;
}

export function shortenWalletAddress(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

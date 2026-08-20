/**
 * _shared/spl-transfer.ts — server-side SPL token transfer with optional ATA creation.
 * Treasury signs. Never expose private key outside this module.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from 'https://esm.sh/@solana/web3.js@1.95.3';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from 'https://esm.sh/@solana/spl-token@0.4.9';
import bs58 from 'https://esm.sh/bs58@5.0.0';

export interface SplTransferInput {
  rpcEndpoint: string;
  treasurySecret: string;
  mintAddress: string;
  recipientWallet: string;
  amountBaseUnits: bigint;
  minConfirmations?: 'confirmed' | 'finalized';
}

export interface SplTransferResult {
  signature: string;
  createdAta: boolean;
}

function loadTreasuryKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export async function transferSplTokens(input: SplTransferInput): Promise<SplTransferResult> {
  const treasury = loadTreasuryKeypair(input.treasurySecret);
  const mint = new PublicKey(input.mintAddress);
  const recipient = new PublicKey(input.recipientWallet);
  const commitment = input.minConfirmations ?? 'confirmed';
  const conn = new Connection(input.rpcEndpoint, commitment);

  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  const tx = new Transaction();
  let createdAta = false;

  const recipientAtaInfo = await conn.getAccountInfo(recipientAta);
  if (!recipientAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        recipientAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    createdAta = true;
  }

  const amount = Number(input.amountBaseUnits);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('invalid_transfer_amount');
  }

  tx.add(
    createTransferInstruction(
      treasuryAta,
      recipientAta,
      treasury.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  const signature = await sendAndConfirmTransaction(conn, tx, [treasury], {
    commitment,
  });

  return { signature, createdAta };
}

/** Read SPL balance for treasury ATA and native SOL for fee check. */
export async function readTreasuryBalances(
  rpcEndpoint: string,
  treasuryPublicKey: string,
  mintAddress: string,
): Promise<{ tokenBaseUnits: bigint; solLamports: bigint } | null> {
  try {
    const conn = new Connection(rpcEndpoint, 'confirmed');
    const treasury = new PublicKey(treasuryPublicKey);
    const mint = new PublicKey(mintAddress);
    const ata = getAssociatedTokenAddressSync(mint, treasury);
    const [sol, tokenAcc] = await Promise.all([
      conn.getBalance(treasury),
      conn.getTokenAccountBalance(ata).catch(() => null),
    ]);
    const tokenBaseUnits = tokenAcc ? BigInt(tokenAcc.value.amount) : 0n;
    return { tokenBaseUnits, solLamports: BigInt(sol) };
  } catch {
    return null;
  }
}

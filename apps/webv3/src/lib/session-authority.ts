import { encodeCanonicalSessionGrantMessage } from '@degen/types';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_ID } from './solana';

export function getSessionAuthorityPda(wallet: PublicKey, sessionSigner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('session_authority'), wallet.toBuffer(), sessionSigner.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function buildCanonicalSessionGrantMessage(
  wallet: PublicKey,
  sessionSigner: PublicKey,
  expiresAt: number
): Uint8Array {
  const sessionAuthority = getSessionAuthorityPda(wallet, sessionSigner);
  return encodeCanonicalSessionGrantMessage({
    programId: PROGRAM_ID.toBytes(),
    wallet: wallet.toBytes(),
    sessionPubkey: sessionSigner.toBytes(),
    sessionAuthority: sessionAuthority.toBytes(),
    expiresAt: BigInt(expiresAt),
  });
}

export async function buildCreateSessionAuthorityInstruction(
  wallet: PublicKey,
  sessionSigner: PublicKey,
  expiresAt: number
): Promise<TransactionInstruction> {
  const discriminator = await computeAnchorDiscriminator('create_session_authority');
  const data = Buffer.alloc(8 + 32 + 8);
  discriminator.copy(data, 0);
  Buffer.from(sessionSigner.toBytes()).copy(data, 8);
  data.writeBigInt64LE(BigInt(expiresAt), 40);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: getSessionAuthorityPda(wallet, sessionSigner), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export async function buildRevokeSessionAuthorityInstruction(
  wallet: PublicKey,
  sessionSigner: PublicKey
): Promise<TransactionInstruction> {
  const discriminator = await computeAnchorDiscriminator('revoke_session_authority');
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: getSessionAuthorityPda(wallet, sessionSigner), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(discriminator),
  });
}

async function computeAnchorDiscriminator(name: string): Promise<Buffer> {
  const input = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return Buffer.from(hash).subarray(0, 8);
}

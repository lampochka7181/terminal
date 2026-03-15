export interface CanonicalSessionGrantMessage {
  programId: Uint8Array;
  wallet: Uint8Array;
  sessionPubkey: Uint8Array;
  sessionAuthority: Uint8Array;
  expiresAt: bigint;
}

export function encodeCanonicalSessionGrantMessage(
  message: CanonicalSessionGrantMessage
): Uint8Array {
  const text = [
    'DT_SESSION_GRANT_V1',
    `program_id=${encodeBase58(assertPubkeyLength(message.programId, 'programId'))}`,
    `wallet=${encodeBase58(assertPubkeyLength(message.wallet, 'wallet'))}`,
    `session_pubkey=${encodeBase58(assertPubkeyLength(message.sessionPubkey, 'sessionPubkey'))}`,
    `session_authority=${encodeBase58(assertPubkeyLength(message.sessionAuthority, 'sessionAuthority'))}`,
    `expires_at=${message.expiresAt.toString()}`,
  ].join('\n');
  return encodeAscii(text);
}

export function getCanonicalSessionGrantPrefix(): Uint8Array {
  return encodeAscii('DT_SESSION_GRANT_V1');
}

function assertPubkeyLength(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return bytes;
}

function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new Error('Canonical session grant message must be ASCII');
    }
    bytes[i] = code;
  }
  return bytes;
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (bytes.length === 0) return '';

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  let result = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    result += alphabet[digits[i]];
  }
  return result;
}

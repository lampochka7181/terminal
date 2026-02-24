/**
 * Merkle tree implementation for V2 settlement.
 *
 * Must produce identical hashes to the on-chain implementation in
 * packages/contracts/programs/degen-terminal/src/state_v2.rs:
 *   - create_settlement_leaf: keccak256(pubkey_32bytes || amount_u64_le)
 *   - hash_pair: sorted-pair keccak256 (smaller bytes first)
 *   - verify_merkle_proof: index-based walk with sorted-pair hashing
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey } from '@solana/web3.js';

/** Domain separation prefixes — must match on-chain state_v2.rs */
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/**
 * Create a settlement leaf hash.
 * Matches on-chain: keccak256(0x00 || recipient (32 bytes) || amount (u64 LE))
 * Uses LEAF_PREFIX domain separation to prevent leaf/internal node confusion.
 */
export function createSettlementLeaf(recipient: InstanceType<typeof PublicKey>, amount: bigint): Uint8Array {
  const data = new Uint8Array(41); // 1 prefix + 32 + 8
  data[0] = LEAF_PREFIX;
  data.set(recipient.toBytes(), 1);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setBigUint64(33, amount, true); // little-endian
  return keccak_256(data);
}

/**
 * Hash two 32-byte values together, sorted (smaller first).
 * Matches on-chain hash_pair in state_v2.rs.
 * Uses NODE_PREFIX (0x01) domain separation for internal nodes.
 */
export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const concat = new Uint8Array(65); // 1 prefix + 32 + 32
  concat[0] = NODE_PREFIX;
  if (compareBytes(a, b) < 0) {
    concat.set(a, 1);
    concat.set(b, 33);
  } else {
    concat.set(b, 1);
    concat.set(a, 33);
  }
  return keccak_256(concat);
}

/** Lexicographic comparison of two Uint8Array values. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Settlement leaf input. */
export interface SettlementLeaf {
  recipient: InstanceType<typeof PublicKey>;
  /** USDC amount in native units (6 decimals). */
  amount: bigint;
}

/** Result of building a merkle tree. */
export interface MerkleTree {
  root: Uint8Array;
  leafCount: number;
  /** Get the proof (array of sibling hashes) for leaf at the given index. */
  getProof(index: number): Uint8Array[];
}

/**
 * Build a merkle tree from settlement leaves.
 *
 * Algorithm:
 * 1. Hash each leaf: keccak256(recipient || amount_le)
 * 2. Pad to next power of 2 with a zero-hash leaf
 * 3. Build levels bottom-up using sorted-pair hashing
 * 4. Proof = array of siblings from bottom to top
 */
export function buildMerkleTree(leaves: SettlementLeaf[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error('Cannot build merkle tree with zero leaves');
  }

  // Hash all real leaves
  const hashedLeaves: Uint8Array[] = leaves.map(l =>
    createSettlementLeaf(l.recipient, l.amount),
  );

  const realCount = hashedLeaves.length;

  // Pad to next power of 2
  const n = nextPowerOf2(realCount);
  const emptyLeaf = keccak_256(new Uint8Array(40)); // zero-padded leaf
  while (hashedLeaves.length < n) {
    hashedLeaves.push(emptyLeaf);
  }

  // Build levels bottom-up
  const levels: Uint8Array[][] = [hashedLeaves];
  let current = hashedLeaves;
  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashPair(current[i], current[i + 1]));
    }
    levels.push(next);
    current = next;
  }

  return {
    root: current[0],
    leafCount: realCount,
    getProof(index: number): Uint8Array[] {
      if (index < 0 || index >= realCount) {
        throw new Error(`Leaf index ${index} out of range [0, ${realCount})`);
      }
      const proof: Uint8Array[] = [];
      let idx = index;
      for (let level = 0; level < levels.length - 1; level++) {
        const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
        proof.push(levels[level][sibling]);
        idx = Math.floor(idx / 2);
      }
      return proof;
    },
  };
}

/**
 * Verify a merkle proof (mirrors on-chain verify_merkle_proof).
 * Useful for testing before submitting on-chain.
 */
export function verifyMerkleProof(
  proof: Uint8Array[],
  root: Uint8Array,
  leaf: Uint8Array,
  index: number,
): boolean {
  let computedHash = leaf;
  let idx = index;

  for (const proofElement of proof) {
    if (idx % 2 === 0) {
      computedHash = hashPair(computedHash, proofElement);
    } else {
      computedHash = hashPair(proofElement, computedHash);
    }
    idx = Math.floor(idx / 2);
  }

  return compareBytes(computedHash, root) === 0;
}

function nextPowerOf2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

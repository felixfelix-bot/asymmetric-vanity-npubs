/**
 * Atomic Swap — SHA256(d) hash commitment for atomic offset sale (ADR-008).
 *
 * The core idea: the offset `d` is the HTLC preimage. The server finds `d`,
 * computes `h = SHA256(d)`, and sends the buyer:
 *   - `target_npub`: proof the vanity NPUB exists (publicly verifiable)
 *   - `hash_commitment`: h = SHA256(d) — does NOT reveal d
 *
 * The buyer creates a payment (Cashu NUT-11 HTLC or Lightning HTLC) locked
 * with hashlock = h. The server claims the payment by revealing `d`, which
 * simultaneously delivers the offset to the buyer.
 *
 * This module handles:
 *   1. Computing the hash commitment from an offset
 *   2. Verifying a preimage against a commitment
 *   3. Building the atomic swap offer (sent to the buyer)
 *   4. Verifying the buyer's target NPUB (public key math, no secret needed)
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { HtlcRequest } from "./cashu.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Atomic swap offer — sent from server to buyer after the server has found
 * the offset but before payment.
 *
 * The buyer can verify `targetNpub` independently (it's just public key math:
 * P + d·G → bech32). The `hashCommitment` proves the server knows `d` without
 * revealing it.
 */
export interface AtomicSwapOffer {
  /** The vanity NPUB that will result from applying offset d */
  targetNpub: string;
  /** SHA256(d) as hex — hash commitment, does NOT reveal d */
  hashCommitment: string;
  /** Price in sats */
  priceSats: number;
  /** Cashu mint URL (for Cashu HTLC) or null for Lightning */
  cashuMintUrl: string | null;
  /** Optional Lightning invoice (if using LN HTLC) */
  lightningInvoice?: string;
  /** Instructions for the buyer to create the locked payment */
  htlcRequest?: HtlcRequest;
  /** Expiry timestamp (epoch ms) — buyer gets refund after this */
  expiryMs: number;
}

/** Result of verifying a preimage against a hash commitment. */
export interface PreimageVerification {
  /** Whether SHA256(preimage) matches the commitment */
  valid: boolean;
  /** The expected hash (hex) */
  expectedHash: string;
  /** The computed hash (hex) */
  computedHash: string;
}

// ---------------------------------------------------------------------------
// Hash commitment functions
// ---------------------------------------------------------------------------

/**
 * Compute the hash commitment h = SHA256(d) for an offset.
 *
 * The offset `d` is a BigInt (the scalar added to the private key).
 * We encode it as a 32-byte big-endian value before hashing, matching
 * the typical secp256k1 scalar representation.
 *
 * @param offset - The offset `d` as a BigInt
 * @returns 64-character hex string (SHA256 of the 32-byte big-endian d)
 */
export function computeHashCommitment(offset: bigint): string {
  // Encode d as 32-byte big-endian (standard for secp256k1 scalars)
  const bytes = bigintTo32Bytes(offset);
  const hash = sha256(bytes);
  return bytesToHex(hash);
}

/**
 * Verify that a preimage (offset d) matches a hash commitment.
 *
 * @param preimage - The offset `d` as a BigInt
 * @param commitment - The expected SHA256(d) as hex
 * @returns Verification result
 */
export function verifyPreimage(
  preimage: bigint,
  commitment: string,
): PreimageVerification {
  const computed = computeHashCommitment(preimage);
  return {
    valid: computed.toLowerCase() === commitment.toLowerCase(),
    expectedHash: commitment,
    computedHash: computed,
  };
}

// ---------------------------------------------------------------------------
// Atomic swap offer construction
// ---------------------------------------------------------------------------

/**
 * Build an atomic swap offer after the server has found an offset.
 *
 * This is the message sent to the buyer. It contains proof the vanity NPUB
 * exists (targetNpub) and a hash commitment that locks the payment without
 * revealing the offset.
 *
 * @param offset - The found offset `d` (BigInt)
 * @param targetNpub - The resulting vanity NPUB string
 * @param priceSats - Price in sats
 * @param cashuMintUrl - Cashu mint URL (or null if using Lightning)
 * @param expiryMs - Expiry timestamp (epoch ms). Default: now + 48h
 * @returns AtomicSwapOffer ready to send to the buyer
 */
export function buildAtomicSwapOffer(
  offset: bigint,
  targetNpub: string,
  priceSats: number,
  cashuMintUrl: string | null,
  expiryMs?: number,
): AtomicSwapOffer {
  const hashCommitment = computeHashCommitment(offset);
  const expiry = expiryMs ?? Date.now() + 48 * 60 * 60 * 1000; // 48 hours

  let htlcRequest: HtlcRequest | undefined;
  if (cashuMintUrl) {
    htlcRequest = {
      type: "htlc",
      mint: cashuMintUrl,
      amount: priceSats,
      hashLock: hashCommitment,
      description: "Vanity NPUB grinding — reveal preimage to claim",
    };
  }

  return {
    targetNpub,
    hashCommitment,
    priceSats,
    cashuMintUrl,
    htlcRequest,
    expiryMs: expiry,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Convert a BigInt to a 32-byte big-endian Uint8Array.
 *
 * secp256k1 scalars are 256-bit (32-byte) values. We zero-pad on the left
 * to ensure consistent hashing regardless of the magnitude of d.
 *
 * @param value - BigInt value
 * @returns 32-byte big-endian array
 */
export function bigintTo32Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/**
 * Convert a hex string to a BigInt.
 *
 * @param hex - Hex string (with or without 0x prefix)
 * @returns BigInt value
 */
export function hexToBigint(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + clean);
}
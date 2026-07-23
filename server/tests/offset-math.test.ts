/**
 * Unit tests for offset grinding mathematics.
 *
 * Tests:
 *  - P + d·G produces the correct NPUB for known d values
 *  - Wrap-around: (k + d) mod n still produces P + d·G
 *  - Cross-reference with @noble/secp256k1 scalar multiplication
 *  - Incremental point addition matches one-shot scalar multiplication
 *  - d=0 returns the original NPUB
 *  - Large d values near curve order still work
 *
 * Per Phase 8.1 of IMPLEMENTATION-PLAN.md.
 */

import { getPublicKey, Point, utils, CURVE } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";

// ─── Test helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function test(name: string, fn: () => void | Promise<void>): void {
  console.log(`\n▶ ${name}`);
  try {
    const result = fn();
    if (result instanceof Promise) {
      // Mark as async — caller should use runAsync
      result.catch((e) => {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`${name}: ${msg}`);
        console.error(`  ✗ ASYNC ERROR: ${msg}`);
      });
    }
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.error(`  ✗ ERROR: ${msg}`);
  }
}

async function runAsync(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.error(`  ✗ ERROR: ${msg}`);
  }
}

// secp256k1 curve order n
const CURVE_N = CURVE.n;

// ─── Helper: encode 32-byte x-only pubkey as npub ──────────────────────────

function xOnlyToNpub(xOnlyBytes: Uint8Array): string {
  // nostr-tools nip19.npubEncode expects a 32-byte hex string
  const hex = bytesToHex(xOnlyBytes);
  return nip19.npubEncode(hex);
}

// ─── Helper: get x-only public key from private key ─────────────────────────

function getXOnlyPubkey(privKey: Uint8Array): Uint8Array {
  const compressed = getPublicKey(privKey, true);
  // Compressed format: 33 bytes, first byte is parity prefix (0x02 or 0x03)
  // x-only = last 32 bytes
  return compressed.slice(1);
}

// ─── Helper: compute P + d·G ────────────────────────────────────────────────

function computeOffsetNpub(pubKeyXOnly: Uint8Array, d: bigint): string {
  // Reconstruct the full point from x-only with even parity (standard assumption)
  // Decompress x-only public key to a point
  // The compressed form is 0x02 + x (even y) — we try both parities
  const compressedEven = new Uint8Array(33);
  compressedEven[0] = 0x02;
  compressedEven.set(pubKeyXOnly, 1);
  let P: typeof Point.BASE;
  try {
    P = Point.fromHex(bytesToHex(compressedEven));
  } catch {
    // Try odd parity
    const compressedOdd = new Uint8Array(33);
    compressedOdd[0] = 0x03;
    compressedOdd.set(pubKeyXOnly, 1);
    P = Point.fromHex(bytesToHex(compressedOdd));
  }

  // Compute P + d·G
  const G = Point.BASE;
  const dG = G.multiply(d);
  const newPoint = P.add(dG);
  const newXOnly = newPoint.toAffine().slice(0, 32);
  return xOnlyToNpub(newXOnly);
}

// ─── Helper: compute (k + d) mod n → public key → npub ──────────────────────

function computeDirectNpub(privKey: Uint8Array, d: bigint): string {
  const k = utils.bytesToNumberBE(privKey);
  const newK = (k + d) % CURVE_N;
  const newPrivBytes = utils.numberToBytesBE(newK, 32);
  const xOnly = getXOnlyPubkey(newPrivBytes);
  return xOnlyToNpub(xOnly);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("d=0: offset grinding with d=0 returns original NPUB", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const originalNpub = xOnlyToNpub(xOnly);
  const offsetNpub = computeOffsetNpub(xOnly, 0n);
  assert(offsetNpub === originalNpub, `d=0 should return original npub: ${offsetNpub} vs ${originalNpub}`);
});

test("d=1: P + 1·G matches (k+1)·G directly", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const offsetNpub = computeOffsetNpub(xOnly, 1n);
  const directNpub = computeDirectNpub(privKey, 1n);
  assert(offsetNpub === directNpub, `d=1 mismatch: offset=${offsetNpub} direct=${directNpub}`);
});

test("d=42: P + 42·G matches (k+42)·G directly", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const offsetNpub = computeOffsetNpub(xOnly, 42n);
  const directNpub = computeDirectNpub(privKey, 42n);
  assert(offsetNpub === directNpub, `d=42 mismatch: offset=${offsetNpub} direct=${directNpub}`);
});

test("d=1000: P + 1000·G matches (k+1000)·G directly", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const offsetNpub = computeOffsetNpub(xOnly, 1000n);
  const directNpub = computeDirectNpub(privKey, 1000n);
  assert(offsetNpub === directNpub, `d=1000 mismatch: offset=${offsetNpub} direct=${directNpub}`);
});

test("d=999999: P + 999999·G matches (k+999999)·G directly", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const offsetNpub = computeOffsetNpub(xOnly, 999999n);
  const directNpub = computeDirectNpub(privKey, 999999n);
  assert(offsetNpub === directNpub, `d=999999 mismatch: offset=${offsetNpub} direct=${directNpub}`);
});

test("wrap-around: (k + d) mod n still produces P + d·G", () => {
  // Choose k close to n so that k + d wraps around
  const k = CURVE_N - 5n;
  const privKey = utils.numberToBytesBE(k, 32);
  const xOnly = getXOnlyPubkey(privKey);
  const d = 10n;
  // (k + d) mod n = 5
  const offsetNpub = computeOffsetNpub(xOnly, d);
  const directNpub = computeDirectNpub(privKey, d);
  assert(offsetNpub === directNpub, `wrap-around mismatch: offset=${offsetNpub} direct=${directNpub}`);
});

test("incremental point addition matches one-shot multiplication", () => {
  // Verify that P + d·G computed incrementally (adding G d times) matches
  // one-shot computation (G.multiply(d) then add)
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const d = 50n;

  // One-shot
  const oneShotNpub = computeOffsetNpub(xOnly, d);

  // Incremental: start at P, add G d times
  const compressedEven = new Uint8Array(33);
  compressedEven[0] = 0x02;
  compressedEven.set(xOnly, 1);
  let P: typeof Point.BASE;
  try {
    P = Point.fromHex(bytesToHex(compressedEven));
  } catch {
    const compressedOdd = new Uint8Array(33);
    compressedOdd[0] = 0x03;
    compressedOdd.set(xOnly, 1);
    P = Point.fromHex(bytesToHex(compressedOdd));
  }

  let current = P;
  for (let i = 0n; i < d; i++) {
    current = current.add(Point.BASE);
  }
  const incrementalXOnly = current.toAffine().slice(0, 32);
  const incrementalNpub = xOnlyToNpub(incrementalXOnly);

  assert(oneShotNpub === incrementalNpub, `incremental mismatch: oneShot=${oneShotNpub} incremental=${incrementalNpub}`);
});

test("multiple random keypairs: P + d·G always matches (k+d)·G", () => {
  for (let i = 0; i < 5; i++) {
    const privKey = utils.randomPrivateKey();
    const xOnly = getXOnlyPubkey(privKey);
    const d = BigInt(Math.floor(Math.random() * 100000) + 1);
    const offsetNpub = computeOffsetNpub(xOnly, d);
    const directNpub = computeDirectNpub(privKey, d);
    assert(offsetNpub === directNpub, `random test ${i}: offset=${offsetNpub} direct=${directNpub}`);
  }
});

test("large d near curve order: P + (n-1)·G matches (k+n-1)·G", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const d = CURVE_N - 1n;
  const offsetNpub = computeOffsetNpub(xOnly, d);
  const directNpub = computeDirectNpub(privKey, d);
  assert(offsetNpub === directNpub, `large d mismatch: offset=${offsetNpub} direct=${directNpub}`);
});

test("cross-reference: offset grinding with different starting keys produces different NPUBs", () => {
  const privKey1 = utils.randomPrivateKey();
  const privKey2 = utils.randomPrivateKey();
  const xOnly1 = getXOnlyPubkey(privKey1);
  const xOnly2 = getXOnlyPubkey(privKey2);
  const d = 100n;
  const npub1 = computeOffsetNpub(xOnly1, d);
  const npub2 = computeOffsetNpub(xOnly2, d);
  assert(npub1 !== npub2, `Different keys with same d should produce different npubs: ${npub1} vs ${npub2}`);
});

test("same key + same d produces same NPUB (deterministic)", () => {
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const d = 777n;
  const npub1 = computeOffsetNpub(xOnly, d);
  const npub2 = computeOffsetNpub(xOnly, d);
  assert(npub1 === npub2, `Same key+d should be deterministic: ${npub1} vs ${npub2}`);
});

test("d=n (curve order): P + n·G = P (identity)", () => {
  // n·G = point at infinity, so P + n·G = P
  const privKey = utils.randomPrivateKey();
  const xOnly = getXOnlyPubkey(privKey);
  const originalNpub = xOnlyToNpub(xOnly);
  const offsetNpub = computeOffsetNpub(xOnly, CURVE_N);
  assert(offsetNpub === originalNpub, `d=n should return original: ${offsetNpub} vs ${originalNpub}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const f of failures) {
    console.log(`    • ${f}`);
  }
}
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
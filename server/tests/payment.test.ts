/**
 * Unit tests for payment module: pricing calculation and atomic swap hash commitment.
 *
 * Tests:
 *  - Free threshold patterns return price 0
 *  - Long patterns calculate correct price
 *  - Entropy scan multiplier applied correctly
 *  - Price clamped to min/max
 *  - Hash commitment: SHA256(d) computed correctly
 *  - Preimage verification: valid and invalid cases
 *  - Atomic swap offer construction
 *  - HTLC request structure
 *
 * Per Phase 8.1 of IMPLEMENTATION-PLAN.md.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  calculateDifficultyBits,
  isFreePattern,
  calculatePrice,
  DEFAULT_PRICING,
  pricingConfigFromServer,
  type PricingConfig,
} from "../src/payment/pricing.ts";

import {
  computeHashCommitment,
  verifyPreimage,
  buildAtomicSwapOffer,
  bigintTo32Bytes,
  hexToBigint,
  type AtomicSwapOffer,
} from "../src/payment/atomic-swap.ts";

import { CashuPayment, createCashuPayment, sha256Hex, type HtlcRequest } from "../src/payment/cashu.ts";

import { LightningPayment, createLightningPayment } from "../src/payment/lightning.ts";

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

function approxEqual(a: number, b: number, tol: number = 1e-9): boolean {
  return Math.abs(a - b) < tol;
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

// ─── Pricing tests ─────────────────────────────────────────────────────────

await test("calculateDifficultyBits: pattern length * 5", () => {
  assert(calculateDifficultyBits("a") === 5, "1 char = 5 bits");
  assert(calculateDifficultyBits("ab") === 10, "2 chars = 10 bits");
  assert(calculateDifficultyBits("mesh") === 20, "4 chars = 20 bits");
  assert(calculateDifficultyBits("meshmate") === 40, "8 chars = 40 bits");
  assert(calculateDifficultyBits("") === 0, "0 chars = 0 bits");
});

await test("isFreePattern: patterns at or below free threshold are free", () => {
  // Default freeThresholdBits = 20 → 4 chars is exactly 20 bits → free
  assert(isFreePattern("mesh") === true, "4 chars (20 bits) should be free");
  assert(isFreePattern("abc") === true, "3 chars (15 bits) should be free");
  assert(isFreePattern("a") === true, "1 char (5 bits) should be free");
  assert(isFreePattern("") === true, "0 chars (0 bits) should be free");
});

await test("isFreePattern: patterns above free threshold are not free", () => {
  // 5 chars = 25 bits > 20 → not free
  assert(isFreePattern("meshm") === false, "5 chars (25 bits) should not be free");
  assert(isFreePattern("meshmate") === false, "8 chars (40 bits) should not be free");
});

await test("calculatePrice: free patterns return 0", () => {
  assert(calculatePrice("mesh") === 0, "4 chars should be free");
  assert(calculatePrice("abc") === 0, "3 chars should be free");
  assert(calculatePrice("a") === 0, "1 char should be free");
  assert(calculatePrice("") === 0, "0 chars should be free");
});

await test("calculatePrice: above-threshold pattern without entropy scan", () => {
  // 5 chars = 25 bits, free threshold = 20
  // baseSats = (25 - 20) * 1 = 5
  // No entropy scan → 5 sats, but min is 21 → clamp to 21
  const price = calculatePrice("meshm", false);
  assert(price === 21, `Expected 21 (min price), got ${price}`);
});

await test("calculatePrice: longer pattern without entropy scan", () => {
  // 8 chars = 40 bits, free threshold = 20
  // baseSats = (40 - 20) * 1 = 20
  // No entropy scan → 20 sats, but min is 21 → clamp to 21
  const price = calculatePrice("meshmate", false);
  assert(price === 21, `Expected 21 (min price), got ${price}`);
});

await test("calculatePrice: very long pattern hits max cap", () => {
  // 2001 chars = 10005 bits, free threshold = 20
  // baseSats = (10005 - 20) * 1 = 9985
  // No entropy scan → 9985 sats (below max 10000)
  const longPattern = "a".repeat(2001);
  const price = calculatePrice(longPattern, false);
  assert(price === 9985, `Expected 9985, got ${price}`);
});

await test("calculatePrice: very long pattern with entropy hits max cap", () => {
  // 2001 chars = 10005 bits, free threshold = 20
  // baseSats = (10005 - 20) * 1 = 9985
  // With entropy: 9985 * 1.5 = 14977.5 → round to 14978
  // Clamped to max 10000
  const longPattern = "a".repeat(2001);
  const price = calculatePrice(longPattern, true);
  assert(price === 10000, `Expected 10000 (max cap), got ${price}`);
});

await test("calculatePrice: entropy scan multiplier applied", () => {
  // Use a custom config where the result is above min and below max
  const customConfig: PricingConfig = {
    freeThresholdBits: 10,
    satsPerBit: 10,
    entropyScanMultiplier: 2.0,
    minPriceSats: 0,
    maxPriceSats: 100000,
  };
  // 5 chars = 25 bits, free threshold = 10
  // baseSats = (25 - 10) * 10 = 150
  // Without entropy: 150
  // With entropy: 150 * 2.0 = 300
  const priceNoEntropy = calculatePrice("meshm", false, customConfig);
  const priceWithEntropy = calculatePrice("meshm", true, customConfig);
  assert(priceNoEntropy === 150, `Expected 150, got ${priceNoEntropy}`);
  assert(priceWithEntropy === 300, `Expected 300, got ${priceWithEntropy}`);
});

await test("calculatePrice: custom config with different free threshold", () => {
  const customConfig: PricingConfig = {
    freeThresholdBits: 30,
    satsPerBit: 1,
    entropyScanMultiplier: 1.5,
    minPriceSats: 21,
    maxPriceSats: 10000,
  };
  // 6 chars = 30 bits → exactly at threshold → free
  assert(calculatePrice("meshma", false, customConfig) === 0, "6 chars at threshold should be free");
  // 7 chars = 35 bits → (35-30)*1 = 5 → clamped to min 21
  assert(calculatePrice("meshmat", false, customConfig) === 21, "7 chars should be min price 21");
});

await test("pricingConfigFromServer: merges server config with defaults", () => {
  const config = pricingConfigFromServer({ freeThreshold: 15, satsPerBit: 5 });
  assert(config.freeThresholdBits === 15, "freeThresholdBits should be 15");
  assert(config.satsPerBit === 5, "satsPerBit should be 5");
  assert(config.entropyScanMultiplier === DEFAULT_PRICING.entropyScanMultiplier, "Should use default entropy multiplier");
  assert(config.minPriceSats === DEFAULT_PRICING.minPriceSats, "Should use default min price");
  assert(config.maxPriceSats === DEFAULT_PRICING.maxPriceSats, "Should use default max price");
});

// ─── Atomic swap hash commitment tests ─────────────────────────────────────

await test("computeHashCommitment: SHA256 of offset d=1", () => {
  const commitment = computeHashCommitment(1n);
  // Manually compute SHA256 of 32-byte big-endian 1
  const expectedBytes = new Uint8Array(32);
  expectedBytes[31] = 1;
  const expectedHash = bytesToHex(sha256(expectedBytes));
  assert(commitment === expectedHash, `Expected ${expectedHash}, got ${commitment}`);
  assert(commitment.length === 64, "Hash should be 64 hex chars");
});

await test("computeHashCommitment: SHA256 of offset d=42", () => {
  const commitment = computeHashCommitment(42n);
  const expectedBytes = new Uint8Array(32);
  expectedBytes[31] = 42;
  const expectedHash = bytesToHex(sha256(expectedBytes));
  assert(commitment === expectedHash, `Expected ${expectedHash}, got ${commitment}`);
});

await test("computeHashCommitment: large offset d=2^128", () => {
  const d = 1n << 128n;
  const commitment = computeHashCommitment(d);
  const expectedBytes = bigintTo32Bytes(d);
  const expectedHash = bytesToHex(sha256(expectedBytes));
  assert(commitment === expectedHash, `Expected ${expectedHash}, got ${commitment}`);
});

await test("verifyPreimage: valid preimage returns true", () => {
  const d = 12345n;
  const commitment = computeHashCommitment(d);
  const result = verifyPreimage(d, commitment);
  assert(result.valid === true, "Valid preimage should verify");
  assert(result.expectedHash === commitment, "Expected hash should match commitment");
  assert(result.computedHash === commitment, "Computed hash should match commitment");
});

await test("verifyPreimage: invalid preimage returns false", () => {
  const d = 12345n;
  const commitment = computeHashCommitment(d);
  const wrongResult = verifyPreimage(99999n, commitment);
  assert(wrongResult.valid === false, "Wrong preimage should not verify");
  assert(wrongResult.expectedHash === commitment, "Expected hash should still be the commitment");
  assert(wrongResult.computedHash !== commitment, "Computed hash should differ");
});

await test("verifyPreimage: case-insensitive comparison", () => {
  const d = 42n;
  const commitment = computeHashCommitment(d);
  const upperCommitment = commitment.toUpperCase();
  const result = verifyPreimage(d, upperCommitment);
  assert(result.valid === true, "Should be case-insensitive");
});

await test("buildAtomicSwapOffer: correct structure with Cashu mint", () => {
  const d = 777n;
  const targetNpub = "npub1testvanityexample1234567890";
  const priceSats = 210;
  const mintUrl = "https://mint.minibits.cash";

  const offer = buildAtomicSwapOffer(d, targetNpub, priceSats, mintUrl);

  assert(offer.targetNpub === targetNpub, "Target NPUB should match");
  assert(offer.priceSats === priceSats, "Price should match");
  assert(offer.cashuMintUrl === mintUrl, "Mint URL should match");
  assert(offer.hashCommitment === computeHashCommitment(d), "Hash commitment should match");
  assert(offer.expiryMs > Date.now(), "Expiry should be in the future");
  assert(offer.htlcRequest !== undefined, "Should have HTLC request");
  assert(offer.htlcRequest!.type === "htlc", "HTLC type should be 'htlc'");
  assert(offer.htlcRequest!.mint === mintUrl, "HTLC mint should match");
  assert(offer.htlcRequest!.amount === priceSats, "HTLC amount should match");
  assert(offer.htlcRequest!.hashLock === offer.hashCommitment, "HTLC hashLock should match commitment");
  assert(offer.htlcRequest!.description.includes("preimage"), "HTLC description should mention preimage");
});

await test("buildAtomicSwapOffer: no Cashu mint → no HTLC request", () => {
  const d = 42n;
  const offer = buildAtomicSwapOffer(d, "npub1test", 100, null);
  assert(offer.cashuMintUrl === null, "Mint URL should be null");
  assert(offer.htlcRequest === undefined, "Should not have HTLC request when no mint");
});

await test("buildAtomicSwapOffer: custom expiry", () => {
  const d = 42n;
  const customExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24h
  const offer = buildAtomicSwapOffer(d, "npub1test", 100, null, customExpiry);
  assert(offer.expiryMs === customExpiry, "Custom expiry should be used");
});

await test("bigintTo32Bytes: zero", () => {
  const bytes = bigintTo32Bytes(0n);
  assert(bytes.length === 32, "Should be 32 bytes");
  assert(bytes.every((b) => b === 0), "All bytes should be zero");
});

await test("bigintTo32Bytes: one", () => {
  const bytes = bigintTo32Bytes(1n);
  assert(bytes.length === 32, "Should be 32 bytes");
  assert(bytes[31] === 1, "Last byte should be 1");
  assert(bytes.slice(0, 31).every((b) => b === 0), "First 31 bytes should be zero");
});

await test("bigintTo32Bytes: large value", () => {
  const val = (1n << 255n) | 1n;
  const bytes = bigintTo32Bytes(val);
  assert(bytes.length === 32, "Should be 32 bytes");
  assert(bytes[0] & 0x80, "Top bit should be set");
  assert(bytes[31] === 1, "Last byte should be 1");
});

await test("hexToBigint: roundtrip with bigintTo32Bytes", () => {
  const val = 123456789n;
  const bytes = bigintTo32Bytes(val);
  const hex = bytesToHex(bytes);
  const recovered = hexToBigint(hex);
  assert(recovered === val, `Roundtrip failed: ${recovered} vs ${val}`);
});

await test("hexToBigint: with 0x prefix", () => {
  const val = hexToBigint("0xff");
  assert(val === 255n, `Expected 255n, got ${val}`);
});

await test("hexToBigint: without 0x prefix", () => {
  const val = hexToBigint("ff");
  assert(val === 255n, `Expected 255n, got ${val}`);
});

// ─── Cashu payment tests ───────────────────────────────────────────────────

await test("CashuPayment: createHtlcRequest returns correct structure", () => {
  const cashu = createCashuPayment("https://mint.minibits.cash");
  const hashLock = computeHashCommitment(42n);
  const htlc = cashu.createHtlcRequest(hashLock, 210);

  assert(htlc.type === "htlc", "Type should be 'htlc'");
  assert(htlc.mint === "https://mint.minibits.cash", "Mint URL should match");
  assert(htlc.amount === 210, "Amount should be 210");
  assert(htlc.hashLock === hashLock, "HashLock should match");
  assert(htlc.description.includes("preimage"), "Description should mention preimage");
});

await test("CashuPayment: mintUrl getter", () => {
  const cashu = createCashuPayment("https://mint.example.com");
  assert(cashu.mintUrl === "https://mint.example.com", "Mint URL should match");
});

await test("CashuPayment: receiveToken fails gracefully without @cashu/cashu-ts", async () => {
  const cashu = createCashuPayment("https://mint.minibits.cash");
  // @cashu/cashu-ts is not installed in this environment
  const result = await cashu.receiveToken("cashuAfake_token");
  assert(result.success === false, "Should fail without cashu-ts");
  assert(result.error !== undefined, "Should have error message");
  assert(result.error!.includes("not installed") || result.error!.includes("failed"), "Error should mention not installed");
});

await test("sha256Hex: known value", () => {
  // SHA256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  const hash = sha256Hex("hello");
  assert(hash === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", `Expected known SHA256, got ${hash}`);
});

// ─── Lightning payment tests ───────────────────────────────────────────────

await test("LightningPayment: not available when backend is 'none'", () => {
  const ln = createLightningPayment("none");
  assert(ln.available === false, "Should not be available with 'none' backend");
});

await test("LightningPayment: createInvoice throws when backend is 'none'", async () => {
  const ln = createLightningPayment("none");
  let threw = false;
  try {
    await ln.createInvoice(100, "test");
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("not configured"), "Error should mention not configured");
  }
  assert(threw, "createInvoice should throw with 'none' backend");
});

await test("LightningPayment: checkPayment throws when backend is 'none'", async () => {
  const ln = createLightningPayment("none");
  let threw = false;
  try {
    await ln.checkPayment("lnbc1fake");
  } catch (e) {
    threw = true;
  }
  assert(threw, "checkPayment should throw with 'none' backend");
});

await test("LightningPayment: available when backend is 'lnd'", () => {
  const ln = createLightningPayment("lnd", "https://lnd.example.com:8080");
  assert(ln.available === true, "Should be available with 'lnd' backend");
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
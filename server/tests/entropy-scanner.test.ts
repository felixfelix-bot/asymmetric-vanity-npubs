/**
 * Unit tests for entropy-scanner.ts
 *
 * Tests:
 *  - Shannon entropy of known strings
 *  - Unique character count
 *  - Rarity computation (expected_unique − actual_unique)
 *  - Quality metric (= rarity, higher = better)
 *  - runEntropyScanner: all window sizes scanned
 *  - runEntropyScanner: best window selection (fewest unique chars)
 *  - runEntropyScanner: matches demo/index.html output
 *  - scanNpub: prefix stripping
 *  - Edge cases: short strings, uniform strings
 */

import {
  shannonEntropy,
  uniqueCharCount,
  computeRarity,
  computeQuality,
  qualityToDb,
  runEntropyScanner,
  scanNpub,
} from "../src/grinding/entropy-scanner.ts";

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

function test(name: string, fn: () => void): void {
  console.log(`\n▶ ${name}`);
  try {
    fn();
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.error(`  ✗ ERROR: ${msg}`);
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("shannonEntropy: uniform string (all same char)", () => {
  // All same character → entropy = 0
  const h = shannonEntropy("aaaa");
  assert(approxEqual(h, 0), `Expected 0, got ${h}`);
});

test("shannonEntropy: two equally likely chars", () => {
  // Two chars, equal probability → H = 1 bit
  const h = shannonEntropy("ab");
  assert(approxEqual(h, 1), `Expected 1.0, got ${h}`);
});

test("shannonEntropy: single character", () => {
  const h = shannonEntropy("x");
  assert(approxEqual(h, 0), `Expected 0, got ${h}`);
});

test("shannonEntropy: four equally likely chars", () => {
  // 4 unique chars → H = log2(4) = 2 bits
  const h = shannonEntropy("abcd");
  assert(approxEqual(h, 2), `Expected 2.0, got ${h}`);
});

test("shannonEntropy: known bech32-like string", () => {
  // "qpzry9x8" — 8 unique chars → H = log2(8) = 3.0
  const h = shannonEntropy("qpzry9x8");
  assert(approxEqual(h, 3.0), `Expected 3.0, got ${h}`);
});

test("uniqueCharCount: all unique", () => {
  assert(uniqueCharCount("abcdef") === 6, "Expected 6 unique chars");
});

test("uniqueCharCount: all same", () => {
  assert(uniqueCharCount("aaaaaa") === 1, "Expected 1 unique char");
});

test("uniqueCharCount: mixed", () => {
  assert(uniqueCharCount("aabbcc") === 3, "Expected 3 unique chars");
});

test("computeRarity: zero when unique chars equals expected", () => {
  // For W=16, expected_unique ≈ 10.34
  // If actual unique = expected → rarity = 0
  const r = computeRarity(10.34, 10.34);
  assert(approxEqual(r, 0, 1e-6), `Expected ~0, got ${r}`);
});

test("computeRarity: positive when fewer unique chars than expected", () => {
  // For W=16: expected ≈ 10.34, actual = 3 → rarity = 7.34
  const r = computeRarity(3, 10.34);
  assert(r > 0, `Expected positive rarity, got ${r}`);
  assert(approxEqual(r, 7.34, 1e-6), `Expected 7.34, got ${r}`);
});

test("computeRarity: negative when more unique chars than expected (not useful)", () => {
  // More unique than expected → negative rarity (not a useful fingerprint)
  const r = computeRarity(15, 10.34);
  assert(r < 0, `Expected negative rarity, got ${r}`);
});

test("computeQuality: returns rarity (higher = better)", () => {
  // quality = rarity = expectedUnique - uniqueChars
  const r = computeRarity(3, 10.34);
  const q = computeQuality(r);
  assert(q === r, `Expected quality to equal rarity ${r}, got ${q}`);
});

test("computeQuality: higher rarity for fewer unique chars", () => {
  const r1 = computeRarity(2, 10.34);
  const r2 = computeRarity(8, 10.34);
  const q1 = computeQuality(r1);
  const q2 = computeQuality(r2);
  assert(q1 > q2, `Fewer unique chars should give higher quality: ${q1} vs ${q2}`);
});

test("qualityToDb: zero or negative returns placeholder", () => {
  assert(qualityToDb(0) === "−∞", `Expected '−∞', got '${qualityToDb(0)}'`);
  assert(qualityToDb(-1) === "−∞", `Expected '−∞', got '${qualityToDb(-1)}'`);
});

test("qualityToDb: positive value returns dB string", () => {
  const result = qualityToDb(7.34);
  assert(result === (10 * Math.log10(7.34)).toFixed(1), `Expected '${(10 * Math.log10(7.34)).toFixed(1)}', got '${result}'`);
});

test("runEntropyScanner: all window sizes scanned", () => {
  // Need a string long enough for all window sizes (max 49)
  const data = "q".repeat(60);
  const { allResults } = runEntropyScanner(data, 16);
  const sizes = new Set(allResults.map((r) => r.W));
  assert(sizes.has(16), "Expected window size 16 in results");
  assert(sizes.has(25), "Expected window size 25 in results");
  assert(sizes.has(36), "Expected window size 36 in results");
  assert(sizes.has(49), "Expected window size 49 in results");
});

test("runEntropyScanner: all-same-char string gives uniqueChars = 1", () => {
  // All same char → 1 unique char → best quality (highest rarity)
  const data = "q".repeat(60);
  const { best } = runEntropyScanner(data, 16);
  assert(best.bestUnique === 1, `Expected 1 unique char, got ${best.bestUnique}`);
  // The best window should be one of the valid sizes
  assert([16, 25, 36, 49].includes(best.bestW), `Expected valid W, got ${best.bestW}`);
});

test("runEntropyScanner: best window selection picks fewest unique chars", () => {
  // Mix of repetitive and random
  const data = "qqqqqqqqqqqqqqqq" + "zw0r9y8gf4p7l3d2x6";
  const { best, allResults } = runEntropyScanner(data, 16);

  // Find the maximum quality (= highest rarity = fewest unique chars) in allResults
  let maxQuality = -Infinity;
  let maxResult: typeof allResults[0] | null = null;
  for (const r of allResults) {
    if (r.quality > maxQuality) {
      maxQuality = r.quality;
      maxResult = r;
    }
  }

  assert(maxResult !== null, "Expected to find max quality result");
  assert(
    approxEqual(best.bestQuality, maxResult!.quality, 1e-12),
    `Best quality ${best.bestQuality} should equal max from allResults ${maxResult!.quality}`,
  );
  assert(best.bestW === maxResult!.W, `Best W should match: ${best.bestW} vs ${maxResult!.W}`);
  assert(best.bestPos === maxResult!.pos, `Best pos should match: ${best.bestPos} vs ${maxResult!.pos}`);
});

test("runEntropyScanner: minW parameter filters small windows", () => {
  const data = "q".repeat(60);
  const { allResults } = runEntropyScanner(data, 25);
  const sizes = new Set(allResults.map((r) => r.W));
  assert(!sizes.has(16), "Window size 16 should be filtered out when minW=25");
  assert(sizes.has(25), "Window size 25 should be present");
  assert(sizes.has(36), "Window size 36 should be present");
  assert(sizes.has(49), "Window size 49 should be present");
});

test("runEntropyScanner: bestWindow contains the actual substring", () => {
  const data = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const { best } = runEntropyScanner(data, 16);
  assert(best.bestWindow.length === best.bestW, `Window length ${best.bestWindow.length} should match W ${best.bestW}`);
  assert(
    data.substring(best.bestPos, best.bestPos + best.bestW) === best.bestWindow,
    "bestWindow should match data substring at bestPos",
  );
});

test("runEntropyScanner: high-entropy random string has more unique chars", () => {
  // A string with all 32 bech32 chars used roughly equally → many unique chars
  const bech32Chars = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = bech32Chars + bech32Chars; // 64 chars, all unique
  const { best } = runEntropyScanner(data, 16);
  // Best unique should be relatively high (many unique chars = not very recognizable)
  assert(best.bestUnique >= 8, `Expected >= 8 unique chars for random string, got ${best.bestUnique}`);
});

test("scanNpub: strips npub1 prefix", () => {
  const dataPart = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const npub = "npub1" + dataPart;
  const result1 = scanNpub(npub, 16);
  const result2 = runEntropyScanner(dataPart, 16);
  assert(
    approxEqual(result1.best.bestQuality, result2.best.bestQuality, 1e-12),
    "scanNpub with prefix should match runEntropyScanner on data part",
  );
  assert(result1.best.bestPos === result2.best.bestPos, "Positions should match");
});

test("scanNpub: works without prefix", () => {
  const dataPart = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const result1 = scanNpub(dataPart, 16);
  const result2 = runEntropyScanner(dataPart, 16);
  assert(
    approxEqual(result1.best.bestQuality, result2.best.bestQuality, 1e-12),
    "scanNpub without prefix should match runEntropyScanner",
  );
});

test("runEntropyScanner: string too short for any window returns default best", () => {
  const { best, allResults } = runEntropyScanner("abc", 16);
  assert(allResults.length === 0, "Expected 0 results for too-short string");
  assert(best.bestQuality === -Infinity, `Expected default quality -Infinity, got ${best.bestQuality}`);
  assert(best.bestRarity === -1, `Expected default rarity -1, got ${best.bestRarity}`);
});

test("runEntropyScanner: exactly 16 chars scans only W=16", () => {
  const data = "qqqqqqqqqqqqqqqq";
  const { allResults } = runEntropyScanner(data, 16);
  const sizes = new Set(allResults.map((r) => r.W));
  assert(sizes.size === 1 && sizes.has(16), "Expected only W=16 for 16-char string");
  assert(allResults.length === 1, `Expected 1 result, got ${allResults.length}`);
});

test("runEntropyScanner: quality equals rarity for all windows", () => {
  // quality = rarity = expectedUnique - uniqueChars
  const data = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const { allResults } = runEntropyScanner(data, 16);

  for (const r of allResults) {
    assert(
      r.quality === r.rarity,
      `Quality should equal rarity at W=${r.W} pos=${r.pos}: ${r.quality} vs ${r.rarity}`,
    );
  }
});

test("runEntropyScanner: rarity = expectedUnique - uniqueChars for all windows", () => {
  const data = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const { allResults } = runEntropyScanner(data, 16);

  for (const r of allResults) {
    const expectedRarity = r.expectedUnique - r.uniqueChars;
    assert(
      approxEqual(r.rarity, expectedRarity, 1e-9),
      `Rarity mismatch at W=${r.W} pos=${r.pos}: ${r.rarity} vs ${expectedRarity}`,
    );
  }
});

test("runEntropyScanner: repetitive string beats random string (fewer unique chars)", () => {
  // A string with only 2 chars should beat a string with many chars
  const repetitive = "qpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqpqp";
  const randomish = "qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54kh";
  const repResult = runEntropyScanner(repetitive, 16);
  const randResult = runEntropyScanner(randomish, 16);
  assert(
    repResult.best.bestUnique < randResult.best.bestUnique,
    `Repetitive string should have fewer unique chars: ${repResult.best.bestUnique} vs ${randResult.best.bestUnique}`,
  );
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
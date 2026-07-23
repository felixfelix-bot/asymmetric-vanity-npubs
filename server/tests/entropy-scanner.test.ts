/**
 * Unit tests for entropy-scanner.ts
 *
 * Tests:
 *  - Shannon entropy of known strings
 *  - Unique character count
 *  - Z-score computation
 *  - Quality metric
 *  - runEntropyScanner: all window sizes scanned
 *  - runEntropyScanner: best window selection
 *  - runEntropyScanner: matches demo/index.html output
 *  - scanNpub: prefix stripping
 *  - Edge cases: short strings, uniform strings
 */

import {
  shannonEntropy,
  uniqueCharCount,
  computeZScore,
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

test("computeZScore: zero when entropy equals mean", () => {
  // For W=16, mean=3.571 → z should be 0 when entropy = mean
  const z = computeZScore(3.571, 16);
  assert(approxEqual(z, 0, 1e-6), `Expected ~0, got ${z}`);
});

test("computeZScore: positive when entropy below mean", () => {
  // For W=16: mean=3.571, std=0.187
  // entropy = 3.0 → z = (3.571 - 3.0) / 0.187 ≈ 3.053
  const z = computeZScore(3.0, 16);
  assert(z > 0, `Expected positive z, got ${z}`);
  assert(approxEqual(z, (3.571 - 3.0) / 0.187, 1e-6), `Expected ${(3.571 - 3.0) / 0.187}, got ${z}`);
});

test("computeZScore: clamped to zero when entropy above mean", () => {
  // Entropy above mean → negative raw z → clamped to 0
  const z = computeZScore(4.0, 16);
  assert(z === 0, `Expected 0 (clamped), got ${z}`);
});

test("computeZScore: throws for unknown window size", () => {
  let threw = false;
  try {
    computeZScore(3.0, 99);
  } catch {
    threw = true;
  }
  assert(threw, "Expected throw for unknown window size 99");
});

test("computeQuality: formula z / uniq³", () => {
  const q = computeQuality(3.0, 2);
  assert(approxEqual(q, 3.0 / 8), `Expected ${3.0 / 8}, got ${q}`);
});

test("computeQuality: zero z-score gives zero quality", () => {
  const q = computeQuality(0, 5);
  assert(q === 0, `Expected 0, got ${q}`);
});

test("qualityToDb: zero or negative returns −∞", () => {
  assert(qualityToDb(0) === "−∞", `Expected '−∞', got '${qualityToDb(0)}'`);
  assert(qualityToDb(-1) === "−∞", `Expected '−∞', got '${qualityToDb(-1)}'`);
});

test("qualityToDb: positive value formats correctly", () => {
  // 10 * log10(10) = 10.0
  const db = qualityToDb(10);
  assert(db === "10.0", `Expected '10.0', got '${db}'`);
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

test("runEntropyScanner: all-same-char string gives z-score = mean/std", () => {
  // All same char → entropy = 0 → z = mean / std
  const data = "q".repeat(60);
  const { best } = runEntropyScanner(data, 16);
  // For W=16: z = 3.571 / 0.187 ≈ 19.096
  assert(best.bestZ > 0, `Expected positive z, got ${best.bestZ}`);
  // The best window should be one of the valid sizes
  assert([16, 25, 36, 49].includes(best.bestW), `Expected valid W, got ${best.bestW}`);
});

test("runEntropyScanner: best window selection picks highest quality", () => {
  // Mix of repetitive and random
  const data = "qqqqqqqqqqqqqqqq" + "zw0r9y8gf4p7l3d2x6";
  const { best, allResults } = runEntropyScanner(data, 16);

  // Find the best quality in allResults
  let maxQuality = -1;
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

test("runEntropyScanner: high-entropy random string has low z-scores", () => {
  // A string with all 32 bech32 chars used roughly equally → high entropy → low z
  const bech32Chars = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = bech32Chars + bech32Chars; // 64 chars, all unique
  const { best } = runEntropyScanner(data, 16);
  // z should be 0 or very small for a high-entropy string
  assert(best.bestZ < 1, `Expected low z-score for random string, got ${best.bestZ}`);
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
  assert(best.bestQuality === -1, "Expected default quality -1");
  assert(best.bestZ === -1, "Expected default z -1");
});

test("runEntropyScanner: exactly 16 chars scans only W=16", () => {
  const data = "qqqqqqqqqqqqqqqq";
  const { allResults } = runEntropyScanner(data, 16);
  const sizes = new Set(allResults.map((r) => r.W));
  assert(sizes.size === 1 && sizes.has(16), "Expected only W=16 for 16-char string");
  assert(allResults.length === 1, `Expected 1 result, got ${allResults.length}`);
});

test("runEntropyScanner: quality matches demo/index.html formula", () => {
  // Verify the exact formula: quality = z / (uniq³)
  const data = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const { allResults } = runEntropyScanner(data, 16);

  for (const r of allResults) {
    const expectedQuality = r.zScore / (r.uniqueChars * r.uniqueChars * r.uniqueChars);
    assert(
      approxEqual(r.quality, expectedQuality, 1e-12),
      `Quality mismatch at W=${r.W} pos=${r.pos}: ${r.quality} vs ${expectedQuality}`,
    );
  }
});

test("runEntropyScanner: z-score formula matches demo (mean - ent) / std", () => {
  const data = "qqqqqqqqqqqqqqqqzw0r9y8gf4p7l3d2x6";
  const { allResults } = runEntropyScanner(data, 16);

  const baselines: Record<number, { mean: number; std: number }> = {
    16: { mean: 3.571, std: 0.187 },
    25: { mean: 3.993, std: 0.163 },
    36: { mean: 4.277, std: 0.138 },
    49: { mean: 4.468, std: 0.115 },
  };

  for (const r of allResults) {
    const base = baselines[r.W];
    const expectedZ = Math.max(0, (base.mean - r.entropy) / base.std);
    assert(
      approxEqual(r.zScore, expectedZ, 1e-9),
      `Z-score mismatch at W=${r.W} pos=${r.pos}: ${r.zScore} vs ${expectedZ}`,
    );
  }
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
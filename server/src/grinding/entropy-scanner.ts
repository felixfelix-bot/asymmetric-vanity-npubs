/**
 * Entropy Scanner — Multi-scale unique character count scan (ADR-003)
 *
 * Ported from demo/index.html to TypeScript.
 * Scans bech32 NPUB data for windows with unusually few distinct characters.
 * The window with the highest rarity (expected_unique − actual_unique) is
 * the best anti-phish fingerprint candidate ("raindrop" metric).
 *
 * For a window of W characters from a 32-char alphabet, the expected number
 * of distinct characters is:
 *   E[unique] = 32 × (1 - (31/32)^W)  (occupancy problem)
 *
 * For W=16: E[unique] ≈ 10.3
 * Lower unique count = more recognizable to humans = rarer = harder to forge.
 */

// Perfect squares only: 4×4, 5×5, 6×6, 7×7
const WINDOW_SIZES: readonly number[] = [16, 25, 36, 49];

// ─── Expected unique character counts ──────────────────────────────────────
// E[unique] = 32 × (1 - (31/32)^W)  — the classic occupancy problem
const EXPECTED_UNIQUE: Record<number, number> = {};
for (const W of WINDOW_SIZES) {
  EXPECTED_UNIQUE[W] = 32 * (1 - Math.pow(31 / 32, W));
}
// W=16 → ~10.34, W=25 → ~16.61, W=36 → ~20.65, W=49 → ~24.20

// ─── Types ────────────────────────────────────────────────────────────────

/** Result for a single window position. */
export interface WindowResult {
  /** Window size (16, 25, 36, or 49) */
  W: number;
  /** Start position of the window in the data string */
  pos: number;
  /** Shannon entropy of the window (bits) — informational */
  entropy: number;
  /** Number of unique bech32 characters in the window */
  uniqueChars: number;
  /** Expected unique chars for this window size (occupancy formula) */
  expectedUnique: number;
  /** Rarity score: expectedUnique - uniqueChars (higher = more recognizable) */
  rarity: number;
  /** Composite quality: equals rarity (higher = better fingerprint) */
  quality: number;
}

/** Best window found by the scanner. */
export interface ScanResult {
  /** Best rarity score across all windows */
  bestRarity: number;
  /** Best window size */
  bestW: number;
  /** Best window start position */
  bestPos: number;
  /** Shannon entropy of the best window (informational) */
  bestEntropy: number;
  /** Unique character count in the best window */
  bestUnique: number;
  /** Expected unique chars for the best window size */
  bestExpected: number;
  /** Composite quality score of the best window */
  bestQuality: number;
  /** The actual substring of the best window */
  bestWindow: string;
}

/** Full scan output including all window results and the best pick. */
export interface EntropyScanOutput {
  best: ScanResult;
  allResults: WindowResult[];
}

// ─── Core Functions ────────────────────────────────────────────────────────

/**
 * Compute Shannon entropy (in bits) of a string.
 *
 * H = -Σ p(c) · log₂(p(c))
 *
 * Kept for informational display; scoring is based on unique character count.
 *
 * @param str - Input string (bech32 characters)
 * @returns Shannon entropy in bits
 */
export function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const c of str) {
    freq[c] = (freq[c] || 0) + 1;
  }
  let h = 0;
  const n = str.length;
  for (const c in freq) {
    const p = freq[c] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Count the number of unique characters in a string.
 *
 * @param str - Input string
 * @returns Count of distinct characters
 */
export function uniqueCharCount(str: string): number {
  const seen: Record<string, boolean> = {};
  for (const c of str) {
    seen[c] = true;
  }
  return Object.keys(seen).length;
}

/**
 * Compute the expected number of unique characters for a window of size W
 * drawn from a 32-character alphabet (occupancy problem).
 *
 * E[unique] = 32 × (1 - (31/32)^W)
 *
 * @param windowSize - Window size
 * @returns Expected unique character count
 */
export function expectedUniqueChars(windowSize: number): number {
  return 32 * (1 - Math.pow(31 / 32, windowSize));
}

/**
 * Compute rarity score: how far below expectation the unique char count is.
 *
 * rarity = expectedUnique - uniqueChars
 *
 * A positive rarity means the window has fewer unique characters than expected
 * for a random string — making it more recognizable and rarer.
 *
 * @param uniqueChars - Actual unique character count
 * @param expectedUnique - Expected unique count for this window size
 * @returns Rarity score (higher = more recognizable = rarer)
 */
export function computeRarity(uniqueChars: number, expectedUnique: number): number {
  return expectedUnique - uniqueChars;
}

/**
 * Compute composite quality score.
 *
 * quality = rarity = expectedUnique - uniqueChars
 *
 * Fewer unique characters → more recognizable to humans → higher quality.
 *
 * @param rarity - Rarity score of the window
 * @returns Composite quality score (same as rarity for this simple metric)
 */
export function computeQuality(rarity: number): number {
  return rarity;
}

/**
 * Convert a quality score to decibels for display.
 *
 * @param q - Quality score
 * @returns Formatted dB string
 */
export function qualityToDb(q: number): string {
  if (q <= 0) return "−∞";
  return (10 * Math.log10(q)).toFixed(1);
}

// ─── Scanner ──────────────────────────────────────────────────────────────

/**
 * Run the multi-scale unique character scanner over a bech32 data string.
 *
 * Scans all window sizes ≥ minW, sliding across every valid position.
 * Returns the best window (highest rarity = fewest unique chars relative
 * to expectation) and all individual window results.
 *
 * @param dataStr - The bech32 data portion of an NPUB (without "npub1" prefix)
 * @param minW - Minimum window size to consider (default 16)
 * @returns Best window result and all window results
 */
export function runEntropyScanner(
  dataStr: string,
  minW: number = 16,
): EntropyScanOutput {
  let bestQuality = -Infinity;
  let best: ScanResult = {
    bestRarity: -1,
    bestW: 0,
    bestPos: 0,
    bestEntropy: 0,
    bestUnique: 0,
    bestExpected: 0,
    bestQuality: -Infinity,
    bestWindow: "",
  };

  const allResults: WindowResult[] = [];

  for (const W of WINDOW_SIZES) {
    if (W < minW) continue;
    const expected = EXPECTED_UNIQUE[W] ?? expectedUniqueChars(W);

    for (let pos = 0; pos <= dataStr.length - W; pos++) {
      const window = dataStr.substring(pos, pos + W);
      const ent = shannonEntropy(window);
      const uniq = uniqueCharCount(window);
      const rarity = expected - uniq;
      const quality = rarity;

      allResults.push({
        W,
        pos,
        entropy: ent,
        uniqueChars: uniq,
        expectedUnique: expected,
        rarity,
        quality,
      });

      if (quality > bestQuality) {
        bestQuality = quality;
        best = {
          bestRarity: rarity,
          bestW: W,
          bestPos: pos,
          bestEntropy: ent,
          bestUnique: uniq,
          bestExpected: expected,
          bestQuality: quality,
          bestWindow: window,
        };
      }
    }
  }

  return { best, allResults };
}

/**
 * Convenience: scan an NPUB string (with or without "npub1" prefix).
 *
 * @param npub - Full NPUB string (e.g. "npub1...") or just the data part
 * @param minW - Minimum window size (default 16)
 * @returns Entropy scan output
 */
export function scanNpub(npub: string, minW: number = 16): EntropyScanOutput {
  const dataStr = npub.startsWith("npub1")
    ? npub.substring(5)
    : npub;
  return runEntropyScanner(dataStr, minW);
}
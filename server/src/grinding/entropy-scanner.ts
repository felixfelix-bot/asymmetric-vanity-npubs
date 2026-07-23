/**
 * Entropy Scanner — Multi-scale z-score outlier scan (ADR-003/004)
 *
 * Ported from demo/index.html (lines 1012–1078) to TypeScript.
 * Scans bech32 NPUB data for Shannon entropy outliers across sliding windows
 * of sizes 16, 25, 36, 49 (perfect squares 4²–7²). The window with the highest
 * composite quality score (z-score / unique_chars³) is the best anti-phish
 * fingerprint candidate.
 */

// ─── Baseline statistics ──────────────────────────────────────────────────
// Pre-computed mean & std-dev of Shannon entropy for random bech32 strings
// at each window size (from Monte Carlo simulation in the demo).
const BASELINE: Record<number, { mean: number; std: number }> = {
  16: { mean: 3.571, std: 0.187 },
  25: { mean: 3.993, std: 0.163 },
  36: { mean: 4.277, std: 0.138 },
  49: { mean: 4.468, std: 0.115 },
};

// Perfect squares only: 4×4, 5×5, 6×6, 7×7
const WINDOW_SIZES: readonly number[] = [16, 25, 36, 49];

// ─── Types ────────────────────────────────────────────────────────────────

/** Result for a single window position. */
export interface WindowResult {
  /** Window size (16, 25, 36, or 49) */
  W: number;
  /** Start position of the window in the data string */
  pos: number;
  /** Shannon entropy of the window (bits) */
  entropy: number;
  /** Z-score: how far below the baseline mean this window's entropy is */
  zScore: number;
  /** Number of unique bech32 characters in the window */
  uniqueChars: number;
  /** Composite quality: zScore / uniqueChars³ (higher = better fingerprint) */
  quality: number;
}

/** Best window found by the scanner. */
export interface ScanResult {
  /** Best z-score across all windows */
  bestZ: number;
  /** Best window size */
  bestW: number;
  /** Best window start position */
  bestPos: number;
  /** Shannon entropy of the best window */
  bestEntropy: number;
  /** Unique character count in the best window */
  bestUnique: number;
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
 * Compute the z-score for a window's entropy relative to the baseline.
 *
 * z = max(0, (baseline.mean - entropy) / baseline.std)
 *
 * A higher z-score means the window has unusually low entropy (more repetitive),
 * making it a good anti-phish fingerprint candidate.
 *
 * @param entropy - Shannon entropy of the window
 * @param windowSize - Window size (must exist in BASELINE)
 * @returns Z-score (≥ 0)
 */
export function computeZScore(entropy: number, windowSize: number): number {
  const base = BASELINE[windowSize];
  if (!base) {
    throw new Error(`No baseline for window size ${windowSize}`);
  }
  return Math.max(0, (base.mean - entropy) / base.std);
}

/**
 * Compute composite quality score.
 *
 * quality = zScore / (uniqueChars³)
 *
 * Fewer unique characters → more recognizable to humans → higher quality.
 *
 * @param zScore - Z-score of the window
 * @param uniqueChars - Number of unique characters in the window
 * @returns Composite quality score
 */
export function computeQuality(zScore: number, uniqueChars: number): number {
  return zScore / (uniqueChars * uniqueChars * uniqueChars);
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
 * Run the multi-scale entropy scanner over a bech32 data string.
 *
 * Scans all window sizes ≥ minW, sliding across every valid position.
 * Returns the best window (highest composite quality) and all individual
 * window results.
 *
 * @param dataStr - The bech32 data portion of an NPUB (without "npub1" prefix)
 * @param minW - Minimum window size to consider (default 16)
 * @returns Best window result and all window results
 */
export function runEntropyScanner(
  dataStr: string,
  minW: number = 16,
): EntropyScanOutput {
  let bestQuality = -1;
  let best: ScanResult = {
    bestZ: -1,
    bestW: 0,
    bestPos: 0,
    bestEntropy: 0,
    bestUnique: 0,
    bestQuality: -1,
    bestWindow: "",
  };

  const allResults: WindowResult[] = [];

  for (const W of WINDOW_SIZES) {
    if (W < minW) continue;
    const base = BASELINE[W];
    if (!base) continue;

    for (let pos = 0; pos <= dataStr.length - W; pos++) {
      const window = dataStr.substring(pos, pos + W);
      const ent = shannonEntropy(window);
      const z = Math.max(0, (base.mean - ent) / base.std);
      const uniq = uniqueCharCount(window);
      const quality = z / (uniq * uniq * uniq);

      allResults.push({
        W,
        pos,
        entropy: ent,
        zScore: z,
        uniqueChars: uniq,
        quality,
      });

      if (quality > bestQuality) {
        bestQuality = quality;
        best = {
          bestZ: z,
          bestW: W,
          bestPos: pos,
          bestEntropy: ent,
          bestUnique: uniq,
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
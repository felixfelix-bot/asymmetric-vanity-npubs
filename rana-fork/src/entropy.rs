//! Shannon entropy helpers for the entropy-mining mode.
//!
//! Mining for low-entropy npubs (instead of named vanity prefixes) gives the
//! holder an asymmetric anti-impersonation advantage: an attacker can reproduce
//! the *property* of low entropy, but the residual randomness forces the forged
//! npub to look recognisably different. See `docs/entropy-mining-plan.md`.

/// Maximum Shannon entropy of a single bech32 character: `log₂(32) == 5.0`.
/// The bech32 alphabet has exactly 32 symbols.
pub const BECH32_MAX_ENTROPY: f64 = 5.0;

/// Quality floor for the difficulty metric. Edges with Shannon entropy above
/// this value are "barely below random" and receive zero difficulty — they are
/// not considered patterned. `1.0 = log₂(2)`: only edges using effectively
/// ≤ 2 of the 32 bech32 symbols qualify. This ensures every passing edge is
/// visually recognizable as a genuine vanity pattern.
pub const ENTROPY_FLOOR: f64 = 1.0;

/// Compute the Shannon entropy (in bits per character) of an arbitrary string.
///
/// Uses a fixed stack `[usize; 256]` histogram — no heap allocations — so it is
/// cheap to call inside the hot mining loop. The `log2` pass touches at most 256
/// buckets regardless of input length.
#[inline]
pub fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }

    let mut counts = [0usize; 256];
    let mut len = 0usize;
    for &byte in s.as_bytes() {
        counts[byte as usize] += 1;
        len += 1;
    }

    let n = len as f64;
    let mut entropy = 0.0;
    for &count in counts.iter() {
        if count > 0 {
            let p = count as f64 / n;
            entropy -= p * p.log2();
        }
    }
    entropy
}

/// Compute the Shannon entropy of the **data portion** of a bech32 npub.
///
/// The `npub1` human-readable prefix is constant across every key and therefore
/// contributes zero discriminative entropy while biasing the histogram. We strip
/// it so the result reflects only the visually variable part of the npub — which
/// is exactly what the Zucos-triangle recognisability argument relies on.
///
/// For a 59-character bech32 data portion drawn from the 32-symbol alphabet, the
/// entropy ranges over `[0.0, 5.0]` (`log2(32) == 5.0`).
#[inline]
pub fn npub_entropy(npub_bech32: &str) -> f64 {
    let data = npub_bech32
        .strip_prefix(super::BECH32_PREFIX)
        .unwrap_or(npub_bech32);
    shannon_entropy(data)
}

/// Which side of the npub the best edge was found on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeSide {
    Prefix,
    Suffix,
}

/// The result of resolving the best entropy edge on an npub.
#[derive(Debug, Clone)]
pub struct EdgeResult {
    pub side: EdgeSide,
    pub length: usize,
    pub entropy: f64,
    /// "Bits of pattern": `L × (BECH32_MAX_ENTROPY − H)`.
    /// Directly analogous to rana's leading-zero-bits difficulty.
    pub difficulty: f64,
}

impl EdgeResult {
    fn none() -> Self {
        EdgeResult {
            side: EdgeSide::Prefix,
            length: 0,
            entropy: 0.0,
            difficulty: 0.0,
        }
    }
}

/// Compute the difficulty (bits of pattern) of a string:
/// `length × (BECH32_MAX_ENTROPY − entropy)`, or `0.0` if the entropy exceeds
/// `ENTROPY_FLOOR` (the edge is too random to be considered patterned).
#[inline]
pub fn edge_difficulty(data: &str) -> f64 {
    let h = shannon_entropy(data);
    if h <= ENTROPY_FLOOR {
        data.len() as f64 * (BECH32_MAX_ENTROPY - h)
    } else {
        0.0
    }
}

/// Compute Shannon entropy from a pre-filled histogram.
#[inline]
fn entropy_from_hist(hist: &[usize; 256], len: usize) -> f64 {
    if len == 0 {
        return 0.0;
    }
    let n = len as f64;
    let mut entropy = 0.0;
    for &count in hist.iter() {
        if count > 0 {
            let p = count as f64 / n;
            entropy -= p * p.log2();
        }
    }
    entropy
}

/// Resolve the best entropy edge on an npub — the prefix or suffix window
/// (of any length 1..=29) that maximises difficulty. Edges with entropy
/// above `ENTROPY_FLOOR` receive zero difficulty and are skipped.
///
/// Scans prefix and suffix edges incrementally (one histogram update per step),
/// so the total cost is O(2 × 29 × 32) ≈ O(1,856) character operations per npub.
///
/// Any Nostr client can call this to determine which portion of an npub to
/// display prominently — the npub is self-describing.
pub fn best_edge(npub: &str) -> EdgeResult {
    let data = npub.strip_prefix(super::BECH32_PREFIX).unwrap_or(npub);
    let bytes = data.as_bytes();
    let data_len = bytes.len();
    if data_len == 0 {
        return EdgeResult::none();
    }

    let max_edge = 29.min(data_len);
    let mut best = EdgeResult::none();

    // Scan prefix edges: L = 1, 2, ..., max_edge
    let mut hist = [0usize; 256];
    for l in 1..=max_edge {
        hist[bytes[l - 1] as usize] += 1;
        let h = entropy_from_hist(&hist, l);
        if h > ENTROPY_FLOOR {
            continue;
        }
        let diff = l as f64 * (BECH32_MAX_ENTROPY - h);
        if diff > best.difficulty {
            best = EdgeResult {
                side: EdgeSide::Prefix,
                length: l,
                entropy: h,
                difficulty: diff,
            };
        }
    }

    // Scan suffix edges: L = 1, 2, ..., max_edge
    let mut hist = [0usize; 256];
    for l in 1..=max_edge {
        hist[bytes[data_len - l] as usize] += 1;
        let h = entropy_from_hist(&hist, l);
        if h > ENTROPY_FLOOR {
            continue;
        }
        let diff = l as f64 * (BECH32_MAX_ENTROPY - h);
        if diff > best.difficulty {
            best = EdgeResult {
                side: EdgeSide::Suffix,
                length: l,
                entropy: h,
                difficulty: diff,
            };
        }
    }

    best
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    #[test]
    fn empty_is_zero() {
        assert_eq!(shannon_entropy(""), 0.0);
    }

    #[test]
    fn single_repeated_char_is_zero() {
        assert_eq!(shannon_entropy("aaaa"), 0.0);
    }

    #[test]
    fn two_distinct_chars() {
        // H = -(1/2 log2 1/2)*2 = 1.0
        assert!((shannon_entropy("ab") - 1.0).abs() < EPS);
    }

    #[test]
    fn four_distinct_chars() {
        // H = 2.0
        assert!((shannon_entropy("abcd") - 2.0).abs() < EPS);
    }

    #[test]
    fn bech32_alphabet_caps_at_five() {
        // All 32 distinct bech32 symbols once → log2(32) == 5.0
        assert!((shannon_entropy("qpzry9x8gf2tvdw0s3jn54khce6mua7l") - 5.0).abs() < EPS);
    }

    #[test]
    fn npub_strips_prefix() {
        // Highly repetitive data portion → low entropy regardless of "npub1".
        let h = npub_entropy("npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(h < 1.0, "expected < 1.0, got {h}");
    }

    #[test]
    fn npub_entropy_without_prefix_uses_full_string() {
        // If the prefix is absent we fall back to the whole string.
        assert!((npub_entropy("abcd") - 2.0).abs() < EPS);
    }

    #[test]
    fn bounded_for_any_input() {
        for s in [
            "",
            "a",
            "ab",
            "abc",
            "abcd",
            "qpzry9x8gf2tvdw0s3jn54khce6mua7l",
            "npub1qqqq",
        ] {
            let h = shannon_entropy(s);
            assert!((0.0..=5.0 + EPS).contains(&h), "{s:?} → {h} out of [0, 5]");
        }
    }

    #[test]
    fn repetition_lowers_entropy() {
        assert!(shannon_entropy("aab") < shannon_entropy("abc"));
        assert!(shannon_entropy("aaab") < shannon_entropy("aabc"));
    }

    #[test]
    fn symmetric_in_arg_order() {
        assert!((shannon_entropy("abba") - shannon_entropy("baab")).abs() < EPS);
    }

    // --- edge_difficulty tests ---

    #[test]
    fn edge_difficulty_monochrome() {
        // "aaaa": entropy 0.0 → 4 × (5 − 0) = 20.0
        assert!((edge_difficulty("aaaa") - 20.0).abs() < EPS);
    }

    #[test]
    fn edge_difficulty_diverse() {
        // "abcd": entropy 2.0 > ENTROPY_FLOOR (1.0) → zeroed
        assert_eq!(edge_difficulty("abcd"), 0.0);
    }

    #[test]
    fn edge_difficulty_empty_is_zero() {
        assert_eq!(edge_difficulty(""), 0.0);
    }

    #[test]
    fn edge_difficulty_grows_with_repetition() {
        assert!(edge_difficulty("aaab") > edge_difficulty("abcd"));
        assert!(edge_difficulty("aaaa") > edge_difficulty("aaab"));
    }

    // --- best_edge tests ---

    #[test]
    fn best_edge_empty() {
        let result = best_edge("");
        assert_eq!(result.difficulty, 0.0);
    }

    #[test]
    fn best_edge_repetitive_prefix_wins() {
        let npub = "npub1aaaaaaaaaaaaaaaaaaaax7m2kp9qfl5d3wrt8hnqzy0vce4plm";
        let result = best_edge(npub);
        assert_eq!(result.side, EdgeSide::Prefix);
        assert!(
            result.difficulty > 50.0,
            "expected > 50, got {}",
            result.difficulty
        );
    }

    #[test]
    fn best_edge_repetitive_suffix_wins() {
        let npub = "npub1x7m2kp9qfl5d3wrt8hnqzy0vce4plmqqqqqqqqqqqqqqqqqqqq";
        let result = best_edge(npub);
        assert_eq!(result.side, EdgeSide::Suffix);
        assert!(
            result.difficulty > 50.0,
            "expected > 50, got {}",
            result.difficulty
        );
    }

    #[test]
    fn best_edge_random_is_low_difficulty() {
        let npub = "npub1x7m2kp9qfl5d3wrt8hnqzy0vce4plm3k9j5w7f2g6h8d4s1n";
        let result = best_edge(npub);
        assert!(
            result.difficulty < 25.0,
            "expected < 25 for random npub, got {}",
            result.difficulty
        );
    }

    #[test]
    fn best_edge_longer_repetition_scores_higher() {
        let short = best_edge("npub1aaaaax7m2kp9qfl5d3wrt8hnqzy");
        let long = best_edge("npub1aaaaaaaaaaaaaaaaaaaax7m2kp9qfl5d3wrt8hnqzy");
        assert!(long.difficulty > short.difficulty);
    }

    #[test]
    fn best_edge_returns_valid_result() {
        let npub = "npub1aaaaaaaaaaaaaaaaaaaax7m2kp9qfl5d3wrt8hnqzy0vce4plm";
        let result = best_edge(npub);
        assert!(result.length > 0);
        assert!(result.length <= 29);
        assert!(result.entropy >= 0.0 && result.entropy <= ENTROPY_FLOOR + EPS);
        assert!(result.difficulty >= 0.0);
    }

    // --- ENTROPY_FLOOR tests ---

    #[test]
    fn edge_difficulty_above_floor_is_zero() {
        // 16 distinct bech32 chars → H = log2(16) = 4.0 > ENTROPY_FLOOR (1.0)
        let diverse = "qpzry9x8gf2tvdw0";
        assert!(shannon_entropy(diverse) > ENTROPY_FLOOR);
        assert_eq!(edge_difficulty(diverse), 0.0);
    }

    #[test]
    fn edge_difficulty_at_floor_boundary() {
        // Exactly 2 distinct chars → H = log2(2) = 1.0 = ENTROPY_FLOOR
        // Should still get credit (H <= floor, inclusive)
        let two = "qpqpqpqp";
        let h = shannon_entropy(two);
        assert!((h - 1.0).abs() < EPS);
        assert!(edge_difficulty(two) > 0.0);
    }

    #[test]
    fn best_edge_skips_above_floor_edges() {
        // The best edge should never have entropy above the floor
        let npub = "npub1x7m2kp9qfl5d3wrt8hnqzy0vce4plm3k9j5w7f2g6h8d4s1n";
        let result = best_edge(npub);
        assert!(
            result.entropy <= ENTROPY_FLOOR + EPS,
            "best edge entropy {} exceeds floor {}",
            result.entropy,
            ENTROPY_FLOOR
        );
    }

    #[test]
    fn floor_prevents_long_mediocre_edge_from_winning() {
        // A long edge with H > 3.0 would score high without the floor,
        // but should be zeroed out. Verify the resolver doesn't pick it.
        // "qpzry9x8gf2tvdw0s3jn" = 20 distinct bech32 chars, H ≈ 4.1
        // followed by repetitive 'a's as suffix.
        let npub = "npub1qpzry9x8gf2tvdw0s3jnaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let result = best_edge(npub);
        // The diverse prefix (H > floor) should be zeroed.
        // Best edge must be the repetitive suffix, not the diverse prefix.
        assert_eq!(
            result.side,
            EdgeSide::Suffix,
            "diverse prefix should have been zeroed by floor"
        );
        assert!(
            result.entropy < 1.0,
            "expected low-entropy suffix edge, got entropy {}",
            result.entropy
        );
    }
}

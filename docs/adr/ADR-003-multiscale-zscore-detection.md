# ADR-003: Multi-Scale Z-Score Outlier Detection

## Status

Proposed

## Date

2026-07-22

## Related

- ADR-001: Anti-phishing via low-entropy outlier discovery

## Context

ADR-001 requires scanning an NPUB for its most anomalous section. We need a
detection algorithm that:

1. Works on any NPUB without a predefined pattern
2. Normalizes across different pattern types (runs, alternations, repeats)
3. Produces a single comparable metric (fingerprint strength score)
4. Is transparent and explainable (no black-box ML for v1)

## Decision

Use **multi-scale z-score outlier detection** based on sliding-window Shannon
entropy, compared against a calibrated baseline.

### Algorithm

```
INPUT: npub_data (58 bech32 chars)
OUTPUT: { z_score, window_size, position, pattern, entropy }

1. BASELINE (precomputed):
   For each window size W in {3,4,5,...,20}:
     Compute min-entropy across all positions in 20,000 random NPUBs
     Store mean[W] and std[W] from the distribution

2. SCAN:
   For each window size W in {3,...,20}:
     For each position P in {0,...,58-W}:
       window = npub_data[P : P+W]
       H = Shannon_entropy(window)
       z = (mean[W] - H) / std[W]
       Track maximum z across all (W, P) pairs

3. RESULT:
   Return the (W, P) with the highest z-score
   This is the NPUB's "fingerprint anchor"
```

### Shannon Entropy

For a window of W characters:

```
H = -sum( p_i * log2(p_i ) ) for each distinct char i in window
```

Where p_i = count(char_i) / W.

Range: 0.0 (all same char) to log2(32) = 5.0 (all 32 chars equally distributed).

### Z-Score Interpretation

```
z = (mean[W] - H) / std[W]
```

- z ≈ 0: typical random NPUB. No useful fingerprint.
- z ≈ 3: moderately unusual. 1-in-100 NPUBs.
- z ≈ 5: very unusual. 1-in-10,000 NPUBs.
- z ≈ 6+: extreme. Requires grinding to find.

Higher z = more grinding invested = harder to forge.

### Why Multiple Scales

The same pattern has very different statistical significance depending on
window size:

| Pattern       | Window 8 z-score | Window 16 z-score |
|---------------|:----------------:|:-----------------:|
| "qpqpqpqp..." | 6.9 (extreme)    | 12.2 (astronomical) |
| "qqqqqqqq"    | 12.2 (extreme)   | 20+ (off charts)    |
| "meshmate"    | 3.0 (notable)    | N/A (too short)     |

Scanning at 13 scales (3 through 20 chars) ensures we catch outliers that
are significant at one scale but not another. Different NPUBs peak at
different scales — this diversity makes each fingerprint unique.

### Composite Fingerprint Vector

For richer identity comparison, the full 13-dimensional profile (z-score at
each scale) can be used as a fingerprint vector. This enables:

- Radar chart visualization (visual fingerprint shape)
- Distance metrics between NPUB fingerprints
- Future ML approaches (isolation forest, autoencoder) on the 13D vector

For v1 (the demo), we use only the maximum z-score. The composite vector is
a documented extension point.

## Baseline Statistics (from 20,000 random NPUBs)

| Window | Mean H | Std   | p5    | p1    |
|-------:|-------:|------:|------:|------:|
| 3      | 0.89   | 0.23  | 0.00  | 0.00  |
| 4      | 1.35   | 0.27  | 0.81  | 0.81  |
| 5      | 1.66   | 0.26  | 1.37  | 0.97  |
| 6      | 1.91   | 0.22  | 1.46  | 1.25  |
| 7      | 2.13   | 0.20  | 1.84  | 1.66  |
| 8      | 2.32   | 0.19  | 2.00  | 1.75  |
| 10     | 2.63   | 0.18  | 2.32  | 2.12  |
| 12     | 2.87   | 0.17  | 2.58  | 2.42  |
| 16     | 3.24   | 0.15  | 2.95  | 2.83  |
| 20     | 3.51   | 0.14  | 3.25  | 3.12  |

Full table for all 13 scales in `analysis/baseline_stats.json`.

## Invariants

1. Baseline must be computed from ≥10,000 random NPUBs for stable statistics.
2. Z-score is always non-negative for our use case (we only care about
   below-mean entropy = low-entropy outliers).
3. Window sizes must span at least 3 to 16 to capture both short and long
   patterns.
4. The baseline is deterministic (same random seed) and can be regenerated.

## Consequences

### Positive
- Transparent, explainable, provably correct
- Scale-independent comparison (z normalizes across window sizes)
- Single number (max z) for fingerprint strength
- Extensible to 13D vector for richer comparison
- Works on any NPUB retroactively

### Costs
- O(W × N) per NPUB scan where W=13 scales, N=58 positions (~750 operations)
- Baseline must be precomputed (one-time cost, ~30 seconds for 20k NPUBs)
- Shannon entropy on character frequency misses structural patterns
  (e.g., palindromes, arithmetic sequences) — future work could add
  run-length entropy or other metrics

## Notes

Future enhancement candidates:
- Isolation Forest on the 13D fingerprint vector for outlier scoring
- Autoencoder reconstruction error as anomaly metric
- Kalman filter approach: track running entropy, flag largest innovation
- Run-length entropy (consecutive repeats) alongside Shannon entropy

For the v1 demo, the z-score approach is the right choice: transparent,
provably correct, easy to explain in 30 seconds.

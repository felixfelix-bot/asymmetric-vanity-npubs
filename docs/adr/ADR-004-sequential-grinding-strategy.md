# ADR-004: Sequential Grinding Strategy

## Status

Proposed

## Date

2026-07-22

## Related

- ADR-001: Anti-phishing via low-entropy outlier discovery
- ADR-002: Split zones — disjoint charsets

## Context

ADR-002 requires the NPUB to contain both a vanity section (e.g., "meshmate")
and an anti-phish outlier section. The naive approach would grind for both
constraints simultaneously, but this is exponentially expensive.

Simultaneous grinding cost for "meshmate" prefix + 3-char complement anti-phish
section (14 chars): ~2^68 tries. At 100k keys/sec, that's centuries.

## Decision

Use **sequential grinding**: grind for the vanity prefix first, then discover
the anti-phish outlier among the candidates for free.

### Strategy

```
Step 1: Grind for vanity prefix
  - Generate secp256k1 keypairs
  - Compute NPUB (bech32-encoded public key)
  - Check if target position contains vanity word
  - Collect ALL matching keypairs into candidate pool
  - Cost: ~2^37 for "meshmate" at any of ~15 positions

Step 2: Scan candidates for outliers (ZERO extra key generation)
  - For each candidate NPUB, run the multi-scale z-score scanner (ADR-003)
  - Optionally filter: outlier section must use complement charset (ADR-002)
  - Pick the candidate with the highest z-score
  - Cost: O(candidates × 750) comparison operations (negligible)

Step 3: Done
  - The selected NPUB has:
      vanity = "meshmate" (readable)
    + outlier = strongest natural anomaly (unforgeable)
    + visual contrast (different palettes for each zone)
```

### Why This Works

Every NPUB already has SOME outlier. The question is how strong.

From our baseline data, among 2^37 ≈ 137 billion candidate keys (the pool
from meshmate grinding), the best outlier will have z ≈ 6-7. This is
extreme/forgery-resistant territory.

The outlier is a FREE byproduct of the large candidate pool. We are not
constraining the key generation to produce specific patterns — we are simply
selecting the best anomaly among many naturally-occurring ones.

### Key Insight: Asymmetry Maximization

The sequential strategy maximizes asymmetry by MINIMIZING constraints on the
anti-phish section:

- Alice accepts ANY low-entropy outlier (millions of valid patterns)
- Attacker must replicate ONE specific outlier (exact chars, position, scale)
- Asymmetry = valid_patterns_for_alice / 1 = MAXIMIZED

Every constraint we remove from Alice's search:
1. Increases valid patterns she accepts
2. Decreases her grinding cost
3. Does NOT decrease attacker's replication cost
4. Therefore INCREASES the asymmetry ratio

### Optional: Complement Charset Filter

After finding the best outlier among candidates, optionally verify that the
outlier section uses complement charset chars (per ADR-002). If not, either:

a) Accept it anyway (visual contrast is still good — just not disjoint palettes)
b) Pick the next-best outlier that uses complement chars
c) Expand the candidate pool slightly

P(natural outlier uses complement chars) ≈ 80%+ given that complement has
26 of 32 chars. So option (b) almost always succeeds within the existing pool.

## Grinding Performance Estimates

| Vanity word | Distinct chars | Prefix cost | At 100k keys/sec | At 1M keys/sec (GPU) |
|-------------|:--------------:|:-----------:|:----------------:|:--------------------:|
| "meshmate"  | 6              | ~2^37       | ~12 days         | ~1.3 days            |
| "mesh"      | 4              | ~2^19       | ~5 seconds       | <1 second            |
| "sat"       | 3              | ~2^15       | <1 second        | <1 second            |
| "cashu"     | 5              | ~2^24       | ~5 hours         | ~17 minutes          |

Note: Costs assume trying ~15 positions for the vanity word. Compiled
secp256k1 key generation on modern hardware can achieve 1M+ keys/sec.

## Invariants

1. Vanity grind always happens first. Outlier scan is always free.
2. The candidate pool must be large enough to contain a strong outlier
   (rule of thumb: pool size > 1000 guarantees z > 4).
3. No additional key generation is needed for outlier discovery.
4. The selected keypair is a valid, functional Nostr identity (standard
   secp256k1 — no custom cryptography).

## Consequences

### Positive
- Practical: hours to days on consumer hardware, not centuries
- The outlier is discovered, not engineered — maximizes asymmetry
- Works with standard Nostr tooling (no custom key format)
- Candidate pool can be reused across different vanity words

### Costs
- Vanity prefix must be found before outlier selection (sequential, not parallel)
- Larger candidate pools need storage (but only pubkey hashes, not full keys)
- Grinding time is dominated by vanity prefix length (exponential in word length)
- For 8-char vanity words, GPU or multi-machine grinding may be needed

## Notes

The sequential strategy is a direct consequence of ADR-001 (discovered outliers)
and ADR-002 (independent zones). Because the outlier is discovered rather than
constrained, it costs nothing to find among a large pool of candidates.

Future optimization: streaming grinder that generates keys, checks vanity,
computes z-score in a single pass, and keeps only the best candidate. Memory
usage is O(1) — just track the best keypair seen so far.

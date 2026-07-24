# Asymmetric Vanity NPUBs

Solving Zooko's Triangle for Nostr identities through proof-of-work anti-phishing
fingerprints and vanity name grinding.

## The Problem

Zooko's Triangle states you cannot simultaneously have all three:

1. **Human-readable** — names like "meshmate" that people can remember
2. **Secure** — resistant to impersonation and phishing
3. **Decentralized** — no central authority controls name assignment

Current Nostr identity solutions:

| Approach | Readable | Secure | Decentralized |
|----------|:--------:|:------:|:-------------:|
| Raw NPUBs | ❌ | ✅ | ✅ |
| NIP-05 handles | ✅ | ✅ | ❌ (server required) |
| Pure vanity NPUBs | ⚠️ | ❌ | ✅ (but no anti-phishing) |

Pure vanity NPUBs (`npub1meshmate...`) have zero anti-phishing asymmetry: finding
the same vanity prefix costs an attacker exactly the same as it cost the original
owner.

## Our Approach

Two-zone NPUB fingerprinting:

```
npub1[meshmate]....[qpqpqpqpqp]....
      ^^^^^^^^^^      ^^^^^^^^^^^^^^
      VANITY ZONE     ANTI-PHISH ZONE
      (green palette) (orange palette)
      Human-readable  Computationally unforgeable
```

**Vanity zone**: Grind for a human-readable name (e.g., "meshmate").
Cost: ~2^37 keys on a laptop.

**Anti-phish zone**: The NPUB's most statistically anomalous section (fewest
unique characters across multiple window sizes). This is discovered, not
constructed — among billions of vanity-matching candidates, we pick the one
with the strongest natural outlier. Cost: free.

**Visual contrast**: Vanity and anti-phish zones use disjoint character sets,
producing completely different color palettes. The name POPS. An attacker's
different fingerprint is instantly visible.

## Architecture Decisions

- [ADR-001: Anti-Phishing via Low-Entropy Outlier Discovery](docs/adr/ADR-001-anti-phishing-via-entropy-outliers.md)
- [ADR-002: Split Zones — Disjoint Charsets](docs/adr/ADR-002-split-zones-disjoint-charsets.md)
- [ADR-003: Multi-Scale Z-Score Outlier Detection](docs/adr/ADR-003-multiscale-zscore-detection.md) *(superseded by ADR-009)*
- [ADR-004: Sequential Grinding Strategy](docs/adr/ADR-004-sequential-grinding-strategy.md)
- [ADR-005: Wrapped 2D Fingerprint Card Rendering](docs/adr/ADR-005-wrapped-2d-fingerprint-card.md)
- [ADR-006: Offset Grinding — VNAAS Without Key Custody](docs/adr/ADR-006-offset-grinding-vnaas.md)
- [ADR-008: Atomic Sale of Grinding Offsets](docs/adr/ADR-008-atomic-offset-sale.md)
- [ADR-007: Tooling Strategy — Fork Rana for Offset Grinding](docs/adr/ADR-007-tooling-strategy-fork-rana.md)
- [ADR-009: Unique Char Count as Primary Metric](docs/adr/ADR-009-unique-char-metric.md)

## Repository Structure

```
asymmetric-vanity-npubs/
├── README.md
├── docs/
│   └── adr/                    # Architecture Decision Records
│       ├── ADR-001-*.md
│       ├── ADR-002-*.md
│       ├── ADR-003-*.md
│       └── ADR-004-*.md
├── analysis/                   # Python analysis scripts and data
│   ├── entropy_baseline.py     # Baseline distribution computation
│   ├── outlier_scanner.py      # Multi-scale unique char count scanner
│   └── asymmetry_analysis.py   # Cost/asymmetry calculations
├── viz/                        # HTML visualizations
│   ├── npub-viz.html           # Color grid + heatmap approaches
│   ├── npub-outlier-viz.html   # Outlier discovery demo
│   └── npub-split-viz.html     # Split-zone visual comparison
└── demo/                       # 5-minute demo materials
```

## Key Numbers

| Metric | Value |
|--------|-------|
| Bech32 charset size | 32 chars |
| NPUB data length | 58 chars |
| Baseline samples | 20,000 random NPUBs |
| Window sizes scanned | 13 (3 through 20) |
| Expected unique chars (W=16) | ~10.3 (occupancy problem) |
| "meshmate" distinct chars | 6 ({m,e,s,h,a,t}) |
| Vanity grind cost (meshmate) | ~2^37 keys |
| Outlier discovery cost | Free (among vanity candidates) |
| Attacker exact-match cost | >>2^60 |
| Asymmetry ratio | >1,000,000:1 |
| Rarity metric | `expectedUnique - uniqueChars` (higher = rarer) |

## Roadmap

**Pattern Recognizer (Future Work):** Unique char count detects low-diversity
windows but misses structured patterns. A planned secondary detection layer
would identify:

- **Max frequency** — single most common character's share of the window
- **Repeated substrings** — e.g., "deadbeefdeadbeef" has 8 unique chars but
  is highly recognizable due to repetition
- **Visual pattern matching** — sequential runs, palindromes, and other
  structural regularities

This would complement unique char count as a second score, not replace it.

## License

MIT

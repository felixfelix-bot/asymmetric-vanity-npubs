# ADR-001: Anti-Phishing via Low-Entropy Outlier Discovery

## Status

Proposed

## Date

2026-07-22

## Context

Pure vanity NPUBs (e.g., `npub1meshmate...`) provide zero anti-phishing asymmetry.
Finding "meshmate" as an 8-char prefix costs the attacker exactly the same
~2^40 tries as it cost Alice. There is no moat — anyone can grind the same name.

This leaves Nostr identities vulnerable to impersonation attacks: an attacker
generates a keypair with the same vanity prefix and presents it as Alice. Without
side-channel verification (NIP-05, manual npub comparison), the user cannot
distinguish the attacker from the real identity.

Current approaches to Zooko's Triangle in the Nostr ecosystem:

| Approach          | Human-readable | Secure | Decentralized |
|-------------------|:-:|:-:|:-:|
| Raw NPUBs         | No  | Yes | Yes |
| NIP-05 handles    | Yes | Yes | No (requires server) |
| Pure vanity NPUBs | Partial | Yes | Yes (but no anti-phishing) |

We need an approach that is human-recognizable, secure against phishing, and
fully decentralized — no registry, no authority.

## Decision

Use **low-entropy outlier sections** in the NPUB as anti-phishing visual
fingerprints. The NPUB is scanned for sections that are statistically anomalous
(low Shannon entropy compared to random NPUB baseline). The most anomalous
section becomes the "fingerprint anchor."

Key properties:

1. **Asymmetry**: Finding ANY low-entropy NPUB is cheap (Alice accepts millions
   of valid patterns). Replicating a SPECIFIC low-entropy pattern is orders of
   magnitude harder (attacker needs exact match).

2. **Proof-of-Work**: The statistical surprise (z-score) of the outlier IS the
   proof-of-work receipt. Higher z = more grinding = harder to forge.

3. **Decentralized**: No registry. No authority. Pure computation.

4. **Human-recognizable**: Low-entropy sections produce simple visual patterns
   (repeated colors, recognizable shapes) that a human can verify by eye.

## Quantitative Basis

Baseline computed from 20,000 random NPUBs. Outlier z-score distribution:

| Grinding budget | Best z-score found | Strength          |
|----------------:|-------------------:|-------------------|
| 10              | ~2.0               | weak              |
| 100             | ~3.9               | moderate          |
| 1,000           | ~5.0               | strong            |
| 10,000          | ~6.3               | extreme           |
| 100,000         | ~7.5               | forgery-resistant  |

Attacker cost to replicate a specific z=6.3 outlier pattern: astronomically
higher than Alice's cost to find any z=6.3 outlier.

## Invariants

1. Every NPUB has SOME outlier (minimum z ≈ 0.5). The question is how strong.
2. Higher z-score always means harder to forge.
3. The outlier is discovered, not constructed — Alice accepts any valid anomaly.
4. No central registry or authority is involved at any point.

## Consequences

### Positive
- Adds anti-phishing layer to Nostr identity with zero infrastructure
- Scales with available computation (more grinding = stronger fingerprint)
- Works on existing NPUBs (can scan current keys retroactively)
- Composable with vanity names (see ADR-002)

### Costs
- Does not provide name exclusivity (multiple valid "meshmate" NPUBs can coexist)
- Requires client-side scanner to compute and display the fingerprint
- User education needed: "learn to recognize your contact's visual fingerprint"
- Not a replacement for cryptographic verification — it's a visual anti-phishing layer

## Notes

This decision addresses the "Secure" and "Decentralized" corners of Zooko's
Triangle. Human-readability is addressed separately by the vanity component
(see ADR-002). The two are designed to compose without interference.

# ADR-002: Split Zones — Disjoint Charsets for Vanity and Anti-Phish

## Status

Proposed

## Date

2026-07-22

## Related

- ADR-001: Anti-phishing via low-entropy outlier discovery

## Context

ADR-001 establishes low-entropy outliers as anti-phishing fingerprints. We
also want human-readable vanity names (e.g., "meshmate") in the NPUB.

Two approaches were considered:

**Combined approach**: The vanity section and the anti-phish section use the
SAME charset. If "meshmate" uses chars {m,e,s,h,a,t}, the entire low-entropy
window uses only those 6 chars.

Problem: meshmate's characters blend into the surrounding low-entropy section.
All characters are from the same palette — there is no visual contrast. The
vanity name becomes invisible within its own fingerprint.

**Split approach**: The vanity section and the anti-phish section use DISJOINT
charsets. The vanity uses {m,e,s,h,a,t}. The anti-phish section uses ONLY
characters from the complement set — the other 26 bech32 chars.

## Decision

Use the **split approach**: vanity zone and anti-phish zone use completely
disjoint character sets.

```
npub1[vanity: meshmate chars only][random][anti-phish: complement chars only][random]
      ^^^^^^^^^^^^^^^^^^^^^^^^^^^         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      GREEN palette                       ORANGE palette
      {m,e,s,h,a,t}                       {q,p,z,r,y,9,x,8,g,f,2,t,v,d,w,0,...}
```

### Rules

1. **Vanity zone**: Constrained to the vanity word's charset. Positioned where
   the browser/client can extract the name.
2. **Anti-phish zone**: Constrained to the complement charset (all chars NOT
   in the vanity word). Positioned elsewhere in the NPUB.
3. **Visual rendering**: Client renders the two zones with visually distinct
   palettes so the boundary is obvious.

### Why This Is Better Than Combined

The split approach wins on three independent axes:

**1. Visual contrast (free)**: Disjoint charsets produce different color
palettes. Meshmate in green/orange/pink sits next to anti-phish in red/teal/blue.
The name POPS. Attacker's different pattern is instantly visible.

**2. Higher asymmetry**: Anti-phish constraints are orthogonal to vanity
constraints. Minimizing constraints on the anti-phish section (accept ANY
low-entropy pattern using complement chars) maximizes the number of valid
fingerprints Alice can find. Each valid pattern is one more unit of asymmetry
against the attacker who must match a specific one.

**3. Lower grinding cost**: The outlier is discovered, not constrained. Alice
only grinds for the vanity prefix. Among vanity-matching keys, she picks the
one with the strongest natural outlier. The outlier costs zero extra computation.

## Quantitative Basis

For "meshmate" (6 distinct bech32 chars):

| Approach  | Alice cost | Attacker cost | Asymmetry   | Visual contrast |
|-----------|-----------|---------------|-------------|:---------------:|
| Combined  | ~2^14     | ~2^39         | ~906,000:1  | Poor (same palette) |
| Split     | ~2^37*    | >>2^60        | >>1,000,000:1 | Excellent (disjoint palettes) |

*Split cost is vanity grind only. Outlier discovery among vanity keys is free.

## Invariants

1. Vanity zone chars and anti-phish zone chars are ALWAYS from disjoint sets.
2. The anti-phish zone must not overlap positionally with the vanity zone.
3. The client must render the two zones with visually distinct treatments.
4. The complement set is derived from: `all_bech32_chars - vanity_word_chars`.

## Consequences

### Positive
- Visual contrast makes vanity names readable AND anti-phish fingerprints obvious
- Orthogonal constraints maximize asymmetry
- Grinding cost is just the vanity prefix (outlier is free among candidates)
- Attacker cannot infer anti-phish pattern from vanity name (disjoint sets)

### Costs
- Vanity word is limited to bech32-valid chars (no b, i, o, or digit 1)
- Two-zone rendering requires client awareness (not just prefix matching)
- Complement charset is smaller (26 chars), slightly reducing pattern diversity

## Notes

Bech32 charset: `qpzry9x8gf2tvdw0s3jn54khce6mua7l` (32 chars)
Missing letters: b, i, o. Missing digit: 1.
Vanity words must be spellable from the remaining 29 letters + 9 digits.

Common valid vanity words: meshmate, cashu, sat, mesh, satstralia, anon,
vanity, npub, nostr, zaps, rebel, sats, defi.
